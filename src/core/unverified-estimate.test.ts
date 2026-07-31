import { describe, it, expect } from 'vitest';
import { estimateUnverifiedSpendUsd } from './pricing';

describe('pricing: estimateUnverifiedSpendUsd is opt-in-only arithmetic, never authoritative', () => {
  it('is a pure function, separate from calculateCost/parseChatSession — never invoked unless the caller explicitly asks', () => {
    // The whole point: parseChatSession itself must NEVER call this function or
    // fold its result into costUsd (verified in unpriced-usage.test.ts: an
    // unrecognized-model session has costUsd === 0, not some guessed positive
    // number). Here we just confirm the estimate function computes a plausible,
    // clearly-separate figure that a UI *could* choose to show once the user
    // opts in via `LocalConfig.showUnverifiedEstimates`.
    const estimate = estimateUnverifiedSpendUsd(1_000_000, 1_000_000);
    expect(estimate).toBeGreaterThan(0);
  });

  it('scales linearly with token counts (no hidden minimums/discounts)', () => {
    const small = estimateUnverifiedSpendUsd(1000, 1000);
    const large = estimateUnverifiedSpendUsd(1_000_000, 1_000_000);
    expect(large).toBeCloseTo(small * 1000, 6);
  });
});
