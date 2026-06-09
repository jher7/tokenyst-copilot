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
 * Record one parsed session-model usage as an allocation (upsert by externalId).
 * Returns true if a brand-new allocation was inserted. `costUsd` is already
 * resolved by the parser (real GitHub credits where available, else token-priced).
 * `source` tags which Copilot surface (chat/cli) produced it — both share the same
 * `provider: 'copilot'` budget total.
 */
/**
 * Map a parsed session-model usage to a `SessionResult` allocation, or null if it carries no
 * billable cost (token-only/zero-cost records are skipped). Shared by the live-sync path
 * (`recordUsage`) and the batched historical import (`importHistory`).
 */
function toAllocation(u: CopilotSessionUsage | CliSessionUsage, source: UsageSource): SessionResult | null {
  if (u.costUsd <= 0) {
    debugLog(`bootstrap: skipping ${u.externalId} — cost=0 (model=${u.model})`);
    return null;
  }
  return {
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
  };
}

async function recordUsage(u: CopilotSessionUsage | CliSessionUsage, source: UsageSource): Promise<boolean> {
  const alloc = toAllocation(u, source);
  if (!alloc) return false;

  const result = await upsertCopilotSessionAllocation(alloc);
  debugLog(
    `bootstrap: ${result.inserted ? 'inserted' : 'updated'} ${u.externalId} ` +
    `source=${source} model=${u.model} cost=$${alloc.costUsd.toFixed(4)}`,
  );
  return result.inserted;
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
      if (alloc) allocations.push(alloc);
    }
  }
  for (const { file, sessionId } of cliFiles) {
    for (const usage of parseCliSession(file, sessionId)) {
      if (new Date(usage.timestamp).getTime() < sinceMs) continue;
      const alloc = toAllocation(usage, 'cli');
      if (alloc) allocations.push(alloc);
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
