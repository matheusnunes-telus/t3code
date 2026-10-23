import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { jiraSyncHealth, relativeAge, useJiraCommand, useJiraSnapshot } from "~/state/jira";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Where a lost Atlassian login is fixed: the connector lives in the claude.ai account. */
export const CLAUDE_CONNECTOR_SETTINGS_URL = "https://claude.ai/settings/connectors";

const DOT: Record<ReturnType<typeof jiraSyncHealth>, string> = {
  ok: "bg-success",
  stale: "bg-warning",
  syncing: "bg-info animate-pulse",
  "signed-out": "bg-destructive",
  problem: "bg-destructive",
  off: "bg-muted-foreground/50",
};

function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** "Jira synced 4 min ago", or why it is not: old, signed out, or failing. */
export function JiraSyncStatus({
  environmentId,
  className,
}: {
  environmentId: EnvironmentId;
  className?: string;
}) {
  const snapshot = useJiraSnapshot(environmentId);
  const command = useJiraCommand(environmentId);
  const now = useMinuteClock();
  if (snapshot === null || !snapshot.enabled) return null;
  const health = jiraSyncHealth(snapshot, now);
  const age = relativeAge(snapshot.sync.lastSyncedAt, now);
  const refresh = (
    <button
      type="button"
      className="cursor-pointer underline underline-offset-2 hover:text-foreground"
      onClick={() => void command({ type: "sync" })}
    >
      Refresh
    </button>
  );
  const label =
    health === "ok" ? (
      <>Jira synced {age}</>
    ) : health === "syncing" ? (
      <>Syncing Jira…</>
    ) : health === "stale" ? (
      <>
        {snapshot.sync.lastSyncedAt === null ? "Jira not synced yet" : `Synced ${age}`} · {refresh}
      </>
    ) : health === "signed-out" ? (
      <>
        Jira signed you out ·{" "}
        <a
          href={CLAUDE_CONNECTOR_SETTINGS_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Reconnect
        </a>{" "}
        · {refresh}
      </>
    ) : (
      <>Jira sync failed · {refresh}</>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
              className,
            )}
            data-jira-sync={health}
          />
        }
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[health])} />
        <span className="min-w-0 truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {snapshot.sync.message ??
          (health === "stale"
            ? "Statuses may be out of date."
            : `Last tried ${relativeAge(snapshot.sync.lastAttemptAt, now)}.`)}
      </TooltipPopup>
    </Tooltip>
  );
}
