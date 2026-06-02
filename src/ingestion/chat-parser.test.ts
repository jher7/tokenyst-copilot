import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { getVSCodeUserDir, setVSCodeUserDir } from './chat-parser';

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
