import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { jiraSyncHealth, relativeAge, useJiraCommand, useJiraSnapshot } from "~/state/jira";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const openExternalUrl = (url: string) => {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noreferrer");
};

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
  const link = (text: string, onClick: () => void) => (
    <button
      type="button"
      className="cursor-pointer underline underline-offset-2 hover:text-foreground"
      onClick={onClick}
    >
      {text}
    </button>
  );
  const signIn =
    snapshot.signInUrl !== null
      ? link("Open sign-in page", () => openExternalUrl(snapshot.signInUrl ?? ""))
      : link("Sign in", () => void command({ type: "signIn" }));
  const label =
    health === "ok" ? (
      snapshot.mcpSignedOut ? (
        // The CLI keeps it working, but sprint moves need MCP.
        <>
          Jira synced {age} with the CLI · MCP signed out · {signIn}
        </>
      ) : (
        <>Jira synced {age}</>
      )
    ) : health === "syncing" ? (
      <>Syncing Jira…</>
    ) : health === "stale" ? (
      <>
        {snapshot.sync.lastSyncedAt === null ? "Jira not synced yet" : `Synced ${age}`} · {refresh}
      </>
    ) : health === "signed-out" ? (
      <>
        Jira signed you out{snapshot.signIn === "none" ? null : <> · {signIn}</>} · {refresh}
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
