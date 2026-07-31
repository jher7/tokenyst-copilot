import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseChatSession } from './chat-parser';
import { findSupersededOverrides } from '../core/pricing';

function writeDoc(dir: string, name: string, doc: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
  return file;
}

describe('chat-parser: a manual price override prices an otherwise-unrecognized model', () => {
  it('uses the override instead of leaving the request unpriced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tky-'));
    const ts = 1700000000000;
    const doc = {
      creationDate: ts,
      requests: [{
        responseId: 'r4', timestamp: ts,
        result: {
          details: 'Grok 5 Code',
          metadata: { responseId: 'r4', promptTokens: 1000000, outputTokens: 1000000, resolvedModel: 'grok-5-code' },
        },
      }],
    };
    const f = writeDoc(dir, 'manual.json', doc);
    // Transcribed by the user from the Copilot model picker hover: $3/M in, $15/M out.
    const overrides = { 'copilot-grok-5-code': { inputPerMillion: 3, outputPerMillion: 15, setAt: new Date().toISOString() } };
    const out = parseChatSession(f, 'manual', '', overrides);

    expect(out).toHaveLength(1);
    // 1M input * $3/M + 1M output * $15/M = $18
    expect(out[0].costUsd).toBeCloseTo(18, 6);
    expect(out[0].hasManualPricing).toBe(true);
    expect(out[0].unpricedRequestCount).toBeUndefined();
  });
});

describe('pricing: findSupersededOverrides detects when official pricing catches up', () => {
  it('flags an override as superseded once the built-in table gains a match, and leaves an unrelated one alone', () => {
    const overrides = {
      // This id doesn't exist in MODEL_PRICING and matches no family substring —
      // stays un-superseded.
      'copilot-totally-unknown-vendor-model': { inputPerMillion: 1, outputPerMillion: 2, setAt: 'x' },
      // This id DOES match the 'gpt' family fallback already in MODEL_PRICING —
      // simulates the maintainer shipping (or the family regex already covering)
      // official pricing after the user transcribed a manual price for it.
      'copilot-some-new-gpt-5-9-snapshot': { inputPerMillion: 999, outputPerMillion: 999, setAt: 'x' },
    };
    const superseded = findSupersededOverrides(overrides);
    const ids = superseded.map(s => s.id);
    expect(ids).toContain('copilot-some-new-gpt-5-9-snapshot');
    expect(ids).not.toContain('copilot-totally-unknown-vendor-model');
    const gptEntry = superseded.find(s => s.id === 'copilot-some-new-gpt-5-9-snapshot')!;
    expect(gptEntry.manual.inputPerMillion).toBe(999); // the stale user-entered number
    expect(gptEntry.official.inputPerMillion).toBeLessThan(999); // the real, now-available rate
  });
});
