import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, JiraIssue, JiraSnapshot, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, MessageSquareIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { issuePath, levelLabel } from "~/state/jira";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  chevron = false,
}: {
  issue: Pick<JiraIssue, "status" | "statusCategory">;
  chevron?: boolean;
}) {
  return (
    <Badge size="sm" variant={STATUS_VARIANT[issue.statusCategory]}>
      {issue.status}
      {chevron ? <ChevronDownIcon className="size-3 opacity-70" /> : null}
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

/** The initiative › epic path above a ticket, by name; each key is in its tooltip. */
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
      {path.map((issue, index) => (
        <span key={issue.key} className="inline-flex min-w-0 items-center gap-1">
          {index > 0 ? (
            <ChevronRightIcon aria-hidden className="size-3 shrink-0 opacity-50" />
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="truncate" />}>{issue.summary}</TooltipTrigger>
            <TooltipPopup>
              {issue.key} · {levelLabel(issue.level)}
            </TooltipPopup>
          </Tooltip>
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
              className={cn(
                "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-accent disabled:cursor-default",
                current && "bg-accent/60 disabled:hover:bg-accent/60",
              )}
            >
              <MessageSquareIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{shell?.title ?? "Thread"}</span>
              {current ? (
                <span className="shrink-0 rounded-sm bg-muted px-1 text-3xs text-muted-foreground">
                  this thread
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
