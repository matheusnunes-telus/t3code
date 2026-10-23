import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, JiraIssue, JiraSnapshot, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { issuePath, levelLabel } from "~/state/jira";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";

const STATUS_VARIANT = {
  new: "secondary",
  indeterminate: "info",
  done: "success",
} as const satisfies Record<JiraIssue["statusCategory"], "secondary" | "info" | "success">;

export function JiraKey({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn("font-mono text-2xs font-semibold text-info-foreground", className)}>
      {value}
    </span>
  );
}

export function JiraStatusBadge({
  issue,
}: {
  issue: Pick<JiraIssue, "status" | "statusCategory">;
}) {
  return (
    <Badge size="sm" variant={STATUS_VARIANT[issue.statusCategory]}>
      {issue.status}
    </Badge>
  );
}

export function JiraLevelTag({ level }: { level: number }) {
  return (
    <span className="rounded-sm bg-muted px-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
      {levelLabel(level)}
    </span>
  );
}

/** The initiative › epic › task path above a ticket. */
export function JiraTicketPath({
  snapshot,
  issueKey,
  className,
}: {
  snapshot: JiraSnapshot | null;
  issueKey: string;
  className?: string;
}) {
  const path = issuePath(snapshot, issueKey);
  if (path.length === 0) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {path.map((issue) => (
        <span key={issue.key} className="inline-flex min-w-0 items-center gap-1">
          <JiraKey value={issue.key} className="text-muted-foreground" />
          <span className="truncate">{issue.summary}</span>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 opacity-50" />
        </span>
      ))}
    </div>
  );
}

/** The threads linked to a ticket, each opening its thread. */
export function JiraTicketThreads({
  environmentId,
  threadIds,
  currentThreadId,
}: {
  environmentId: EnvironmentId;
  threadIds: ReadonlyArray<ThreadId>;
  currentThreadId?: ThreadId | undefined;
}) {
  const shells = useThreadShells();
  const navigate = useNavigate();
  if (threadIds.length === 0) {
    return <p className="text-xs text-muted-foreground">No threads yet.</p>;
  }
  return (
    <ul className="flex flex-col">
      {threadIds.map((threadId) => {
        const shell = shells.find(
          (candidate) => candidate.environmentId === environmentId && candidate.id === threadId,
        );
        const current = threadId === currentThreadId;
        return (
          <li key={threadId}>
            <button
              type="button"
              disabled={current}
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
                })
              }
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  current ? "bg-info" : "bg-muted-foreground/50",
                )}
              />
              <span className="truncate">{shell?.title ?? "Thread"}</span>
              {current ? <span className="shrink-0 text-muted-foreground">(this one)</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
