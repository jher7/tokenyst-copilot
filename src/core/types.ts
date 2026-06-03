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
  cacheCreationTokens: number;
  cacheReadTokens: number;
  filesModified: string[];
  provider?: ProviderId;
  externalId?: string;
  repo?: string;
  /** Copilot surface (chat vs cli) this usage came from; defaults to 'chat'. */
  source?: UsageSource;
  /** ISO timestamp of the event; defaults to now when omitted (live sync). */
  at?: string;
}
