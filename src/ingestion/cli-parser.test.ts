import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getCopilotCliDir, findCliSessionFiles, parseCliSession } from './cli-parser';

const ENV_KEY = 'TOKENYST_COPILOT_CLI_DIR';

function shutdown(modelMetrics: object, timestamp: string): string {
  return JSON.stringify({ type: 'session.shutdown', timestamp, data: { modelMetrics } });
}

function usage(over: Partial<Record<string, number>>): object {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    ...over,
  };
}

describe('getCopilotCliDir precedence', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = saved; });

  it('prefers the env override', () => {
    process.env[ENV_KEY] = '/tmp/cli-dir';
    expect(getCopilotCliDir()).toBe('/tmp/cli-dir');
  });

  it('falls back to ~/.copilot', () => {
    expect(getCopilotCliDir()).toBe(path.join(os.homedir(), '.copilot'));
  });
});

describe('findCliSessionFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenyst-cli-'));
    process.env[ENV_KEY] = dir;
  });
  afterEach(() => { delete process.env[ENV_KEY]; fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns [] when the CLI dir is absent', () => {
    process.env[ENV_KEY] = path.join(dir, 'does-not-exist');
    expect(findCliSessionFiles()).toEqual([]);
  });

  it('locates events.jsonl per session and skips dirs without one', () => {
    const a = path.join(dir, 'session-state', 'sess-a');
    const b = path.join(dir, 'session-state', 'sess-b'); // no events.jsonl
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'events.jsonl'), shutdown({}, '2026-05-28T14:41:44.798Z') + '\n');

    const found = findCliSessionFiles();
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('sess-a');
  });
});

describe('parseCliSession', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenyst-cli-'));
    process.env[ENV_KEY] = dir;
  });
  afterEach(() => { delete process.env[ENV_KEY]; fs.rmSync(dir, { recursive: true, force: true }); });

  function writeSession(id: string, lines: string[]): string {
    const sdir = path.join(dir, 'session-state', id);
    fs.mkdirSync(sdir, { recursive: true });
    const file = path.join(sdir, 'events.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  it('sums incremental shutdown payloads per model and prices from tokens', () => {
    const id = 'sess-1';
    const file = writeSession(id, [
      // Noise events that must be ignored.
      JSON.stringify({ type: 'session.start', timestamp: '2026-05-28T14:41:35.702Z', data: {} }),
      JSON.stringify({ type: 'assistant.message', timestamp: '2026-05-28T14:41:40.000Z', data: { outputTokens: 50 } }),
      // Two incremental shutdowns for gpt-5-mini (NOT cumulative).
      shutdown({ 'gpt-5-mini': { usage: usage({ inputTokens: 1000, outputTokens: 100 }) } }, '2026-05-28T14:41:44.798Z'),
      shutdown({ 'gpt-5-mini': { usage: usage({ inputTokens: 2000, outputTokens: 200, cacheReadTokens: 500 }) } }, '2026-05-28T14:42:21.984Z'),
      // A second model in a later shutdown, plus reasoning tokens.
      shutdown({ 'claude-haiku-4.5': { usage: usage({ inputTokens: 800, outputTokens: 40, reasoningTokens: 10 }) } }, '2026-05-28T14:47:32.688Z'),
    ]);

    const records = parseCliSession(file, id);
    expect(records).toHaveLength(2);

    const gpt = records.find(r => r.model === 'copilot-gpt-5-mini')!;
    expect(gpt).toBeDefined();
    expect(gpt.inputTokens).toBe(3000);          // 1000 + 2000 summed
    expect(gpt.outputTokens).toBe(300);          // 100 + 200
    expect(gpt.cacheReadTokens).toBe(500);
    expect(gpt.externalId).toBe(`copilot-cli-${id}-copilot-gpt-5-mini`);
    expect(gpt.costUsd).toBeGreaterThan(0);

    const haiku = records.find(r => r.model === 'copilot-claude-haiku-4.5')!;
    expect(haiku.outputTokens).toBe(50);          // reasoning folded into output (40 + 10)

    // Timestamp is the latest event in the file.
    expect(gpt.timestamp).toBe('2026-05-28T14:47:32.688Z');
  });

  it('returns [] for a file with no shutdown/usage events', () => {
    const file = writeSession('sess-empty', [
      JSON.stringify({ type: 'session.start', timestamp: '2026-05-28T14:41:35.702Z', data: {} }),
    ]);
    expect(parseCliSession(file, 'sess-empty')).toEqual([]);
  });

  it('returns [] when the file does not exist', () => {
    expect(parseCliSession(path.join(dir, 'nope', 'events.jsonl'), 'nope')).toEqual([]);
  });
});
