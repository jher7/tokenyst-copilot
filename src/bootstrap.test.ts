import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { CopilotSessionUsage } from './ingestion/chat-parser';

// Point os.homedir() at a per-test temp dir (same pattern as local-config.test.ts) so the
// suite never touches the real ~/.tokenyst/config.json.
const holder = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => holder.home };
});

// ESM forbids spying on named exports; wrap fs.rename in a pass-through vi.fn so the batching
// test can count how many atomic renames the import performs.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, default: actual, rename: vi.fn((from: any, to: any) => actual.rename(from, to)) };
});

// Drive importHistory from in-memory fixtures instead of real session files on disk.
const fixtures = vi.hoisted(() => ({ chat: [] as CopilotSessionUsage[] }));
vi.mock('./ingestion/chat-parser', () => ({
  findChatSessionFiles: () => (fixtures.chat.length ? [{ file: 'f', sessionId: 's', workspaceHash: 'w', mtimeMs: 0 }] : []),
  parseChatSession: () => fixtures.chat,
}));
vi.mock('./ingestion/cli-parser', () => ({
  findCliSessionFiles: () => [],
  parseCliSession: () => [],
}));

import { importHistory } from './bootstrap';
import { loadConfig } from './core/local-config';

function usage(i: number, ts: string, costUsd = 0.1): CopilotSessionUsage {
  return {
    sessionId: `s${i}`,
    model: 'copilot-gpt-4o',
    costUsd,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    timestamp: ts,
    externalId: `copilot-chat-s${i}-gpt-4o`,
  };
}

describe('importHistory', () => {
  beforeEach(async () => {
    holder.home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenyst-test-'));
    fixtures.chat = [];
  });

  afterEach(async () => {
    vi.mocked(fs.rename).mockClear();
    await fs.rm(holder.home, { recursive: true, force: true });
  });

  it('writes config once for the whole import, not once per session', async () => {
    fixtures.chat = Array.from({ length: 12 }, (_, i) => usage(i, '2026-05-01T08:00:00.000Z'));
    vi.mocked(fs.rename).mockClear();

    const recorded = await importHistory(null);

    expect(recorded).toBe(12);
    // A single load→apply-all→save cycle ⇒ exactly one atomic rename.
    expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);

    const cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(12);
  });

  it('skips zero-cost usages and respects the `since` window', async () => {
    fixtures.chat = [
      usage(1, '2026-05-10T00:00:00.000Z', 0.5),  // in window, billable
      usage(2, '2026-05-10T00:00:00.000Z', 0),    // in window, zero-cost → skipped
      usage(3, '2026-01-01T00:00:00.000Z', 0.5),  // before window → skipped
    ];

    const recorded = await importHistory('2026-05-01T00:00:00.000Z');

    expect(recorded).toBe(1);
    const cfg = await loadConfig();
    expect(cfg.allocations.map(a => a.externalId)).toEqual(['copilot-chat-s1-gpt-4o']);
  });

  it('is idempotent: a second import upserts in place without duplicating', async () => {
    fixtures.chat = [usage(1, '2026-05-01T08:00:00.000Z'), usage(2, '2026-05-01T08:00:00.000Z')];

    const first = await importHistory(null);
    const second = await importHistory(null);

    expect(first).toBe(2);
    expect(second).toBe(0); // both already present → upserted, nothing newly inserted
    const cfg = await loadConfig();
    expect(cfg.allocations).toHaveLength(2);
  });
});
