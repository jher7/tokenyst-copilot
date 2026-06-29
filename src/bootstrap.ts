import { applyCopilotSessionUpsert, loadConfig, mutateConfig, upsertCopilotSessionAllocation } from './core/local-config';
import type { SessionResult, UsageSource } from './core/types';
import {
  findChatSessionFiles,
  parseChatSession,
  type CopilotSessionUsage,
} from './ingestion/chat-parser';
import {
  findCliSessionFiles,
  parseCliSession,
  type CliSessionUsage,
} from './ingestion/cli-parser';
import { debugLog } from './util';

// When deciding which session files changed since the last sync, allow a small
// overlap so a write landing right at the sync boundary is never skipped.
const MTIME_MARGIN_MS = 5_000;

export async function syncNow(): Promise<void> {
  try {
    await _sync();
  } catch (err) {
    debugLog(`bootstrap: unhandled error — ${err instanceof Error ? err.stack : String(err)}`);
  }
}

/**
 * Get the midnight timestamp (milliseconds) for a given date in UTC.
 */
function getMidnightUtcMs(timestampMs: number): number {
  const date = new Date(timestampMs);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Format a date in YYYYMMDD format for use in daily allocation IDs.
 */
function formatDateYYYYMMDD(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Record one parsed session-model usage as an allocation (upsert by externalId).
 * Returns true if a brand-new allocation was inserted. `costUsd` is already
 * resolved by the parser (real GitHub credits where available, else token-priced).
 * `source` tags which Copilot surface (chat/cli) produced it — both share the same
 * `provider: 'copilot'` budget total.
 */
/**
 * Map a parsed session-model usage to one or more `SessionResult` allocations.
 * Zero-cost usage returns an empty list.
 *
 * Chat usage with per-request timestamps is split into per-day allocations.
 * Everything else falls back to a single session-level allocation.
 */
function toAllocation(u: CopilotSessionUsage | CliSessionUsage, source: UsageSource): SessionResult[] {
  if (u.costUsd <= 0) {
    debugLog(`bootstrap: skipping ${u.externalId} — cost=0 (model=${u.model})`);
    return [];
  }

  // If we have per-request timestamps, split by calendar day.
  const chatUsage = u as CopilotSessionUsage;
  if (chatUsage.requests && chatUsage.requests.length > 0) {
    type DayAcc = {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      dateStr: string;
    };
    const dayMap = new Map<number, DayAcc>();
    for (const req of chatUsage.requests) {
      const midnightMs = getMidnightUtcMs(req.completedAtMs);
      const dateStr = formatDateYYYYMMDD(req.completedAtMs);
      const existing = dayMap.get(midnightMs) ?? {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        dateStr,
      };
      existing.costUsd += req.costUsd;
      existing.inputTokens += req.inputTokens;
      existing.outputTokens += req.outputTokens;
      existing.cacheCreationTokens += req.cacheCreationTokens;
      existing.cacheReadTokens += req.cacheReadTokens;
      dayMap.set(midnightMs, existing);
    }

    const results: SessionResult[] = [];
    for (const [midnightMs, dayData] of dayMap) {
      if (dayData.costUsd <= 0) continue;
      results.push({
        costUsd: dayData.costUsd,
        model: u.model,
        inputTokens: dayData.inputTokens,
        outputTokens: dayData.outputTokens,
        cacheCreationTokens: dayData.cacheCreationTokens > 0 ? dayData.cacheCreationTokens : null,
        cacheReadTokens: dayData.cacheReadTokens > 0 ? dayData.cacheReadTokens : null,
        filesModified: [],
        provider: 'copilot',
        externalId: `${u.externalId}-${dayData.dateStr}`,
        repo: u.repo,
        source,
        at: new Date(midnightMs).toISOString(),
        sessionId: u.sessionId,
        title: u.title,
      });
    }
    return results;
  }

  // Fallback: no per-request data, create single allocation using session-level timestamp.
  return [{
    costUsd: u.costUsd,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    cacheReadTokens: u.cacheReadTokens,
    filesModified: [],
    provider: 'copilot',
    externalId: u.externalId,
    repo: u.repo,
    source,
    at: u.timestamp,
    sessionId: u.sessionId,
    title: u.title,
  }];
}

async function recordUsage(u: CopilotSessionUsage | CliSessionUsage, source: UsageSource): Promise<boolean> {
  const alloc = toAllocation(u, source);
  if (alloc.length === 0) return false;

  let anyInserted = false;
  for (const a of alloc) {
    const result = await upsertCopilotSessionAllocation(a);
    if (result.inserted) anyInserted = true;
    debugLog(
      `bootstrap: ${result.inserted ? 'inserted' : 'updated'} ${a.externalId} ` +
      `source=${source} model=${u.model} cost=$${a.costUsd.toFixed(4)}`,
    );
  }
  return anyInserted;
}

/**
 * Parse every Copilot session and record its usage, filtering to sessions whose
 * usage timestamp is at/after `since` (null = everything). Returns the number of
 * newly inserted allocations. Independent of the live-sync watermark and the
 * `copilot.enabled` flag — used for historical backfill.
 */
export async function importHistory(since: string | null): Promise<number> {
  const sinceMs = since ? new Date(since).getTime() : 0;
  const chatFiles = findChatSessionFiles();
  const cliFiles = findCliSessionFiles();
  debugLog(`import: scanning ${chatFiles.length} chat + ${cliFiles.length} cli session file(s) since ${since ?? 'beginning'}`);

  // Gather every qualifying allocation first, then apply them all under a SINGLE
  // load→save cycle below. The old code saved config once per session, producing hundreds
  // of temp-write+rename ops in a tight loop — on Windows that reliably collided with a
  // transient file lock (EPERM on rename). One write per import removes that storm.
  const allocations: SessionResult[] = [];
  for (const { file, sessionId, workspaceHash } of chatFiles) {
    for (const usage of parseChatSession(file, sessionId, workspaceHash)) {
      if (new Date(usage.timestamp).getTime() < sinceMs) continue;
      const alloc = toAllocation(usage, 'chat');
      allocations.push(...alloc);
    }
  }
  for (const { file, sessionId } of cliFiles) {
    for (const usage of parseCliSession(file, sessionId)) {
      if (new Date(usage.timestamp).getTime() < sinceMs) continue;
      const allocs = toAllocation(usage, 'cli');
      allocations.push(...allocs);
    }
  }

  const recorded = await mutateConfig((cfg) => {
    let inserted = 0;
    for (const alloc of allocations) {
      if (applyCopilotSessionUpsert(cfg, alloc).inserted) inserted++;
    }
    return inserted;
  });
  debugLog(`import: recorded ${recorded} new allocation(s)`);
  return recorded;
}

/**
 * Whether any Copilot usage exists at or after `since` (null = any at all).
 * Used to decide whether to offer a historical import when enabling tracking.
 */
export function hasImportableHistory(since: string | null): boolean {
  const sinceMs = since ? new Date(since).getTime() : 0;
  for (const { file, sessionId, workspaceHash } of findChatSessionFiles()) {
    for (const usage of parseChatSession(file, sessionId, workspaceHash)) {
      if (new Date(usage.timestamp).getTime() >= sinceMs) return true;
    }
  }
  for (const { file, sessionId } of findCliSessionFiles()) {
    for (const usage of parseCliSession(file, sessionId)) {
      if (new Date(usage.timestamp).getTime() >= sinceMs) return true;
    }
  }
  return false;
}

async function _sync(): Promise<void> {
  const cfg = await loadConfig();
  const copilot = cfg.copilot;
  if (!copilot?.enabled) return;

  const since = copilot.lastSeenEventsAt ?? null;
  const sinceMs = since ? new Date(since).getTime() - MTIME_MARGIN_MS : 0;
  const syncedAt = new Date().toISOString();

  // Re-aggregate only sessions whose file changed since the last sync. Upserts are
  // idempotent, so an in-progress session is refreshed each tick as more requests
  // complete and add real token usage. Both Chat and CLI share the same watermark.
  const chatFiles = findChatSessionFiles();
  const cliFiles = findCliSessionFiles();
  const changedChat = chatFiles.filter(f => f.mtimeMs >= sinceMs);
  const changedCli = cliFiles.filter(f => f.mtimeMs >= sinceMs);
  debugLog(
    `bootstrap: ${changedChat.length}/${chatFiles.length} chat + ` +
    `${changedCli.length}/${cliFiles.length} cli session file(s) changed since ${since ?? 'beginning'}`,
  );

  let touched = 0;
  for (const { file, sessionId, workspaceHash } of changedChat) {
    for (const usage of parseChatSession(file, sessionId, workspaceHash)) {
      await recordUsage(usage, 'chat');
      touched++;
    }
  }
  for (const { file, sessionId } of changedCli) {
    for (const usage of parseCliSession(file, sessionId)) {
      await recordUsage(usage, 'cli');
      touched++;
    }
  }
  debugLog(`bootstrap: processed ${touched} session-model usage record(s)`);

  await mutateConfig((cfg) => {
    if (cfg.copilot) cfg.copilot.lastSeenEventsAt = syncedAt;
  });
}
