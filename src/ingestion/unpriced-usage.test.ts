import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseChatSession } from './chat-parser';
import { calculateCost, resolveModel } from '../core/pricing';

function writeDoc(dir: string, name: string, doc: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
  return file;
}

describe('chat-parser: unpriced usage is tracked separately, never fabricated', () => {
  it('calculateCost/resolveModel return null for an unrecognized model/family (no guess)', () => {
    const r = resolveModel('copilot-grok-5-code');
    expect(r.pricing).toBeNull();
    expect(calculateCost('copilot-grok-5-code', 100000, 20000, 0, 0)).toBeNull();
  });

  it('a session using only an unrecognized model is not dropped, and its cost is genuinely excluded rather than zeroed-as-a-guess', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tky-'));
    const ts = 1700000000000;
    const doc = {
      creationDate: ts,
      requests: [{
        responseId: 'r3', timestamp: ts,
        result: {
          // No parseable "N credits" substring in details (imagine a UI/format
          // change, or GitHub simply omitting it for this request type).
          details: 'Grok 5 Code',
          metadata: { responseId: 'r3', promptTokens: 50000, outputTokens: 10000, resolvedModel: 'grok-5-code' },
        },
      }],
    };
    const f = writeDoc(dir, 'unrecognized.json', doc);
    const out = parseChatSession(f, 'unrecognized');

    expect(out).toHaveLength(1);
    // costUsd stays exactly 0 — NOT as a fabricated "this cost nothing", but
    // because unpriced usage is excluded from costUsd entirely and tracked
    // separately in unpricedRequestCount/tokens.
    expect(out[0].costUsd).toBe(0);
    expect(out[0].inputTokens).toBe(0); // priced-only total; excludes the unpriced tokens
    expect(out[0].outputTokens).toBe(0);
    expect(out[0].unpricedRequestCount).toBe(1);
    expect(out[0].unpricedInputTokens).toBe(50000);
    expect(out[0].unpricedOutputTokens).toBe(10000);
  });
});
