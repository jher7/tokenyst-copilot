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
});
