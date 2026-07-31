import { resolveModel, CREDITS_PER_USD, type PricingEntry } from './pricing';

/**
 * Structural mirror of the fields VS Code's *proposed, unstable*
 * `languageModelPricing` API (`vscode.proposed.languageModelPricing.d.ts`) adds
 * to `LanguageModelChat` / `LanguageModelChatInformation`. Defined locally
 * (rather than importing the proposed .d.ts) so this module has zero compile-
 * time dependency on that proposal — it only needs whatever shape of object the
 * caller hands it, which keeps it plain, unit-testable, and safe to keep in the
 * Marketplace build even though the proposal itself isn't declared there.
 *
 * IMPORTANT: this is NOT wired into Tokenyst's default pricing path, and this
 * package does NOT declare `enabledApiProposals: ["languageModelPricing"]` in
 * package.json — doing so would make the extension unpublishable per VS Code's
 * own rules (a proposed-API extension "cannot be published", per vscode-dts's
 * own README). Concretely:
 *
 *   - In the published Marketplace build, `vscode.lm.selectChatModels()` never
 *     populates `inputCost`/`outputCost` for this extension (the host doesn't
 *     grant it access to the proposal), so `buildLiveModelPricing` below always
 *     returns an empty map — a safe, silent no-op.
 *   - A maintainer who wants to experiment locally (not for publishing) can add
 *     `"enabledApiProposals": ["languageModelPricing"]` to package.json and run
 *     VS Code Insiders with proposed-API access enabled for this extension id.
 *     With that one change, `LanguageModelChat` objects returned by
 *     `vscode.lm.selectChatModels()` will actually carry `inputCost`/
 *     `outputCost`, and this same code starts producing real entries — no
 *     other code changes needed.
 *   - Once `languageModelPricing` graduates to VS Code's *stable* API, this
 *     whole conditional-availability story goes away: the fields are simply
 *     always there, `enabledApiProposals` is deleted, and
 *     `tokenyst.experimental.useLiveModelPricing` can default to `true`.
 *
 * Gated end-to-end behind the (default `false`) `tokenyst.experimental.
 * useLiveModelPricing` setting — see extension.ts / package.json.
 */
export interface LiveModelPricingSource {
  /** Opaque model identifier, e.g. `claude-sonnet-4-6-20260214`. */
  id?: string;
  /** Opaque family name, e.g. `claude-sonnet-4.6`. Used when `id` doesn't
   * resolve to anything recognizable. */
  family?: string;
  /** AI credits per million input tokens, when the host grants pricing access. */
  inputCost?: number;
  /** AI credits per million output tokens, when the host grants pricing access. */
  outputCost?: number;
}

/**
 * Build a `{ canonicalModelId: PricingEntry }` map from whatever
 * `vscode.lm.selectChatModels()` returned, keeping only entries that actually
 * carry numeric `inputCost`/`outputCost` (i.e. where the proposal is actually
 * granted — see the module doc comment). Pure and synchronous so it's trivially
 * unit-testable without a real VS Code host: callers pass in already-fetched
 * model info rather than this module calling `vscode.lm` itself.
 *
 * `inputCost`/`outputCost` are denominated in AI credits per million tokens
 * (per the proposal's doc comments), so they're converted to USD here to match
 * the unit `PricingEntry` uses everywhere else in Tokenyst.
 */
export function buildLiveModelPricing(
  models: readonly LiveModelPricingSource[],
): Record<string, PricingEntry> {
  const out: Record<string, PricingEntry> = {};
  for (const m of models) {
    if (typeof m.inputCost !== 'number' || typeof m.outputCost !== 'number') continue;
    if (!Number.isFinite(m.inputCost) || !Number.isFinite(m.outputCost)) continue;
    const raw = m.id || m.family;
    if (!raw) continue;
    const { id } = resolveModel(raw);
    out[id] = {
      inputPerMillion: m.inputCost / CREDITS_PER_USD,
      outputPerMillion: m.outputCost / CREDITS_PER_USD,
    };
  }
  return out;
}
