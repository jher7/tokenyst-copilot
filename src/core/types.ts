export type ProviderId = 'claude' | 'copilot';

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
  /** ISO timestamp of the event; defaults to now when omitted (live sync). */
  at?: string;
}
