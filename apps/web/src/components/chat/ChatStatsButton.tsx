import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  UsagePriceInput,
} from "@t3tools/contracts";
import { ChartNoAxesColumnIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import {
  type ChatCacheState,
  type ChatSessionStats,
  deriveChatSessionStats,
  formatDuration,
  formatTokenCount,
  formatUsd,
  resolveChatCacheState,
  totalTokens,
} from "./chatSessionStats";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The chat's token totals by model, plus what re-caching the context would cost. */
function priceInput(stats: ChatSessionStats, latestModel: string | null): UsagePriceInput {
  const items: Array<UsagePriceInput["items"][number]> = stats.byModel.map((entry) => ({
    model: entry.model,
    totals: entry.totals,
    ...(entry.cacheWriteTtl === undefined ? {} : { cacheWriteTtl: entry.cacheWriteTtl }),
  }));
  if (stats.cache !== null && latestModel !== null) {
    items.push({
      model: latestModel,
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: stats.cache.contextTokens,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      ...(stats.cache.ttlMs === null
        ? {}
        : { cacheWriteTtl: stats.cache.ttlMs >= 3_600_000 ? "1h" : "5m" }),
    });
  }
  return { items };
}

function Row(props: { label: ReactNode; value: ReactNode; muted?: boolean }) {
  return (
    <div
      className={
        props.muted
          ? "flex items-center justify-between gap-3 ps-3 text-2xs text-muted-foreground"
          : "flex items-center justify-between gap-3 text-xs"
      }
    >
      <span>{props.label}</span>
      <span className="tabular-nums">{props.value}</span>
    </div>
  );
}

function cacheSummary(state: ChatCacheState): { title: string; detail: string } | null {
  if (state.kind === "unknown") return null;
  const ttl = state.ttlMs >= 3_600_000 ? "1-hour" : `${Math.round(state.ttlMs / 60_000)}-minute`;
  return state.kind === "warm"
    ? {
        title: `Warm · ${formatDuration(state.expiresInMs)} left`,
        detail: `${ttl} cache. Each message resets the timer, and replies re-read the chat cheaply.`,
      }
    : {
        title: `Cold · expired ${formatDuration(state.expiredAgoMs)} ago`,
        detail: `${ttl} cache. The next message writes the whole chat to the cache again`,
      };
}

function ChatStatsContent(props: {
  environmentId: EnvironmentId;
  stats: ChatSessionStats;
  latestModel: string | null;
  cacheState: ChatCacheState;
}) {
  const { stats } = props;
  const input = priceInput(stats, props.latestModel);
  const priced = useAtomValue(
    serverEnvironment.usagePrice({ environmentId: props.environmentId, input }),
  );
  const price = Option.getOrNull(AsyncResult.value(priced));
  const chatItems = price?.items.slice(0, stats.byModel.length) ?? null;
  const chatCost =
    chatItems === null ? null : chatItems.reduce((sum, item) => sum + item.costUsd, 0);
  const unpriced = chatItems?.some((item) => item.costSource === "unpriced") ?? false;
  const recacheCost =
    stats.cache !== null && price !== null
      ? (price.items[stats.byModel.length]?.costUsd ?? null)
      : null;
  const cache = cacheSummary(props.cacheState);
  const hasUsage = stats.turnsWithUsage > 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="font-medium text-muted-foreground text-xs">Chat stats</div>
      <Row
        label="Messages"
        value={`${stats.userMessages} sent · ${stats.assistantMessages} received`}
      />
      {hasUsage ? (
        <>
          <div className="flex flex-col gap-1">
            <Row label="Tokens" value={formatTokenCount(totalTokens(stats.totals))} />
            <Row
              muted
              label="Cache read"
              value={formatTokenCount(stats.totals.cachedInputTokens)}
            />
            <Row
              muted
              label="Cache write"
              value={formatTokenCount(stats.totals.cacheCreationTokens)}
            />
            <Row muted label="Input" value={formatTokenCount(stats.totals.uncachedInputTokens)} />
            <Row
              muted
              label={
                stats.totals.reasoningTokens > 0
                  ? `Output (${formatTokenCount(stats.totals.reasoningTokens)} thinking)`
                  : "Output"
              }
              value={formatTokenCount(stats.totals.outputTokens)}
            />
          </div>
          <Row
            label="Estimated cost"
            value={
              chatCost === null
                ? priced._tag === "Failure"
                  ? "Unavailable"
                  : "…"
                : unpriced
                  ? `${formatUsd(chatCost)}+`
                  : formatUsd(chatCost)
            }
          />
        </>
      ) : (
        <p className="text-2xs text-muted-foreground">
          No token usage recorded for this chat. Imported chats and chats without a finished reply
          have none.
        </p>
      )}
      {cache ? (
        <div className="flex flex-col gap-0.5">
          <Row label="Cache" value={cache.title} />
          <p className="text-pretty text-2xs text-muted-foreground">
            {cache.detail}
            {props.cacheState.kind === "cold" && stats.cache !== null
              ? ` (~${formatTokenCount(stats.cache.contextTokens)} tokens${
                  recacheCost === null ? "" : `, ~${formatUsd(recacheCost)}`
                }).`
              : ""}
          </p>
        </div>
      ) : null}
      {hasUsage ? (
        <p className="text-pretty text-2xs text-muted-foreground">
          Cost uses API prices; a subscription isn't billed per token. Tool calls and results count
          as input and output.
          {stats.hasSubagents ? " Subagent tokens aren't included." : ""}
          {stats.partial ? " Some turns reported only part of their usage." : ""}
        </p>
      ) : null}
    </div>
  );
}

/** Header button with a small popover of the chat's message, token, cost and cache stats. */
export function ChatStatsButton(props: {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection | null;
  turnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(30_000);
  if (props.projection === null) return null;
  const stats = deriveChatSessionStats(props.projection, props.turnItems);
  const cacheState = resolveChatCacheState(stats.cache, now);
  const latestRun = props.projection.runs.reduce<
    OrchestrationV2ThreadProjection["runs"][number] | null
  >((latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest), null);
  const latestModel =
    latestRun?.modelSelection.model || props.projection.thread.modelSelection?.model || null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Toggle
            className="relative shrink-0 [-webkit-app-region:no-drag]"
            pressed={open}
            aria-label="Chat stats"
            variant="ghost"
            size="sm"
          />
        }
      >
        <ChartNoAxesColumnIcon className="size-4" />
        {cacheState.kind === "warm" ? (
          <span
            className="absolute top-1 right-1 size-1.5 rounded-full bg-success"
            aria-hidden
            data-testid="chat-stats-cache-warm"
          />
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="sm" padding="compact">
        {open ? (
          <ChatStatsContent
            environmentId={props.environmentId}
            stats={stats}
            latestModel={latestModel}
            cacheState={cacheState}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
