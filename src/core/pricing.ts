export interface PricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
}

// GitHub Copilot moved to usage-based (token) billing on 2026-06-01: credits are
// consumed by input, output, and cached tokens at each model's published API rate.
// These per-million rates mirror those published rates. Cached tokens are billed
// via the cache multipliers below.
export const MODEL_PRICING: Record<string, PricingEntry> = {
  // Generic family fallbacks — used when a specific version isn't listed below,
  // so a brand-new model still gets a sane price instead of $0.
  'claude-opus':   { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-sonnet': { inputPerMillion: 3,   outputPerMillion: 15 },
  'claude-haiku':  { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'gpt':           { inputPerMillion: 2.5, outputPerMillion: 15 },
  'gemini':        { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  // o-series reasoning models. Representative rate — adjust if a specific o-model
  // is listed below or its published rate differs.
  'o-series':      { inputPerMillion: 2,   outputPerMillion: 8 },
  // Copilot models - OpenAI (June 2026)
  'copilot-gpt-5.5':             { inputPerMillion: 5,    outputPerMillion: 30 },
  'copilot-gpt-5.4':             { inputPerMillion: 2.5,  outputPerMillion: 15 },
  'copilot-gpt-5.4-mini':        { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  'copilot-gpt-5.4-nano':        { inputPerMillion: 0.3,  outputPerMillion: 1.2 },
  'copilot-gpt-5.3-codex':       { inputPerMillion: 2.0,  outputPerMillion: 8.0 },
  'copilot-gpt-5-mini':          { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  // Copilot models - Claude Sonnet
  'copilot-claude-sonnet-4.6':   { inputPerMillion: 3,    outputPerMillion: 15 },
  'copilot-claude-sonnet-4.5':   { inputPerMillion: 3,    outputPerMillion: 15 },
  // Copilot models - Claude Opus
  'copilot-claude-opus-4.8':     { inputPerMillion: 15,   outputPerMillion: 75 },
  'copilot-claude-opus-4.7':     { inputPerMillion: 15,   outputPerMillion: 75 },
  'copilot-claude-opus-4.6':     { inputPerMillion: 15,   outputPerMillion: 75 },
  'copilot-claude-opus-4.5':     { inputPerMillion: 15,   outputPerMillion: 75 },
  // Copilot models - Claude Haiku
  'copilot-claude-haiku-4.5':    { inputPerMillion: 0.8,  outputPerMillion: 4.0 },
  // Copilot models - Google Gemini
  'copilot-gemini-3.5-flash':    { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  'copilot-gemini-3.1-pro':      { inputPerMillion: 0.1,   outputPerMillion: 0.4 },
  'copilot-gemini-3-flash':      { inputPerMillion: 0.05,  outputPerMillion: 0.2 },
  'copilot-gemini-2.5-pro':      { inputPerMillion: 0.1,   outputPerMillion: 0.4 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// GitHub Copilot's usage-based billing displays spend as credits. Cost is computed
// internally in USD (above) and converted to credits only for display/input.
export const CREDITS_PER_USD = 100; // 1 credit = $0.01

/** Convert a USD amount to credits (rounded to one decimal) for display. */
export function usdToCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD * 10) / 10;
}

/**
 * Reduce any model identifier to a separator-insensitive comparison key, so the
 * raw forms Copilot emits all collapse onto the same `MODEL_PRICING` key:
 *   "Claude Haiku 4.5 • 1x"     (details display name, pre-split at •)
 *   "claude-haiku-4-5-20251001" (resolvedModel machine id, dated)
 *   "copilot-claude-haiku-4.5"  (pricing table key)
 *   → all become "claudehaiku45"
 */
function canon(model: string): string {
  return model
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '') // ISO date suffix, e.g. gpt-5.4-2026-03-05
    .replace(/-\d{8}$/, '')             // compact date suffix, e.g. …-20251001
    .replace(/[^a-z0-9]/g, '')          // ignore case, spaces, dots, dashes
    .replace(/^copilot/, '');           // drop the vestigial copilot- prefix
}

const CANON_TO_KEY = new Map<string, string>(
  Object.keys(MODEL_PRICING).map(key => [canon(key), key] as const),
);

/** Generic family fallback for an unlisted version. */
function familyKey(c: string): string | null {
  if (c.includes('opus')) return 'claude-opus';
  if (c.includes('sonnet')) return 'claude-sonnet';
  if (c.includes('haiku')) return 'claude-haiku';
  if (c.includes('gemini')) return 'gemini';
  if (c.includes('gpt')) return 'gpt';
  if (/^o\d/.test(c)) return 'o-series'; // o1, o3-mini, o4-mini, …
  return null;
}

/**
 * Resolve a raw model name (from `details` or `resolvedModel`) to a canonical id
 * and its pricing. The id is the matched `MODEL_PRICING` key when one exists, so
 * the same model logged in different forms collapses to one bucket for grouping
 * and `externalId`. Unlisted models fall back to a generic family price (or null).
 */
export function resolveModel(raw: string): { id: string; pricing: PricingEntry | null } {
  const c = canon(raw);
  const key = CANON_TO_KEY.get(c);
  if (key) return { id: key, pricing: MODEL_PRICING[key] };

  const fam = familyKey(c);
  const cleaned = raw
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^copilot-/, '');
  return { id: `copilot-${cleaned}`, pricing: fam ? MODEL_PRICING[fam] : null };
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number | null {
  const { pricing } = resolveModel(model);
  if (!pricing) return null;

  return (inputTokens / 1000000) * pricing.inputPerMillion
       + (outputTokens / 1000000) * pricing.outputPerMillion
       + (cacheCreationTokens / 1000000) * pricing.inputPerMillion * CACHE_WRITE_MULTIPLIER
       + (cacheReadTokens / 1000000) * pricing.inputPerMillion * CACHE_READ_MULTIPLIER;
}
