import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseChatSession } from './chat-parser';

function writeDoc(dir: string, name: string, doc: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
  return file;
}

describe('chat-parser: real-credit regex recognizes singular "1 credit" wording', () => {
  it('uses the real GitHub credit value for both plural and singular wording', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tky-'));
    const ts = 1700000000000;

    const docPlural = {
      creationDate: ts,
      requests: [{
        responseId: 'r1', timestamp: ts,
        result: {
          details: 'Claude Sonnet 4.6 \u2022 2 credits',
          metadata: { responseId: 'r1', promptTokens: 1000, outputTokens: 200, resolvedModel: 'claude-sonnet-4-6' },
        },
      }],
    };
    const docSingular = {
      creationDate: ts,
      requests: [{
        responseId: 'r2', timestamp: ts,
        result: {
          details: 'Claude Sonnet 4.6 \u2022 1 credit',
          metadata: { responseId: 'r2', promptTokens: 1000, outputTokens: 200, resolvedModel: 'claude-sonnet-4-6' },
        },
      }],
    };

    const f1 = writeDoc(dir, 'plural.json', docPlural);
    const f2 = writeDoc(dir, 'singular.json', docSingular);

    const outPlural = parseChatSession(f1, 'plural');
    const outSingular = parseChatSession(f2, 'singular');

    // 2 credits / 100 credits-per-USD = $0.02
    expect(outPlural[0].costUsd).toBeCloseTo(0.02, 8);
    // 1 credit / 100 credits-per-USD = $0.01 — previously missed by a
    // plural-only regex and silently repriced from tokens instead.
    expect(outSingular[0].costUsd).toBeCloseTo(0.01, 8);
  });
});
