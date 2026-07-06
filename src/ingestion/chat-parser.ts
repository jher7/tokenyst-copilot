import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveModel, calculateCost, CREDITS_PER_USD } from '../core/pricing';
import { debugLog } from '../util';
/**
 * Per-request usage data: the cost and timestamp of a single response.
 * Used internally to track which requests occurred on which calendar days,
 * enabling accurate daily attribution across multi-day sessions.
 */
export interface PerRequestUsage {
  responseId: string;
  completedAtMs: number; // millisecond timestamp when this request completed
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}


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
  /**
   * Estimated cache-write / cache-read tokens, or `null` when the session file
   * carried no per-category prompt breakdown to derive them from. Newer VS Code
   * builds persist only aggregate `promptTokens`/`outputTokens` (no
   * `promptTokenDetails`), so the cache split is genuinely unknown — `null`
   * is surfaced as "not reported" rather than a misleading zero.
   */
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  timestamp: string;
  externalId: string;
    /** Per-request usage details with timestamps. Used for daily attribution. */
    requests?: PerRequestUsage[];
  repo?: string;
  /** Human-readable title: the session's first user prompt (truncated). */
  title?: string;
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

/** Directory for Copilot Chat sessions opened without any workspace folder. */
function getEmptyWindowChatSessionsDir(): string {
  return path.join(getVSCodeUserDir(), 'globalStorage', 'emptyWindowChatSessions');
}

export function findChatSessionFiles(): ChatSessionFile[] {
  const out: ChatSessionFile[] = [];

  // Workspace-scoped sessions: workspaceStorage/<hash>/chatSessions/*.json[l]
  const root = getWorkspaceStorageDir();
  if (fs.existsSync(root)) {
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
  }

  // Empty-window sessions (no workspace folder open):
  // globalStorage/emptyWindowChatSessions/<sessionId>.json[l]
  const emptyDir = getEmptyWindowChatSessionsDir();
  if (fs.existsSync(emptyDir)) {
    for (const entry of fs.readdirSync(emptyDir)) {
      if (!entry.endsWith('.json') && !entry.endsWith('.jsonl')) continue;
      const file = path.join(emptyDir, entry);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // workspaceHash is '' — parseChatSession already handles this (repo → undefined).
      out.push({ file, sessionId: entry.replace(/\.jsonl?$/, ''), workspaceHash: '', mtimeMs });
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
  /**
   * Whether this request carried a per-category prompt breakdown
   * (`usage.promptTokenDetails`). When false for every request in a session+model
   * group, the cache split is unknown and is reported as `null` (not zero).
   */
  cacheReported: boolean;
  /** Millisecond timestamp when this request completed. */
  completedAtMs: number;
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
  title: { text?: string },
): void {
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, records, credits, times, title);
    return;
  }
  if (!isObj(value)) return;

  if (typeof value['completedAt'] === 'number') times.push(value['completedAt'] as number);
  if (typeof value['creationDate'] === 'number') times.push(value['creationDate'] as number);

  // A request's user prompt lives in `message.text`. The first one seen (file order
  // ≈ chronological) is the session's opening prompt — what VS Code shows as the
  // chat title. Capture it once.
  if (title.text === undefined) {
    const msg = isObj(value['message']) ? (value['message'] as AnyObj) : undefined;
    const text = msg && typeof msg['text'] === 'string' ? (msg['text'] as string).trim() : '';
    if (text) title.text = text;
  }

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

  if (responseId) {
    const resolved =
      (value['resolvedModel'] as string | undefined) ?? (meta?.['resolvedModel'] as string | undefined);
    const details = value['details'];
    const modelRaw = resolved ?? (typeof details === 'string' ? modelFromDetails(details) : undefined);
    const hasRecordedCredits = credits.has(responseId);

    // Keep a record when we have either token usage or an authoritative credit line.
    if (modelRaw && (input > 0 || output > 0 || hasRecordedCredits)) {
      const promptTokenDetails = usage?.['promptTokenDetails'];
      const sysPct = systemPercent(promptTokenDetails);
      const cacheable = sysPct > 0 ? Math.round((input * sysPct) / 100) : 0;

      // In agent-mode JSONL sessions, per-request completion timestamps live in
      // toolCallRounds inside the result.metadata object (accessible via `meta` when
      // processing the `result` object, or directly as `value.toolCallRounds` when
      // processing `result.metadata` itself). The last round's timestamp is the closest
      // proxy for when the model actually completed the request.
      const roundsArr = Array.isArray(meta?.['toolCallRounds'])
        ? (meta!['toolCallRounds'] as AnyObj[])
        : Array.isArray(value['toolCallRounds'])
          ? (value['toolCallRounds'] as AnyObj[])
          : [];
      const lastRoundTs = roundsArr.length > 0 ? num(roundsArr[roundsArr.length - 1]['timestamp']) : 0;

      const hasRealTimestamp = typeof value['completedAt'] === 'number'
        || typeof value['creationDate'] === 'number'
        || lastRoundTs > 0;
      const completedAtMs = typeof value['completedAt'] === 'number'
        ? (value['completedAt'] as number)
        : typeof value['creationDate'] === 'number'
          ? (value['creationDate'] as number)
          : lastRoundTs > 0
            ? lastRoundTs
            : Date.now();

      // Merge deltas for the same responseId: keep any known fields from earlier records.
      // completedAtMs: prefer a real timestamp from either delta; only fall back to Date.now()
      // if no real timestamp has been seen yet. This prevents a credit-only delta (details
      // string, no completedAt) from overwriting a real timestamp already captured by the
      // token-usage delta for the same responseId.
      const prev = records.get(responseId);
      records.set(responseId, {
        responseId,
        model: prev?.model ?? resolveModel(modelRaw).id,
        freshInputTokens: input > 0 ? input - cacheable : (prev?.freshInputTokens ?? 0),
        cacheableTokens: input > 0 ? cacheable : (prev?.cacheableTokens ?? 0),
        outputTokens: output > 0 ? output : (prev?.outputTokens ?? 0),
        cacheReported: Array.isArray(promptTokenDetails) || prev?.cacheReported === true,
        completedAtMs: hasRealTimestamp ? completedAtMs : (prev?.completedAtMs ?? completedAtMs),
      });
    }
  }

  for (const key of Object.keys(value)) harvest(value[key], records, credits, times, title);
}

/** Trim a prompt down to a compact, single-line session title. */
export function toTitle(text: string | undefined, max = 80): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return oneLine.length > max ? oneLine.slice(0, max - 1).trimEnd() + '…' : oneLine;
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
  const titleRef: { text?: string } = {};
  for (const value of readJsonOrJsonl(file)) harvest(value, records, credits, times, titleRef);

  if (credits.size > records.size) {
    debugLog(
      `chat-parser: credits found for ${credits.size} response(s), usage records for ${records.size} ` +
      `(session=${sessionId}, file=${path.basename(file)})`,
    );
  }

  if (records.size === 0) return [];

  const title = toTitle(titleRef.text);

  // Cost per session+model. For each request: if GitHub recorded a real credit value,
  // use it directly (authoritative — it already accounts for caching). Otherwise price
  // from tokens, where the stable System block is written to cache by the first such
  // request and read by the rest. Records iterate in insertion order (≈ chronological).
  interface ModelAcc {
    costUsd: number; input: number; output: number;
    cacheCreation: number; cacheRead: number; cacheWritten: boolean;
    cacheReported: boolean;
  }
  const perModel = new Map<string, ModelAcc>();
    // Track per-request costs for daily attribution.
    const perRequestCosts = new Map<string, { costUsd: number; cacheCreation: number; cacheRead: number }>();
  for (const rec of records.values()) {
    const acc = perModel.get(rec.model)
      ?? { costUsd: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cacheWritten: false, cacheReported: false };
    acc.input += rec.freshInputTokens + rec.cacheableTokens;
    acc.output += rec.outputTokens;
    if (rec.cacheReported) acc.cacheReported = true;

    const gh = credits.get(rec.responseId);
      let requestCostUsd = 0;
      let requestCacheCreation = 0;
      let requestCacheRead = 0;
    if (gh != null) {
        requestCostUsd = gh / CREDITS_PER_USD;
      acc.costUsd += gh / CREDITS_PER_USD;
    } else {
      let cc = 0, cr = 0;
      if (rec.cacheableTokens > 0) {
        if (!acc.cacheWritten) { cc = rec.cacheableTokens; acc.cacheWritten = true; }
        else { cr = rec.cacheableTokens; }
        requestCacheCreation = cc;
        requestCacheRead = cr;
      }
      acc.cacheCreation += cc;
      acc.cacheRead += cr;
      requestCostUsd = calculateCost(rec.model, rec.freshInputTokens, rec.outputTokens, cc, cr) ?? 0;
      acc.costUsd += requestCostUsd;
    }
    perRequestCosts.set(rec.responseId, {
      costUsd: requestCostUsd,
      cacheCreation: requestCacheCreation,
      cacheRead: requestCacheRead,
    });
    perModel.set(rec.model, acc);
  }

  const ts = times.length > 0 ? new Date(Math.max(...times)).toISOString() : new Date().toISOString();
  const repo = workspaceHash ? readRepo(workspaceHash) : undefined;

  const result: CopilotSessionUsage[] = [];
  for (const [model, acc] of perModel) {
    if (acc.costUsd <= 0) continue;
        // Build requests array: filter per-model requests with their timestamps and costs
        const requests: PerRequestUsage[] = [];
        for (const rec of records.values()) {
          if (rec.model !== model) continue;
          const costData = perRequestCosts.get(rec.responseId);
          if (costData) {
            requests.push({
              responseId: rec.responseId,
              completedAtMs: rec.completedAtMs,
              costUsd: costData.costUsd,
              inputTokens: rec.freshInputTokens + rec.cacheableTokens,
              outputTokens: rec.outputTokens,
              cacheCreationTokens: costData.cacheCreation,
              cacheReadTokens: costData.cacheRead,
            });
          }
        }
    result.push({
      sessionId,
      model,
      costUsd: acc.costUsd,
      inputTokens: acc.input,
      outputTokens: acc.output,
      // Only report a cache split when the source actually provided a breakdown;
      // otherwise it's unknown (null → "not reported"), never a misleading zero.
      cacheCreationTokens: acc.cacheReported ? acc.cacheCreation : null,
      cacheReadTokens: acc.cacheReported ? acc.cacheRead : null,
      timestamp: ts,
      externalId: `copilot-chat-${sessionId}-${model}`,
      repo,
      title,
      requests: requests.length > 0 ? requests : undefined,
    });
  }
  return result;
}
