export type ProviderId = 'claude' | 'copilot';

/** Which Copilot surface produced the usage. Used only for the UI breakdown;
 * both sources share the same `provider: 'copilot'` budget total. */
export type UsageSource = 'chat' | 'cli';

export interface Provider {
  id: ProviderId;
  displayName: string;
  pricingPrefix: string;
}

export interface FileEdit {
  filePath: string;
  linesChanged: number;
  changeType: 'create' | 'modify' | 'delete';
}

export interface SessionResult {
  costUsd: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-write / cache-read tokens, or `null` when the source reported no
   * cache breakdown (surfaced as "not reported" rather than zero). */
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  filesModified: string[];
  provider?: ProviderId;
  externalId?: string;
  repo?: string;
  /** Copilot surface (chat vs cli) this usage came from; defaults to 'chat'. */
  source?: UsageSource;
  /** ISO timestamp of the event; defaults to now when omitted (live sync). */
  at?: string;
  /** Stable session identifier (the chat/CLI session this usage belongs to). */
  sessionId?: string;
  /** Human-readable session title (chat: first user prompt). Absent for CLI. */
  title?: string;
  /** responseIds counted in this allocation; used to deduplicate requests inherited
   * by forked sessions. Absent on legacy/CLI/manual allocations. */
  responseIds?: string[];
  /** Number of requests in this allocation with no known price at all: no real
   * credit value and no built-in pricing match. These are NOT counted in
   * `costUsd` — not even as a `0` — so `costUsd` genuinely excludes (and
   * understates relative to) real spend. Omitted when zero. */
  unpricedRequestCount?: number;
  /** Input/output tokens belonging to the unpriced requests counted above. */
  unpricedInputTokens?: number;
  unpricedOutputTokens?: number;
  /** True when this allocation was priced (in full or in part) using a
   * user-entered manual override rather than a real credit value or built-in
   * table. */
  hasManualPricing?: boolean;
}
