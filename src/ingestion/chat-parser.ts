import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveModel, calculateCost, CREDITS_PER_USD } from '../core/pricing';

/**
 * Per-session, per-model usage aggregated from a VS Code Copilot Chat session.
 *
 * `costUsd` is authoritative: where GitHub recorded a real credit value for a
 * request (in `details`, e.g. "… • 12.3 credits"), that value is used directly
 * (credits ÷ CREDITS_PER_USD); otherwise the request is priced from its tokens.
 * Token fields are retained for transparency. Aggregated per session+model and
 * upserted by a stable `externalId` (`copilot-chat-<sessionId>-<model>`).
 */
export interface CopilotSessionUsage {
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

export interface ChatSessionFile {
  file: string;
  sessionId: string;
  workspaceHash: string;
  mtimeMs: number;
}

/**
 * The running VS Code build's `User` directory, injected at activation from
 * `context.globalStorageUri`. Makes the extension build-aware (Stable vs Insiders
 * vs portable/OSS) without hardcoding folder names. See `setVSCodeUserDir`.
 */
let injectedUserDir: string | undefined;

/** Set the `User` directory derived from the host's `globalStorageUri`. */
export function setVSCodeUserDir(dir: string | undefined): void {
  injectedUserDir = dir;
}

/** VS Code's `User` directory, where `workspaceStorage/` lives. */
export function getVSCodeUserDir(): string {
  const override = process.env['TOKENYST_VSCODE_USER_DIR'];
  if (override) return override;
  if (injectedUserDir) return injectedUserDir;
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User');
}

function getWorkspaceStorageDir(): string {
  return path.join(getVSCodeUserDir(), 'workspaceStorage');
}

export function findChatSessionFiles(): ChatSessionFile[] {
  const root = getWorkspaceStorageDir();
  if (!fs.existsSync(root)) return [];

  const out: ChatSessionFile[] = [];
  for (const hash of fs.readdirSync(root)) {
    const csDir = path.join(root, hash, 'chatSessions');
    let entries: string[];
    try {
      entries = fs.readdirSync(csDir);
    } catch {
      continue; // no chatSessions in this workspace
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json') && !entry.endsWith('.jsonl')) continue;
      const file = path.join(csDir, entry);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      out.push({ file, sessionId: entry.replace(/\.jsonl?$/, ''), workspaceHash: hash, mtimeMs });
    }
  }
  return out;
}

/** Parse the model name out of a `details` display string like "GPT-4.1 • 0x". */
function modelFromDetails(details: string): string {
  return details.split('•')[0].trim();
}

interface UsageRecord {
  responseId: string;
  model: string;
  /** Non-cacheable input (User Context: messages, files, tool results). */
  freshInputTokens: number;
  /** Stable System portion (System Instructions + Tool Definitions), cacheable across the session. */
  cacheableTokens: number;
  outputTokens: number;
}

/**
 * Fraction (0–100) of a request's prompt made up of the stable `System` category
 * (System Instructions + Tool Definitions). That block is byte-identical on every
 * request in a session, so it is served from cache after the first request.
 */
function systemPercent(details: unknown): number {
  if (!Array.isArray(details)) return 0;
  let pct = 0;
  for (const d of details) {
    if (isObj(d) && d['category'] === 'System' && typeof d['percentageOfPrompt'] === 'number') {
      pct += d['percentageOfPrompt'] as number;
    }
  }
  return Math.min(Math.max(pct, 0), 100);
}

type AnyObj = Record<string, unknown>;

function isObj(v: unknown): v is AnyObj {
  return !!v && typeof v === 'object';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Walk an arbitrary value, harvesting completed-request usage records and any
 * `completedAt`/`creationDate` timestamps. Robust to VS Code's `{kind, v}` delta
 * format and the older single-document format: we read the payloads wherever they
 * appear rather than replaying mutations.
 */
function harvest(
  value: unknown,
  records: Map<string, UsageRecord>,
  credits: Map<string, number>,
  times: number[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, records, credits, times);
    return;
  }
  if (!isObj(value)) return;

  if (typeof value['completedAt'] === 'number') times.push(value['completedAt'] as number);
  if (typeof value['creationDate'] === 'number') times.push(value['creationDate'] as number);

  // Variant A: result object with `details` + `usage:{promptTokens,completionTokens}`.
  // Variant B: agent-mode metadata with `promptTokens`/`outputTokens` + `resolvedModel`.
  const usage = isObj(value['usage']) ? (value['usage'] as AnyObj) : undefined;
  const input = num(usage?.['promptTokens'] ?? value['promptTokens']);
  const output = num(usage?.['completionTokens'] ?? value['outputTokens']);
  const meta = isObj(value['metadata']) ? (value['metadata'] as AnyObj) : undefined;
  const responseId =
    (value['responseId'] as string | undefined) ?? (meta?.['responseId'] as string | undefined);

  // GitHub's real credit cost is in `details` ("Model • 12.3 credits"), often in a
  // different delta object than the tokens — capture it by responseId and join later.
  if (responseId && typeof value['details'] === 'string') {
    const m = (value['details'] as string).match(/([0-9.]+)\s*credits/i);
    if (m) credits.set(responseId, parseFloat(m[1]));
  }

  if (responseId && (input > 0 || output > 0)) {
    const resolved =
      (value['resolvedModel'] as string | undefined) ?? (meta?.['resolvedModel'] as string | undefined);
    const details = value['details'];
    const modelRaw = resolved ?? (typeof details === 'string' ? modelFromDetails(details) : undefined);
    if (modelRaw) {
      // Split input into the cacheable System portion and the fresh remainder using
      // promptTokenDetails. When details are absent (e.g. agent-mode metadata), the
      // whole prompt is billed fresh — conservative, never under-counts.
      const sysPct = systemPercent(usage?.['promptTokenDetails']);
      const cacheable = sysPct > 0 ? Math.round((input * sysPct) / 100) : 0;
      // Dedup by responseId — a request's usage may be re-serialized across deltas.
      records.set(responseId, {
        responseId,
        model: resolveModel(modelRaw).id,
        freshInputTokens: input - cacheable,
        cacheableTokens: cacheable,
        outputTokens: output,
      });
    }
  }

  for (const key of Object.keys(value)) harvest(value[key], records, credits, times);
}

function readJsonOrJsonl(file: string): unknown[] {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return [JSON.parse(raw)]; // whole-document (.json) format
  } catch {
    // append-log (.jsonl): one JSON value per line
    const out: unknown[] = [];
    for (const line of raw.split('\n')) {
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
}

function readRepo(workspaceHash: string): string | undefined {
  try {
    const wsFile = path.join(getWorkspaceStorageDir(), workspaceHash, 'workspace.json');
    const folder = (JSON.parse(fs.readFileSync(wsFile, 'utf8')) as { folder?: string }).folder;
    if (!folder) return undefined;
    const decoded = decodeURIComponent(folder.replace(/^file:\/\/\//, ''));
    const base = decoded.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    return base || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Aggregate one Copilot Chat session file into per-model usage. Returns one
 * record per model used in the session (the user can switch models mid-session).
 */
export function parseChatSession(file: string, sessionId: string, workspaceHash = ''): CopilotSessionUsage[] {
  if (!fs.existsSync(file)) return [];

  const records = new Map<string, UsageRecord>();
  const credits = new Map<string, number>();
  const times: number[] = [];
  for (const value of readJsonOrJsonl(file)) harvest(value, records, credits, times);

  if (records.size === 0) return [];

  // Cost per session+model. For each request: if GitHub recorded a real credit value,
  // use it directly (authoritative — it already accounts for caching). Otherwise price
  // from tokens, where the stable System block is written to cache by the first such
  // request and read by the rest. Records iterate in insertion order (≈ chronological).
  interface ModelAcc {
    costUsd: number; input: number; output: number;
    cacheCreation: number; cacheRead: number; cacheWritten: boolean;
  }
  const perModel = new Map<string, ModelAcc>();
  for (const rec of records.values()) {
    const acc = perModel.get(rec.model)
      ?? { costUsd: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cacheWritten: false };
    acc.input += rec.freshInputTokens + rec.cacheableTokens;
    acc.output += rec.outputTokens;

    const gh = credits.get(rec.responseId);
    if (gh != null) {
      acc.costUsd += gh / CREDITS_PER_USD;
    } else {
      let cc = 0, cr = 0;
      if (rec.cacheableTokens > 0) {
        if (!acc.cacheWritten) { cc = rec.cacheableTokens; acc.cacheWritten = true; }
        else { cr = rec.cacheableTokens; }
      }
      acc.cacheCreation += cc;
      acc.cacheRead += cr;
      acc.costUsd += calculateCost(rec.model, rec.freshInputTokens, rec.outputTokens, cc, cr) ?? 0;
    }
    perModel.set(rec.model, acc);
  }

  const ts = times.length > 0 ? new Date(Math.max(...times)).toISOString() : new Date().toISOString();
  const repo = workspaceHash ? readRepo(workspaceHash) : undefined;

  const result: CopilotSessionUsage[] = [];
  for (const [model, acc] of perModel) {
    if (acc.costUsd <= 0) continue;
    result.push({
      sessionId,
      model,
      costUsd: acc.costUsd,
      inputTokens: acc.input,
      outputTokens: acc.output,
      cacheCreationTokens: acc.cacheCreation,
      cacheReadTokens: acc.cacheRead,
      timestamp: ts,
      externalId: `copilot-chat-${sessionId}-${model}`,
      repo,
    });
  }
  return result;
}
