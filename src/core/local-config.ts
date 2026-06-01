import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { SessionResult, ProviderId } from './types';

export interface CopilotConfig {
  enabled: boolean;
  lastSeenEventsAt: string | null;
  /** @deprecated billing reconciliation via the gh CLI was removed; kept for back-compat reads. */
  lastReconciledAt?: string | null;
  /** @deprecated replaced by lastSeenEventsAt */
  logDir?: string | null;
  /** @deprecated replaced by lastSeenEventsAt */
  lastSeenLogPos?: number;
}

export interface LocalAllocation {
  costUsd: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  filesModified: string[];
  at: string;
  provider: ProviderId;
  externalId?: string;
  repo?: string;
  manual?: boolean;
}

export interface LocalConfig {
  allocations: LocalAllocation[];
  enabled: boolean;
  copilot?: CopilotConfig;
  monthlyBudgetUsd?: number | null;
  /** Day of month (1-31) the plan renews; null/unset = calendar month (day 1). */
  renewalDay?: number | null;
}

const DEFAULT_CONFIG: LocalConfig = {
  allocations: [],
  enabled: true,
  monthlyBudgetUsd: null,
  renewalDay: null,
};

export function getConfigDir(): string {
  return path.join(os.homedir(), '.tokenyst');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

function normalizeAllocation(a: unknown): LocalAllocation {
  const raw = a as Record<string, unknown>;
  return {
    costUsd: Number(raw.costUsd) || 0,
    model: String(raw.model ?? 'unknown'),
    inputTokens: raw.inputTokens != null ? Number(raw.inputTokens) : null,
    outputTokens: raw.outputTokens != null ? Number(raw.outputTokens) : null,
    cacheCreationTokens: raw.cacheCreationTokens != null ? Number(raw.cacheCreationTokens) : null,
    cacheReadTokens: raw.cacheReadTokens != null ? Number(raw.cacheReadTokens) : null,
    filesModified: Array.isArray(raw.filesModified) ? (raw.filesModified as unknown[]).map(String) : [],
    at: String(raw.at ?? new Date().toISOString()),
    provider: (raw.provider === 'copilot' ? 'copilot' : 'claude') as ProviderId,
    externalId: raw.externalId != null ? String(raw.externalId) : undefined,
    repo: raw.repo != null ? String(raw.repo) : undefined,
    manual: raw.manual === true ? true : undefined,
  };
}

export async function loadConfig(): Promise<LocalConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Migrate from old budget-based format: flatten all budget allocations
    let allocations: LocalAllocation[];
    if (Array.isArray(parsed['allocations'])) {
      allocations = (parsed['allocations'] as unknown[]).map(normalizeAllocation);
    } else if (Array.isArray(parsed['budgets'])) {
      allocations = (parsed['budgets'] as unknown[]).flatMap((b) => {
        const budget = b as Record<string, unknown>;
        return Array.isArray(budget['allocations'])
          ? (budget['allocations'] as unknown[]).map(normalizeAllocation)
          : [];
      });
    } else {
      allocations = [];
    }

    return {
      ...DEFAULT_CONFIG,
      ...(parsed as Partial<LocalConfig>),
      allocations,
    };
  } catch {
    // Fresh allocations array — never hand back the shared DEFAULT_CONFIG.allocations,
    // or callers that push before the first save would mutate module-level state.
    return { ...DEFAULT_CONFIG, allocations: [] };
  }
}

export async function saveConfig(cfg: LocalConfig): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

type DedupEntry = string | { timestamp: string; pctUsed?: string };
type DedupMap = Record<string, DedupEntry>;

function entryTimestamp(e: DedupEntry): string {
  return typeof e === 'string' ? e : e.timestamp;
}

function getDedupPath(): string {
  return path.join(getConfigDir(), 'recorded-turns.json');
}

function normalizeDedupKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function readRecordedTurns(): Promise<DedupMap> {
  try {
    const raw = await fs.readFile(getDedupPath(), 'utf8');
    return JSON.parse(raw) as DedupMap;
  } catch {
    return {};
  }
}

export async function markTurnRecorded(transcriptPath: string, timestamp: string, pctUsed?: string): Promise<void> {
  const map = await readRecordedTurns();
  map[normalizeDedupKey(transcriptPath)] = pctUsed != null ? { timestamp, pctUsed } : timestamp;
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(getDedupPath(), JSON.stringify(map, null, 2), 'utf8');
}

export async function getLastRecordedTimestamp(transcriptPath: string): Promise<string | null> {
  const map = await readRecordedTurns();
  const entry = map[normalizeDedupKey(transcriptPath)];
  return entry != null ? entryTimestamp(entry) : null;
}

export async function getRecordedPct(transcriptPath: string): Promise<string | undefined> {
  const map = await readRecordedTurns();
  const entry = map[normalizeDedupKey(transcriptPath)];
  if (entry == null || typeof entry === 'string') return undefined;
  return entry.pctUsed;
}

export async function recordLocalAllocation(
  session: SessionResult,
): Promise<{ success: boolean; deduped?: boolean; error?: string }> {
  const cfg = await loadConfig();
  const provider = session.provider ?? 'claude';
  const now = Date.now();

  const dup = cfg.allocations.find(a => {
    if (session.externalId && a.externalId === session.externalId) return true;
    return (
      a.provider === provider &&
      a.model === session.model &&
      a.inputTokens === session.inputTokens &&
      a.outputTokens === session.outputTokens &&
      a.cacheCreationTokens === session.cacheCreationTokens &&
      a.cacheReadTokens === session.cacheReadTokens &&
      a.costUsd === session.costUsd &&
      now - new Date(a.at).getTime() < 60_000
    );
  });
  if (dup) return { success: true, deduped: true };

  cfg.allocations.push({
    costUsd: session.costUsd,
    model: session.model,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheCreationTokens: session.cacheCreationTokens,
    cacheReadTokens: session.cacheReadTokens,
    filesModified: session.filesModified,
    at: session.at ?? new Date().toISOString(),
    provider,
    externalId: session.externalId,
    repo: session.repo,
  });

  await saveConfig(cfg);
  return { success: true };
}

/**
 * Insert or update a per-session-per-model Copilot allocation, keyed by `externalId`
 * (`copilot-chat-<id>-<model>`). Unlike `recordLocalAllocation`, an existing match is
 * overwritten in place — this is how a chat session's running total is refreshed as
 * more requests complete, without double-counting.
 */
export async function upsertCopilotSessionAllocation(
  session: SessionResult,
): Promise<{ success: boolean; inserted: boolean }> {
  const cfg = await loadConfig();
  const existing = session.externalId
    ? cfg.allocations.find(a => a.externalId === session.externalId)
    : undefined;

  if (existing) {
    existing.costUsd = session.costUsd;
    existing.model = session.model;
    existing.inputTokens = session.inputTokens;
    existing.outputTokens = session.outputTokens;
    existing.cacheCreationTokens = session.cacheCreationTokens;
    existing.cacheReadTokens = session.cacheReadTokens;
    existing.filesModified = session.filesModified;
    existing.repo = session.repo;
    if (session.at) existing.at = session.at;
    await saveConfig(cfg);
    return { success: true, inserted: false };
  }

  cfg.allocations.push({
    costUsd: session.costUsd,
    model: session.model,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheCreationTokens: session.cacheCreationTokens,
    cacheReadTokens: session.cacheReadTokens,
    filesModified: session.filesModified,
    at: session.at ?? new Date().toISOString(),
    provider: session.provider ?? 'copilot',
    externalId: session.externalId,
    repo: session.repo,
  });
  await saveConfig(cfg);
  return { success: true, inserted: true };
}

/**
 * A manual allocation is one the user entered by hand. Detected by, in order:
 *  - `manual: true` (current entries), or
 *  - a `manual-*` externalId (entries created before the flag existed), or
 *  - a Copilot entry with all four token counts null. Synced/imported entries
 *    come from `SessionResult`, where those fields are required numbers, so only
 *    a hand-entered allocation leaves them null. This catches legacy manual
 *    entries that have neither the flag nor a `manual-*` externalId.
 */
export function isManualAllocation(a: LocalAllocation): boolean {
  if (a.manual === true) return true;
  if (a.externalId?.startsWith('manual-')) return true;
  return (
    a.provider === 'copilot' &&
    a.inputTokens === null &&
    a.outputTokens === null &&
    a.cacheCreationTokens === null &&
    a.cacheReadTokens === null
  );
}

/**
 * Assign a stable `manual-*` externalId to any manual allocation that lacks one
 * (legacy entries detected by the null-token signal), persisting if anything
 * changed. Returns the config so callers can list/delete by externalId reliably.
 */
export async function backfillManualExternalIds(): Promise<LocalConfig> {
  const cfg = await loadConfig();
  let changed = false;
  for (const a of cfg.allocations) {
    if (isManualAllocation(a) && !a.externalId) {
      a.externalId = `manual-${new Date(a.at).getTime()}-${Math.random().toString(36).slice(2, 7)}`;
      a.manual = true;
      changed = true;
    }
  }
  if (changed) await saveConfig(cfg);
  return cfg;
}

export async function deleteManualAllocation(
  externalId: string,
): Promise<{ success: boolean; error?: string }> {
  const cfg = await loadConfig();
  const idx = cfg.allocations.findIndex(a => a.externalId === externalId && isManualAllocation(a));
  if (idx === -1) return { success: false, error: `Manual allocation "${externalId}" not found` };
  cfg.allocations.splice(idx, 1);
  await saveConfig(cfg);
  return { success: true };
}

export async function updateAllocationCost(
  externalId: string,
  newCostUsd: number,
): Promise<{ success: boolean; error?: string }> {
  const cfg = await loadConfig();
  const alloc = cfg.allocations.find(a => a.externalId === externalId);
  if (!alloc) return { success: false, error: `Allocation "${externalId}" not found` };
  alloc.costUsd = newCostUsd;
  await saveConfig(cfg);
  return { success: true };
}

export interface BillingPeriod {
  start: Date;
  end: Date;
  renewalDay: number | null;
}

/**
 * The current billing period anchored on `renewalDay` (day of month, 1-31).
 * Runs from the most recent renewal day (inclusive) to the next one (exclusive).
 * Days beyond a month's length clamp to its last day (e.g. 31 → Feb 28).
 * When `renewalDay` is null/unset, the period is the calendar month (anchored on day 1).
 */
export function getCurrentPeriod(renewalDay: number | null | undefined, now: Date = new Date()): BillingPeriod {
  const day = renewalDay != null && renewalDay >= 1 && renewalDay <= 31 ? Math.floor(renewalDay) : 1;
  const clampDay = (year: number, month: number): number =>
    Math.min(day, new Date(year, month + 1, 0).getDate());

  const y = now.getFullYear();
  const m = now.getMonth();
  const anchorThisMonth = new Date(y, m, clampDay(y, m), 0, 0, 0, 0);

  let start: Date;
  if (now.getTime() >= anchorThisMonth.getTime()) {
    start = anchorThisMonth;
  } else {
    const py = m === 0 ? y - 1 : y;
    const pm = m === 0 ? 11 : m - 1;
    start = new Date(py, pm, clampDay(py, pm), 0, 0, 0, 0);
  }

  const sy = start.getFullYear();
  const sm = start.getMonth();
  const ny = sm === 11 ? sy + 1 : sy;
  const nm = sm === 11 ? 0 : sm + 1;
  const end = new Date(ny, nm, clampDay(ny, nm), 0, 0, 0, 0);

  return { start, end, renewalDay: renewalDay ?? null };
}

export async function getMonthlySummary(): Promise<{
  monthlyBudgetUsd: number | null;
  monthlySpentUsd: number;
  renewalDay: number | null;
  periodStart: string;
  periodEnd: string;
}> {
  const cfg = await loadConfig();
  const period = getCurrentPeriod(cfg.renewalDay);
  const startMs = period.start.getTime();
  const endMs = period.end.getTime();
  let monthlySpentUsd = 0;
  for (const a of cfg.allocations) {
    if (a.provider !== 'copilot') continue;
    const t = new Date(a.at).getTime();
    if (t >= startMs && t < endMs) {
      monthlySpentUsd += a.costUsd;
    }
  }
  return {
    monthlyBudgetUsd: cfg.monthlyBudgetUsd ?? null,
    monthlySpentUsd,
    renewalDay: period.renewalDay,
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
  };
}
