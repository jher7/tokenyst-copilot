import { describe, it, expect } from 'vitest';
import { calculateCost, resolveModel } from './pricing';
import { buildLiveModelPricing } from './live-model-pricing';

describe('live-model-pricing: proposed languageModelPricing support is opt-in, safe-by-default, and easy to enable later', () => {
  it('buildLiveModelPricing silently ignores entries with no numeric inputCost/outputCost — exactly what the published build sees, since it never declares the proposal', () => {
    // This mirrors what vscode.lm.selectChatModels() actually returns for an
    // extension that has NOT been granted the languageModelPricing proposal
    // (i.e. every published Tokenyst build today): the proposed fields are
    // simply absent/undefined, never populated.
    const modelsAsSeenByPublishedBuild = [
      { id: 'claude-sonnet-4-6-20260214', family: 'claude-sonnet-4.6' }, // no inputCost/outputCost
      { id: 'gpt-5-4-20260101', family: 'gpt-5.4', inputCost: undefined, outputCost: undefined },
    ];
    const map = buildLiveModelPricing(modelsAsSeenByPublishedBuild);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('buildLiveModelPricing produces real entries once a build has proposal access (future/experimental build)', () => {
    // Mirrors what a maintainer's local experimental build (enabledApiProposals:
    // ["languageModelPricing"], VS Code run with proposed-API access) would see.
    const modelsWithLivePricing = [
      { id: 'grok-6-code-20270101', family: 'grok-6-code', inputCost: 400, outputCost: 2000 },
    ];
    const map = buildLiveModelPricing(modelsWithLivePricing);
    const { id } = resolveModel('grok-6-code-20270101');
    expect(map[id]).toBeDefined();
    // 400 credits/M input ÷ 100 credits-per-USD = $4/M; 2000 ÷ 100 = $20/M.
    expect(map[id].inputPerMillion).toBeCloseTo(4, 6);
    expect(map[id].outputPerMillion).toBeCloseTo(20, 6);
  });

  it('calculateCost/resolveModel behave IDENTICALLY to before when no livePricing is passed (the default, published-build path)', () => {
    // Regression guard: adding the livePricing parameter must not change any
    // existing behavior for callers that don't pass it — i.e. every current
    // Tokenyst user, on every published version, is completely unaffected.
    expect(calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 6); // built-in table rate
    expect(resolveModel('claude-sonnet-4-6').pricing).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  it("when live pricing IS available for a model, it takes priority over the built-in table (the provider's current rate beats a maintainer-curated snapshot)", () => {
    const livePricing = buildLiveModelPricing([
      { id: 'claude-sonnet-4-6', inputCost: 250, outputCost: 1250 }, // 250cr/M = $2.5/M, 1250cr/M = $12.5/M
    ]);
    const resolved = resolveModel('claude-sonnet-4-6', undefined, livePricing);
    expect(resolved.live).toBe(true);
    expect(resolved.pricing).toEqual({ inputPerMillion: 2.5, outputPerMillion: 12.5 });
    // Built-in table alone (no livePricing) still gives the old snapshot rate —
    // proving live pricing is additive/overriding, not a silent replacement of
    // the table itself.
    expect(resolveModel('claude-sonnet-4-6').pricing).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });
});
