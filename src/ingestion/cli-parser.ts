import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveModel, calculateCost } from '../core/pricing';

/**
 * Per-session, per-model usage aggregated from a GitHub Copilot **CLI** session.
 *
 * The CLI writes one append-log `events.jsonl` per session under
 * `~/.copilot/session-state/<sessionId>/`. Usage is reported in `session.shutdown`
 * events as `data.modelMetrics[<model>].usage`. Those payloads are **incremental
 * per resume-cycle** (a session can resume/shutdown several times), so a session's
 * total is the sum across every `session.shutdown` event in the file.
 *
 * Unlike Copilot Chat, the CLI records no credit/USD value — cost is always priced
 * from tokens via the shared pricing table. Aggregated per session+model and
 * upserted by a stable `externalId` (`copilot-cli-<sessionId>-<model>`).
 */
export interface CliSessionUsage {
  sessionId: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  timestamp: string;
  externalId: string;
  repo?: string;
}

export interface CliSessionFile {
  file: string;
  sessionId: string;
  mtimeMs: number;
}

/** Root of the GitHub Copilot CLI's local data (`~/.copilot`). */
export function getCopilotCliDir(): string {
  const override = process.env['TOKENYST_COPILOT_CLI_DIR'];
  if (override) return override;
  return path.join(os.homedir(), '.copilot');
}

function getSessionStateDir(): string {
  return path.join(getCopilotCliDir(), 'session-state');
}

/** Locate every Copilot CLI session's `events.jsonl`. */
export function findCliSessionFiles(): CliSessionFile[] {
  const root = getSessionStateDir();
  if (!fs.existsSync(root)) return [];

  const out: CliSessionFile[] = [];
  for (const sessionId of fs.readdirSync(root)) {
    const file = path.join(root, sessionId, 'events.jsonl');
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue; // no events log in this session dir
    }
    out.push({ file, sessionId, mtimeMs });
  }
  return out;
}

type AnyObj = Record<string, unknown>;

function isObj(v: unknown): v is AnyObj {
  return !!v && typeof v === 'object';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Read an append-log JSONL file as one parsed value per non-empty line. */
function readJsonl(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Best-effort working repo name for a CLI session, from its metadata sidecars. */
function readRepo(sessionId: string): string | undefined {
  const dir = path.join(getSessionStateDir(), sessionId);
  // VS Code-launched sessions: workspaceFolder.folderPath in vscode.metadata.json.
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(dir, 'vscode.metadata.json'), 'utf8'),
    ) as { workspaceFolder?: { folderPath?: string } };
    const folder = meta.workspaceFolder?.folderPath;
    if (folder) {
      const base = folder.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
      if (base) return base;
    }
  } catch {
    /* fall through to workspace.yaml */
  }
  // Pure-CLI sessions: `repository: owner/name` (or `git_root:`) in workspace.yaml.
  try {
    const yaml = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
    const repo = yaml.match(/^repository:\s*(.+)$/m)?.[1]?.trim();
    if (repo) return repo.split('/').pop() || repo;
    const gitRoot = yaml.match(/^git_root:\s*(.+)$/m)?.[1]?.trim();
    if (gitRoot) return gitRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  } catch {
    /* no metadata */
  }
  return undefined;
}

interface ModelAcc {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/**
 * Aggregate one Copilot CLI session file into per-model usage. Sums the
 * `modelMetrics` usage from every `session.shutdown` event (incremental
 * per-resume), then prices each model from its token totals. Returns one record
 * per model used in the session.
 */
export function parseCliSession(file: string, sessionId: string): CliSessionUsage[] {
  if (!fs.existsSync(file)) return [];

  const perModel = new Map<string, ModelAcc>();
  const times: number[] = [];

  for (const event of readJsonl(file)) {
    if (!isObj(event)) continue;
    const ts = event['timestamp'];
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms)) times.push(ms);
    }
    if (event['type'] !== 'session.shutdown') continue;

    const data = isObj(event['data']) ? (event['data'] as AnyObj) : undefined;
    const metrics = isObj(data?.['modelMetrics']) ? (data!['modelMetrics'] as AnyObj) : undefined;
    if (!metrics) continue;

    for (const [rawModel, entry] of Object.entries(metrics)) {
      const usage = isObj(entry) && isObj((entry as AnyObj)['usage'])
        ? ((entry as AnyObj)['usage'] as AnyObj)
        : undefined;
      if (!usage) continue;
      // Group by resolved model id so the same model logged in different forms
      // collapses to one bucket (and one externalId), matching the Chat parser.
      const model = resolveModel(rawModel).id;
      const acc = perModel.get(model)
        ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      acc.input += num(usage['inputTokens']);
      acc.output += num(usage['outputTokens']);
      acc.cacheRead += num(usage['cacheReadTokens']);
      acc.cacheWrite += num(usage['cacheWriteTokens']);
      acc.reasoning += num(usage['reasoningTokens']);
      perModel.set(model, acc);
    }
  }

  if (perModel.size === 0) return [];

  const timestamp = times.length > 0 ? new Date(Math.max(...times)).toISOString() : new Date().toISOString();
  const repo = readRepo(sessionId);

  const result: CliSessionUsage[] = [];
  for (const [model, acc] of perModel) {
    // `inputTokens` is the full prompt and is inclusive of the cached tokens (a
    // single request's inputTokens ≈ the whole context window, with cacheRead a
    // subset of it). So only the fresh remainder is billed at the input rate; the
    // cached portions are billed via the cache-write/read multipliers. Reasoning
    // tokens are billed at the output rate. This mirrors chat-parser's fresh/cached
    // split and avoids double-counting cached input.
    const fresh = Math.max(0, acc.input - acc.cacheRead - acc.cacheWrite);
    const cost = calculateCost(
      model,
      fresh,
      acc.output + acc.reasoning,
      acc.cacheWrite,
      acc.cacheRead,
    ) ?? 0;
    if (cost <= 0) continue;
    result.push({
      sessionId,
      model,
      costUsd: cost,
      inputTokens: acc.input, // full prompt total, retained for transparency
      outputTokens: acc.output + acc.reasoning,
      cacheCreationTokens: acc.cacheWrite,
      cacheReadTokens: acc.cacheRead,
      timestamp,
      externalId: `copilot-cli-${sessionId}-${model}`,
      repo,
    });
  }
  return result;
}
