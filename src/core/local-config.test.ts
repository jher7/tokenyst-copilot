import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// Deterministically point os.homedir() at a per-test temp dir so the suite never
// touches the real ~/.tokenyst/config.json. A hoisted holder is shared with the
// mock factory (which is hoisted above module init), so per-test reassignment is
// visible to the mocked homedir(). USERPROFILE/HOME env overrides are unreliable
// for os.homedir() on Windows.
const holder = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => holder.home };
});

// ESM forbids spying on a module's named exports, so wrap fs.rename in a vi.fn whose default
// implementation passes through to the real rename. Tests that exercise the EPERM retry swap
// in a failing implementation; `fsHolder.realRename` lets them fall back to the real op.
const fsHolder = vi.hoisted(() => ({ realRename: (_f: any, _t: any): Promise<void> => Promise.resolve() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  fsHolder.realRename = actual.rename;
  return { ...actual, default: actual, rename: vi.fn((from: any, to: any) => actual.rename(from, to)) };
});

import {
  recordLocalAllocation,
  loadConfig,
  saveConfig,
  mutateConfig,
  upsertCopilotSessionAllocation,
  getCurrentPeriod,
  getConfigPath,
  allocationSource,
  type LocalConfig,
  type LocalAllocation,
} from './local-config';

describe('allocationSource', () => {
  const base: LocalAllocation = {
    costUsd: 1, model: 'copilot-gpt-5-mini',
    inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0,
    filesModified: [], at: '2026-05-01T00:00:00.000Z', provider: 'copilot',
  };

  it('uses the explicit source field when present', () => {
    expect(allocationSource({ ...base, source: 'cli' })).toBe('cli');
    expect(allocationSource({ ...base, source: 'chat' })).toBe('chat');
  });

  it('derives cli from the externalId namespace when source is absent', () => {
    expect(allocationSource({ ...base, externalId: 'copilot-cli-abc-copilot-gpt-5-mini' })).toBe('cli');
  });

  it('defaults to chat for legacy/untagged and chat-namespaced entries', () => {
    expect(allocationSource(base)).toBe('chat');
    expect(allocationSource({ ...base, externalId: 'copilot-chat-xyz-copilot-gpt-5-mini' })).toBe('chat');
    expect(allocationSource({ ...base, externalId: 'manual-123-abcde' })).toBe('chat');
  });
});

describe('getCurrentPeriod', () => {
  const ymd = (d: Date) => [d.getFullYear(), d.getMonth(), d.getDate()];

  it('defaults to the calendar month when renewalDay is unset', () => {
    const p = getCurrentPeriod(null, new Date(2026, 4, 15)); // May 15, 2026
    expect(ymd(p.start)).toEqual([2026, 4, 1]);  // May 1
    expect(ymd(p.end)).toEqual([2026, 5, 1]);    // Jun 1
    expect(p.renewalDay).toBeNull();
  });

  it('anchors to this month when now is on/after the renewal day', () => {
    const p = getCurrentPeriod(15, new Date(2026, 4, 20)); // May 20
    expect(ymd(p.start)).toEqual([2026, 4, 15]); // May 15
    expect(ymd(p.end)).toEqual([2026, 5, 15]);   // Jun 15
    expect(p.renewalDay).toBe(15);
  });

  it('anchors to the previous month when now is before the renewal day', () => {
    const p = getCurrentPeriod(15, new Date(2026, 4, 10)); // May 10
    expect(ymd(p.start)).toEqual([2026, 3, 15]); // Apr 15
    expect(ymd(p.end)).toEqual([2026, 4, 15]);   // May 15
  });

  it('clamps a day-31 renewal to a short month (Feb 2026 → 28)', () => {
    const p = getCurrentPeriod(31, new Date(2026, 1, 10)); // Feb 10, 2026 (28-day month)
    expect(ymd(p.start)).toEqual([2026, 0, 31]); // Jan 31 (prev anchor)
    expect(ymd(p.end)).toEqual([2026, 1, 28]);   // Feb 28 (clamped)
  });

  it('clamps the period end to a short following month', () => {
    const p = getCurrentPeriod(31, new Date(2026, 2, 31)); // Mar 31
    expect(ymd(p.start)).toEqual([2026, 2, 31]); // Mar 31
    expect(ymd(p.end)).toEqual([2026, 3, 30]);   // Apr 30 (clamped)
  });

  it('rolls the year over at December', () => {
    const p = getCurrentPeriod(10, new Date(2026, 11, 20)); // Dec 20
    expect(ymd(p.start)).toEqual([2026, 11, 10]); // Dec 10
    expect(ymd(p.end)).toEqual([2027, 0, 10]);    // Jan 10, 2027
  });
});

describe('recordLocalAllocation', () => {
  beforeEach(async () => {
    holder.home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenyst-test-'));
  });

  afterEach(async () => {
    await fs.rm(holder.home, { recursive: true, force: true });
  });

  it('honors a provided `at` timestamp (historical import)', async () => {
    const at = '2026-05-01T08:00:00.000Z';
    const res = await recordLocalAllocation({
      costUsd: 0.5,
      model: 'copilot-claude-sonnet-4',
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      filesModified: [],
      provider: 'copilot',
      externalId: 'copilot-req-1',
      at,
    });
    expect(res.success).toBe(true);
    expect(res.deduped).toBeFalsy();

    const cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(1);
    expect(cfg.allocations[0].at).toBe(at);
  });

  it('defaults `at` to now when omitted (live sync)', async () => {
    const before = Date.now();
    await recordLocalAllocation({
      costUsd: 0.5,
      model: 'copilot-gpt-4o',
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      filesModified: [],
      provider: 'copilot',
      externalId: 'copilot-req-2',
    });
    const cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(1);
    const at = new Date(cfg.allocations[0].at).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('dedupes by externalId and reports it (idempotent re-import)', async () => {
    const session = {
      costUsd: 0.5,
      model: 'copilot-claude-sonnet-4',
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      filesModified: [],
      provider: 'copilot' as const,
      externalId: 'copilot-req-3',
      at: '2026-05-01T08:00:00.000Z',
    };
    await recordLocalAllocation(session);
    const second = await recordLocalAllocation(session);
    expect(second.success).toBe(true);
    expect(second.deduped).toBe(true);

    const cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(1);
  });
});

describe('concurrent config writes do not disable tracking', () => {
  beforeEach(async () => {
    holder.home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenyst-test-'));
    // Seed an enabled-tracking config, like enableTracking would.
    const seed: LocalConfig = {
      allocations: [],
      enabled: true,
      copilot: { enabled: true, lastSeenEventsAt: new Date().toISOString() },
    };
    await saveConfig(seed);
  });

  afterEach(async () => {
    await fs.rm(holder.home, { recursive: true, force: true });
  });

  it('keeps copilot.enabled and all allocations under a burst of concurrent writers', async () => {
    // Mirror the import loop (many per-allocation upserts) racing the watermark write.
    const upserts = Array.from({ length: 25 }, (_, i) =>
      upsertCopilotSessionAllocation({
        costUsd: 0.1,
        model: 'copilot-gpt-4o',
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        filesModified: [],
        provider: 'copilot',
        externalId: `copilot-chat-s${i}-gpt-4o`,
        at: '2026-05-01T08:00:00.000Z',
      }),
    );
    const watermarks = Array.from({ length: 10 }, () =>
      mutateConfig((cfg) => {
        if (cfg.copilot) cfg.copilot.lastSeenEventsAt = new Date().toISOString();
      }),
    );
    await Promise.all([...upserts, ...watermarks]);

    const cfg = await loadConfig();
    expect(cfg.copilot?.enabled).toBe(true);
    expect(cfg.allocations).toHaveLength(25);
  });
});

describe('upsertCopilotSessionAllocation persists sessionId and title', () => {
  beforeEach(async () => {
    holder.home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenyst-test-'));
    await saveConfig({ allocations: [], enabled: true, copilot: { enabled: true } });
  });
  afterEach(async () => { await fs.rm(holder.home, { recursive: true, force: true }); });

  const base = {
    costUsd: 0.1, model: 'copilot-gpt-4o',
    inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0,
    filesModified: [], provider: 'copilot' as const,
    externalId: 'copilot-chat-s1-gpt-4o', at: '2026-05-01T08:00:00.000Z',
  };

  it('stores sessionId/title on insert and refreshes them on re-upsert', async () => {
    await upsertCopilotSessionAllocation({ ...base, sessionId: 's1', title: 'First prompt' });
    let cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(1);
    expect(cfg.allocations[0].sessionId).toBe('s1');
    expect(cfg.allocations[0].title).toBe('First prompt');

    // Same externalId → overwrite in place; an updated title is refreshed.
    await upsertCopilotSessionAllocation({ ...base, sessionId: 's1', title: 'Renamed prompt' });
    cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(1);
    expect(cfg.allocations[0].title).toBe('Renamed prompt');
  });

  it('replaces a legacy base externalId when dated chat allocations are inserted', async () => {
    const legacyId = 'copilot-chat-s1-gpt-4o';
    await upsertCopilotSessionAllocation({ ...base, externalId: legacyId, title: 'Legacy entry' });
    await upsertCopilotSessionAllocation({
      ...base,
      externalId: `${legacyId}-20260501`,
      title: 'Daily split entry',
    });

    const cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(1);
    expect(cfg.allocations[0].externalId).toBe(`${legacyId}-20260501`);
    expect(cfg.allocations[0].title).toBe('Daily split entry');
  });
});

describe('saveConfig retries a transient rename failure (Windows EPERM)', () => {
  const renameMock = vi.mocked(fs.rename);

  beforeEach(async () => {
    holder.home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenyst-test-'));
    renameMock.mockClear();
  });

  afterEach(async () => {
    // Restore the default pass-through so later describe blocks get a working rename.
    renameMock.mockImplementation((from: any, to: any) => fsHolder.realRename(from, to));
    await fs.rm(holder.home, { recursive: true, force: true });
  });

  const epermError = () => Object.assign(new Error('operation not permitted, rename'), { code: 'EPERM' });

  it('retries on EPERM then succeeds, persisting the config', async () => {
    let calls = 0;
    renameMock.mockImplementation((from: any, to: any) => {
      calls++;
      if (calls <= 2) return Promise.reject(epermError()); // fail twice, then let it through
      return fsHolder.realRename(from, to);
    });

    await saveConfig({ allocations: [], enabled: true, copilot: { enabled: true } });
    expect(calls).toBe(3);

    const cfg = await loadConfig();
    expect(cfg.copilot?.enabled).toBe(true);
  });

  it('gives up and rethrows when EPERM persists past every retry', async () => {
    renameMock.mockRejectedValue(epermError());
    await expect(
      saveConfig({ allocations: [], enabled: true }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    // 1 initial attempt + 4 backoff retries.
    expect(renameMock).toHaveBeenCalledTimes(5);
  });

  it('does not retry a non-transient error (rethrows immediately)', async () => {
    renameMock.mockRejectedValue(Object.assign(new Error('no space left'), { code: 'ENOSPC' }));
    await expect(
      saveConfig({ allocations: [], enabled: true }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});

describe('loadConfig with a corrupt file', () => {
  beforeEach(async () => {
    holder.home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenyst-test-'));
  });

  afterEach(async () => {
    await fs.rm(holder.home, { recursive: true, force: true });
  });

  it('throws and moves the file aside instead of falling back to a copilot-less default', async () => {
    const configDir = path.dirname(getConfigPath());
    await fs.mkdir(configDir, { recursive: true });
    // Truncated JSON — what a torn read of a half-written file looks like.
    await fs.writeFile(getConfigPath(), '{ "allocations": [], "copilot": { "enab', 'utf8');

    await expect(loadConfig()).rejects.toThrow(/unreadable/);

    const files = await fs.readdir(configDir);
    expect(files.some((f) => f.startsWith('config.json.corrupt-'))).toBe(true);
    // The corrupt file is moved aside, not copied — config.json is gone.
    expect(files).not.toContain('config.json');
  });

  it('self-heals on the next load after a corrupt file is moved aside', async () => {
    const configDir = path.dirname(getConfigPath());
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(getConfigPath(), '{ "allocations": [], "copilot": { "enab', 'utf8');

    await expect(loadConfig()).rejects.toThrow();
    // Next read no longer throws — file was moved aside, so this is treated as fresh.
    const cfg = await loadConfig();
    expect(cfg.allocations).toEqual([]);
  });

  it('returns defaults when the file is genuinely missing (fresh install)', async () => {
    const cfg = await loadConfig();
    expect(cfg.allocations).toEqual([]);
    expect(cfg.copilot).toBeUndefined();
  });
});
