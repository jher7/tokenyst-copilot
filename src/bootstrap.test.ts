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

function usageWithRequests(sessionId: string): CopilotSessionUsage {
  return {
    sessionId,
    model: 'copilot-gpt-4o',
    costUsd: 0.3,
    inputTokens: 3,
    outputTokens: 3,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    timestamp: '2026-05-02T12:00:00.000Z',
    externalId: `copilot-chat-${sessionId}-copilot-gpt-4o`,
    requests: [
      {
        responseId: 'r1',
        completedAtMs: Date.parse('2026-05-01T22:00:00.000Z'),
        costUsd: 0.1,
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        responseId: 'r2',
        completedAtMs: Date.parse('2026-05-02T08:00:00.000Z'),
        costUsd: 0.2,
        inputTokens: 2,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ],
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

  it('splits chat usage by calendar day when per-request timestamps are present', async () => {
    fixtures.chat = [usageWithRequests('multi-day')];

    const recorded = await importHistory(null);

    expect(recorded).toBe(2);
    const cfg = await loadConfig();
    const ids = cfg.allocations.map(a => a.externalId).sort();
    expect(ids).toEqual([
      'copilot-chat-multi-day-copilot-gpt-4o-20260501',
      'copilot-chat-multi-day-copilot-gpt-4o-20260502',
    ]);
  });

  it('deduplicates inherited requests when a session is forked', async () => {
    // Session A (original): r1 (0.10) + r2 (0.20) = 0.30
    const sessionA: CopilotSessionUsage = {
      sessionId: 'sess-a',
      model: 'copilot-gpt-4o',
      costUsd: 0.30,
      inputTokens: 2,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      timestamp: '2026-05-01T12:00:00.000Z',
      externalId: 'copilot-chat-sess-a-copilot-gpt-4o',
      requests: [
        { responseId: 'r1', completedAtMs: Date.parse('2026-05-01T10:00:00.000Z'), costUsd: 0.10, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { responseId: 'r2', completedAtMs: Date.parse('2026-05-01T11:00:00.000Z'), costUsd: 0.20, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    };
    // Session B (fork of A): inherits r1+r2, adds r3 (0.15) + r4 (0.15) = 0.30 net new
    const sessionB: CopilotSessionUsage = {
      sessionId: 'sess-b',
      model: 'copilot-gpt-4o',
      costUsd: 0.60,
      inputTokens: 4,
      outputTokens: 4,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      timestamp: '2026-05-01T14:00:00.000Z',
      externalId: 'copilot-chat-sess-b-copilot-gpt-4o',
      requests: [
        { responseId: 'r1', completedAtMs: Date.parse('2026-05-01T10:00:00.000Z'), costUsd: 0.10, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { responseId: 'r2', completedAtMs: Date.parse('2026-05-01T11:00:00.000Z'), costUsd: 0.20, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { responseId: 'r3', completedAtMs: Date.parse('2026-05-01T12:00:00.000Z'), costUsd: 0.15, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { responseId: 'r4', completedAtMs: Date.parse('2026-05-01T13:00:00.000Z'), costUsd: 0.15, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    };

    // A appears first in the array (simulates older mtime → original processed before fork).
    fixtures.chat = [sessionA, sessionB];

    await importHistory(null);

    const cfg = await loadConfig();
    // Total should be A(0.30) + B_new(0.30) = 0.60, not 0.90 (which would double-count r1+r2).
    const totalCost = cfg.allocations.reduce((s, a) => s + a.costUsd, 0);
    expect(totalCost).toBeCloseTo(0.60, 5);

    const allocA = cfg.allocations.find(a => a.externalId?.includes('sess-a'));
    const allocB = cfg.allocations.find(a => a.externalId?.includes('sess-b'));
    expect(allocA?.costUsd).toBeCloseTo(0.30, 5);
    expect(allocB?.costUsd).toBeCloseTo(0.30, 5); // only r3+r4, not all four

    // responseIds are persisted so subsequent incremental syncs can also deduplicate.
    expect(allocA?.responseIds).toEqual(['r1', 'r2']);
    expect(allocB?.responseIds).toEqual(['r3', 'r4']);
  });
});
