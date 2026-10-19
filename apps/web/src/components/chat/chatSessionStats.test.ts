import { describe, expect, it } from "vite-plus/test";

import { deriveChatSessionStats, resolveChatCacheState } from "./chatSessionStats";

function turn(input: {
  attempt: string;
  usage?: Record<string, unknown>;
  tokenUsage?: Record<string, unknown>;
}) {
  return {
    runAttemptId: input.attempt,
    turnTokenUsage: input.usage,
    tokenUsage: input.tokenUsage,
  };
}

const projection = {
  thread: { modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
  runs: [
    { id: "run-1", ordinal: 1, modelSelection: { model: "claude-sonnet-5-5" } },
    { id: "run-2", ordinal: 2, modelSelection: { model: "claude-opus-5-5" } },
  ],
  attempts: [
    { id: "attempt-1", runId: "run-1" },
    { id: "attempt-2", runId: "run-2" },
  ],
  providerTurns: [
    turn({
      attempt: "attempt-1",
      usage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 1_000,
        cachedInputTokens: 700,
        cacheCreationTokens: 200,
        outputTokens: 50,
        reasoningTokens: 10,
      },
      tokenUsage: {
        usedTokens: 900,
        promptCacheTtlMs: 3_600_000,
        updatedAt: "2026-10-19T01:00:00Z",
      },
    }),
    turn({
      attempt: "attempt-2",
      usage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 2_000,
        cachedInputTokens: 1_500,
        cacheCreationTokens: 400,
        outputTokens: 80,
      },
      tokenUsage: {
        usedTokens: 1_950,
        promptCacheTtlMs: 3_600_000,
        updatedAt: "2026-10-19T02:00:00Z",
      },
    }),
  ],
} as never;

const items = [
  { item: { type: "user_message" } },
  { item: { type: "assistant_message" } },
  { item: { type: "command_execution" } },
  { item: { type: "user_message" } },
  { item: { type: "assistant_message" } },
] as never;

describe("deriveChatSessionStats", () => {
  it("adds up turns, splitting cached input out of the reported input", () => {
    const stats = deriveChatSessionStats(projection, items);
    expect(stats.userMessages).toBe(2);
    expect(stats.assistantMessages).toBe(2);
    expect(stats.totals).toEqual({
      uncachedInputTokens: 200,
      cachedInputTokens: 2_200,
      cacheCreationTokens: 600,
      outputTokens: 130,
      reasoningTokens: 10,
    });
    expect(stats.byModel.map((entry) => [entry.model, entry.cacheWriteTtl])).toEqual([
      ["claude-sonnet-5-5", "1h"],
      ["claude-opus-5-5", "1h"],
    ]);
    expect(stats.hasSubagents).toBe(true);
    expect(stats.cache).toEqual({
      lastUsedAtMs: Date.parse("2026-10-19T02:00:00Z"),
      ttlMs: 3_600_000,
      contextTokens: 1_950,
    });
  });
});

describe("resolveChatCacheState", () => {
  const cache = { lastUsedAtMs: 0, ttlMs: 3_600_000, contextTokens: 1 };

  it("is warm until the TTL runs out after the last request", () => {
    expect(resolveChatCacheState(cache, 20 * 60_000)).toEqual({
      kind: "warm",
      expiresInMs: 40 * 60_000,
      ttlMs: 3_600_000,
    });
    expect(resolveChatCacheState(cache, 90 * 60_000)).toEqual({
      kind: "cold",
      expiredAgoMs: 30 * 60_000,
      ttlMs: 3_600_000,
    });
  });

  it("is unknown without a reported TTL", () => {
    expect(resolveChatCacheState({ ...cache, ttlMs: null }, 0)).toEqual({ kind: "unknown" });
    expect(resolveChatCacheState(null, 0)).toEqual({ kind: "unknown" });
  });
});
