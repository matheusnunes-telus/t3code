import type { UsageTokenTotals } from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";

export interface ChatSessionTokenTotals extends UsageTokenTotals {}

export interface ChatSessionModelUsage {
  readonly model: string;
  readonly totals: ChatSessionTokenTotals;
  readonly cacheWriteTtl: "5m" | "1h" | undefined;
}

export interface ChatSessionCache {
  /** When the last request refreshed the prompt cache. */
  readonly lastUsedAtMs: number;
  readonly ttlMs: number | null;
  /** Roughly what the next request re-reads or, once cold, writes again. */
  readonly contextTokens: number;
}

export interface ChatSessionStats {
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly totals: ChatSessionTokenTotals;
  readonly byModel: readonly ChatSessionModelUsage[];
  /** Turns with usage on record; imported chats and some providers have none. */
  readonly turnsWithUsage: number;
  /** Some turns reported only part of their usage. */
  readonly partial: boolean;
  /** Subagent tokens are not part of a turn's reported usage. */
  readonly hasSubagents: boolean;
  readonly cache: ChatSessionCache | null;
}

const EMPTY_TOTALS: ChatSessionTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function addTotals(
  left: ChatSessionTokenTotals,
  right: ChatSessionTokenTotals,
): ChatSessionTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

export function totalTokens(totals: ChatSessionTokenTotals): number {
  // reasoningTokens is part of outputTokens, so it is not added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Adds up a chat's own turns. A provider's `inputTokens` already includes cache
 * reads and writes, so the uncached part is what is left after taking them out.
 */
export function deriveChatSessionStats(
  projection: Pick<ThreadStructure, "providerTurns" | "attempts" | "runs" | "thread">,
  turnItems: ReadonlyArray<{ readonly item: { readonly type: string } }>,
): ChatSessionStats {
  let userMessages = 0;
  let assistantMessages = 0;
  for (const { item } of turnItems) {
    if (item.type === "user_message") userMessages += 1;
    else if (item.type === "assistant_message") assistantMessages += 1;
  }

  const runIdByAttemptId = new Map(
    projection.attempts.map((attempt) => [attempt.id, attempt.runId]),
  );
  const modelByRunId = new Map(
    projection.runs.map((run) => [run.id, run.modelSelection.model] as const),
  );
  const fallbackModel = projection.thread.modelSelection?.model ?? "unknown";

  const byModel = new Map<string, { totals: ChatSessionTokenTotals; ttlMs: number | null }>();
  let totals = EMPTY_TOTALS;
  let turnsWithUsage = 0;
  let partial = false;
  let hasSubagents = false;
  let cache: ChatSessionCache | null = null;

  for (const turn of projection.providerTurns) {
    const usage = turn.turnTokenUsage;
    const ttlMs = turn.tokenUsage?.promptCacheTtlMs ?? null;
    if (turn.tokenUsage) {
      const lastUsedAtMs = Date.parse(turn.tokenUsage.updatedAt);
      if (Number.isFinite(lastUsedAtMs) && (cache === null || lastUsedAtMs > cache.lastUsedAtMs)) {
        cache = { lastUsedAtMs, ttlMs, contextTokens: turn.tokenUsage.usedTokens };
      }
    }
    if (!usage || usage.usageStatus === "unavailable") continue;
    if (usage.usageStatus === "partial") partial = true;
    if (usage.hasSubagents) hasSubagents = true;

    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
    const turnTotals: ChatSessionTokenTotals = {
      uncachedInputTokens: Math.max(
        0,
        (usage.inputTokens ?? 0) - cachedInputTokens - cacheCreationTokens,
      ),
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
    };
    turnsWithUsage += 1;
    totals = addTotals(totals, turnTotals);

    const runId = turn.runAttemptId === null ? undefined : runIdByAttemptId.get(turn.runAttemptId);
    const model = (runId === undefined ? undefined : modelByRunId.get(runId)) || fallbackModel;
    const existing = byModel.get(model);
    byModel.set(model, {
      totals: addTotals(existing?.totals ?? EMPTY_TOTALS, turnTotals),
      ttlMs: ttlMs ?? existing?.ttlMs ?? null,
    });
  }

  return {
    userMessages,
    assistantMessages,
    totals,
    byModel: [...byModel].map(([model, entry]) => ({
      model,
      totals: entry.totals,
      cacheWriteTtl: entry.ttlMs === null ? undefined : entry.ttlMs >= 3_600_000 ? "1h" : "5m",
    })),
    turnsWithUsage,
    partial,
    hasSubagents,
    cache,
  };
}

export type ChatCacheState =
  | { readonly kind: "warm"; readonly expiresInMs: number; readonly ttlMs: number }
  | { readonly kind: "cold"; readonly expiredAgoMs: number; readonly ttlMs: number }
  | { readonly kind: "unknown" };

export function resolveChatCacheState(
  cache: ChatSessionCache | null,
  nowMs: number,
): ChatCacheState {
  if (cache === null || cache.ttlMs === null) return { kind: "unknown" };
  const expiresAtMs = cache.lastUsedAtMs + cache.ttlMs;
  return expiresAtMs > nowMs
    ? { kind: "warm", expiresInMs: expiresAtMs - nowMs, ttlMs: cache.ttlMs }
    : { kind: "cold", expiredAgoMs: nowMs - expiresAtMs, ttlMs: cache.ttlMs };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  return `${Math.round(hours / 24)} days`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}
