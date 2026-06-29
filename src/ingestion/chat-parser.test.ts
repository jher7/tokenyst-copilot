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
});
