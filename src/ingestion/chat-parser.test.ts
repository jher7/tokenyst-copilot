import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getVSCodeUserDir, setVSCodeUserDir, parseChatSession } from './chat-parser';

const ENV_KEY = 'TOKENYST_VSCODE_USER_DIR';

describe('getVSCodeUserDir precedence', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    setVSCodeUserDir(undefined);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    setVSCodeUserDir(undefined);
  });

  it('prefers the env override above all else', () => {
    process.env[ENV_KEY] = '/tmp/env-dir';
    setVSCodeUserDir('/tmp/injected-dir');
    expect(getVSCodeUserDir()).toBe('/tmp/env-dir');
  });

  it('uses the injected dir when no env override is set', () => {
    setVSCodeUserDir('/tmp/injected-dir');
    expect(getVSCodeUserDir()).toBe('/tmp/injected-dir');
  });

  it('falls back to the platform default when neither is set', () => {
    // Build-name folder differs per build but the default always ends with
    // <BuildName>/User; assert it resolves to a "Code"/User path on this platform.
    const dir = getVSCodeUserDir();
    expect(dir.endsWith(path.join('Code', 'User'))).toBe(true);
  });
});

describe('parseChatSession session id + title', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenyst-chat-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function write(name: string, doc: object): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
    return file;
  }

  const request = (text: string) => ({
    message: { text },
    responseId: 'r1',
    resolvedModel: 'claude-haiku-4.5',
    details: 'Claude Haiku 4.5 • 2 credits',
    usage: { promptTokens: 1000, completionTokens: 200 },
    completedAt: 1700000000000,
  });

  it('scrapes the first user prompt as the session title and sets the session id', () => {
    const file = write('sess-1.json', { requests: [request('Add a session breakdown to the analytics view')] });
    const out = parseChatSession(file, 'sess-1');
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('sess-1');
    expect(out[0].title).toBe('Add a session breakdown to the analytics view');
    expect(out[0].externalId).toMatch(/^copilot-chat-sess-1-/);
  });

  it('truncates long prompts and collapses whitespace', () => {
    const long = 'Please   refactor\nthe   entire ingestion pipeline so that it handles both the chat and the cli sources uniformly';
    const file = write('sess-2.json', { requests: [request(long)] });
    const out = parseChatSession(file, 'sess-2');
    expect(out[0].title!.length).toBeLessThanOrEqual(80);
    expect(out[0].title!.endsWith('…')).toBe(true);
    expect(out[0].title).not.toContain('\n');
    expect(out[0].title).not.toContain('  ');
  });

  // Newer VS Code builds persist only aggregate promptTokens/outputTokens (the
  // shape on disk: a `metadata` object with no `promptTokenDetails`). With no
  // per-category breakdown the cache split is unknown, so it must surface as null
  // ("not reported") rather than a misleading zero.
  it('reports null cache tokens when the session carries no prompt breakdown', () => {
    const file = write('sess-3.json', { requests: [request('How does the test suite work?')] });
    const out = parseChatSession(file, 'sess-3');
    expect(out).toHaveLength(1);
    expect(out[0].cacheCreationTokens).toBeNull();
    expect(out[0].cacheReadTokens).toBeNull();
    // Input/output are still counted — only the cache split is unknown.
    expect(out[0].inputTokens).toBe(1000);
    expect(out[0].outputTokens).toBe(200);
  });

  // When a request does carry a promptTokenDetails breakdown, the cache split is
  // known and reported as numbers. Use a token-priced request (no credit details)
  // so the System portion is written to cache by the first request.
  it('reports numeric cache tokens when a prompt breakdown is present', () => {
    const priced = {
      message: { text: 'Explain caching' },
      responseId: 'r1',
      resolvedModel: 'claude-haiku-4.5',
      usage: {
        promptTokens: 1000,
        completionTokens: 200,
        promptTokenDetails: [{ category: 'System', percentageOfPrompt: 30 }],
      },
      completedAt: 1700000000000,
    };
    const file = write('sess-4.json', { requests: [priced] });
    const out = parseChatSession(file, 'sess-4');
    expect(out).toHaveLength(1);
    // 30% of 1000 is the cacheable System block; the first request writes it.
    expect(out[0].cacheCreationTokens).toBe(300);
    expect(out[0].cacheReadTokens).toBe(0);
  });

  it('keeps credit-only responses (no tokens) so compacted history is not under-counted', () => {
    const doc = {
      requests: [
        {
          message: { text: 'first' },
          responseId: 'r1',
          resolvedModel: 'claude-haiku-4.5',
          details: 'Claude Haiku 4.5 • 2 credits',
          usage: { promptTokens: 1000, completionTokens: 200 },
          completedAt: 1700000000000,
        },
        {
          responseId: 'r2',
          details: 'Claude Haiku 4.5 • 3 credits',
          completedAt: 1700000100000,
        },
      ],
    };
    const file = write('sess-5.json', doc);
    const out = parseChatSession(file, 'sess-5');
    expect(out).toHaveLength(1);
    // 2 + 3 credits = 5 credits total.
    expect(out[0].costUsd).toBeCloseTo(0.05, 8);
    expect(out[0].requests?.length).toBe(2);
  });

  it('exposes per-request completion timestamps for downstream daily attribution', () => {
    const file = write('sess-6.json', {
      requests: [
        {
          message: { text: 'a' },
          responseId: 'r1',
          resolvedModel: 'claude-haiku-4.5',
          details: 'Claude Haiku 4.5 • 1 credits',
          usage: { promptTokens: 10, completionTokens: 10 },
          completedAt: 1700000000000,
        },
        {
          message: { text: 'b' },
          responseId: 'r2',
          resolvedModel: 'claude-haiku-4.5',
          details: 'Claude Haiku 4.5 • 1 credits',
          usage: { promptTokens: 10, completionTokens: 10 },
          completedAt: 1700086400000,
        },
      ],
    });
    const out = parseChatSession(file, 'sess-6');
    expect(out).toHaveLength(1);
    const ts = (out[0].requests ?? []).map(r => r.completedAtMs).sort((a, b) => a - b);
    expect(ts).toEqual([1700000000000, 1700086400000]);
  });

  // In the JSONL delta format the credit string (details) and the token usage often
  // arrive in separate delta objects for the same responseId. The token-usage delta
  // carries `completedAt`; the credit-only delta does not. The real timestamp must
  // survive the merge — a credit-only delta must never overwrite it with Date.now().
  it('preserves the real timestamp when credits and tokens arrive in separate deltas', () => {
    // Simulate a JSONL file: two separate lines share the same responseId. The first
    // line has the token usage + timestamp; the second has only the credit string.
    const raw = [
      JSON.stringify({
        message: { text: 'What is 2+2?' },
        responseId: 'r1',
        resolvedModel: 'claude-haiku-4.5',
        usage: { promptTokens: 100, completionTokens: 20 },
        completedAt: 1700000000000,
      }),
      JSON.stringify({
        responseId: 'r1',
        details: 'Claude Haiku 4.5 • 2 credits',
        // deliberately no completedAt — this is the bug trigger
      }),
    ].join('\n');

    const file = path.join(dir, 'sess-7.jsonl');
    fs.writeFileSync(file, raw, 'utf8');

    const out = parseChatSession(file, 'sess-7');
    expect(out).toHaveLength(1);
    // The real timestamp from the token-usage delta must be preserved.
    expect(out[0].requests).toHaveLength(1);
    expect(out[0].requests![0].completedAtMs).toBe(1700000000000);
    // Credits should still be counted correctly.
    expect(out[0].costUsd).toBeCloseTo(0.02, 8); // 2 credits / 100 credits-per-USD
  });

  // In the real VS Code JSONL agent-mode format, usage data lives in result.metadata
  // (with responseId, promptTokens, outputTokens, resolvedModel) while the credit
  // string lives in result.details. Completion timestamps live in
  // result.metadata.toolCallRounds[N].timestamp. The last round timestamp must be
  // used as completedAtMs so multi-day splitting attributes requests to the correct day.
  it('uses the last toolCallRound timestamp for completedAtMs in agent-mode result format', () => {
    const ts1 = 1700000000000; // request on day 1
    const ts2 = 1700086400000; // request on day 2

    const doc = {
      creationDate: ts1,
      requests: [
        {
          responseId: 'outer-r1',  // outer responseId — NOT the record key
          timestamp: ts1,
          completionTokens: 100,
          result: {
            details: 'Claude Haiku 4.5 • 3 credits',
            metadata: {
              responseId: 'inner-r1',  // this IS the record key
              promptTokens: 500,
              outputTokens: 100,
              resolvedModel: 'claude-haiku-4-5-20251001',
              toolCallRounds: [
                { timestamp: ts1 - 5000, id: 'round-0' },
                { timestamp: ts1,        id: 'round-1' },
              ],
            },
          },
        },
        {
          responseId: 'outer-r2',
          timestamp: ts2,
          completionTokens: 50,
          result: {
            details: 'Claude Haiku 4.5 • 2 credits',
            metadata: {
              responseId: 'inner-r2',
              promptTokens: 200,
              outputTokens: 50,
              resolvedModel: 'claude-haiku-4-5-20251001',
              toolCallRounds: [
                { timestamp: ts2, id: 'round-0' },
              ],
            },
          },
        },
      ],
    };

    const file = write('sess-8.json', doc);
    const out = parseChatSession(file, 'sess-8');
    expect(out).toHaveLength(1);
    const reqTs = (out[0].requests ?? []).map(r => r.completedAtMs).sort((a, b) => a - b);
    // Each request's completedAtMs must come from its last toolCallRound, not Date.now().
    expect(reqTs).toEqual([ts1, ts2]);
    // Credits must also be captured correctly from result.details.
    expect(out[0].costUsd).toBeCloseTo(0.05, 8); // (3 + 2) credits / 100
  });
});
