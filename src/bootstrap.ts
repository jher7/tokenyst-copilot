import { loadConfig, mutateConfig, upsertCopilotSessionAllocation } from './core/local-config';
import {
  findChatSessionFiles,
  parseChatSession,
  type CopilotSessionUsage,
} from './ingestion/chat-parser';
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
 */
async function recordUsage(u: CopilotSessionUsage): Promise<boolean> {
  const cost = u.costUsd;

  if (cost <= 0) {
    debugLog(`bootstrap: skipping ${u.externalId} — cost=0 (model=${u.model})`);
    return false;
  }

  const result = await upsertCopilotSessionAllocation({
    costUsd: cost,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    cacheReadTokens: u.cacheReadTokens,
    filesModified: [],
    provider: 'copilot',
    externalId: u.externalId,
    repo: u.repo,
    at: u.timestamp,
  });
  debugLog(
    `bootstrap: ${result.inserted ? 'inserted' : 'updated'} ${u.externalId} ` +
    `model=${u.model} cost=$${cost.toFixed(4)}`,
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
  const files = findChatSessionFiles();
  debugLog(`import: scanning ${files.length} chat session file(s) since ${since ?? 'beginning'}`);

  let recorded = 0;
  for (const { file, sessionId, workspaceHash } of files) {
    for (const usage of parseChatSession(file, sessionId, workspaceHash)) {
      if (new Date(usage.timestamp).getTime() < sinceMs) continue;
      if (await recordUsage(usage)) recorded++;
    }
  }
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
  return false;
}

async function _sync(): Promise<void> {
  const cfg = await loadConfig();
  const copilot = cfg.copilot;
  if (!copilot?.enabled) return;

  const since = copilot.lastSeenEventsAt ?? null;
  const sinceMs = since ? new Date(since).getTime() - MTIME_MARGIN_MS : 0;
  const syncedAt = new Date().toISOString();

  const files = findChatSessionFiles();
  // Re-aggregate only sessions whose file changed since the last sync. Upserts are
  // idempotent, so an in-progress session is refreshed each tick as more requests
  // complete and add real token usage.
  const changed = files.filter(f => f.mtimeMs >= sinceMs);
  debugLog(`bootstrap: ${changed.length}/${files.length} chat session file(s) changed since ${since ?? 'beginning'}`);

  let touched = 0;
  for (const { file, sessionId, workspaceHash } of changed) {
    for (const usage of parseChatSession(file, sessionId, workspaceHash)) {
      await recordUsage(usage);
      touched++;
    }
  }
  debugLog(`bootstrap: processed ${touched} session-model usage record(s)`);

  await mutateConfig((cfg) => {
    if (cfg.copilot) cfg.copilot.lastSeenEventsAt = syncedAt;
  });
}
