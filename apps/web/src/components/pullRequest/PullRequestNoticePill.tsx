import type { ThreadPullRequestLink, ThreadPullRequestNotice } from "@t3tools/contracts";
import { latestPullRequestNotice } from "@t3tools/shared/threadPullRequests";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The newest pull request notice that arrived after the thread was last opened. */
export function unseenPullRequestNotice(
  links: ReadonlyArray<ThreadPullRequestLink>,
  lastVisitedAt: string | undefined,
): ThreadPullRequestNotice | null {
  const notice = latestPullRequestNotice(links);
  if (notice === null) return null;
  if (lastVisitedAt === undefined) return notice;
  const visited = Date.parse(lastVisitedAt);
  return Number.isNaN(visited) || Date.parse(notice.at) > visited ? notice : null;
}

/** The row already shows the pull request, so the pill keeps only what happened. */
const pullRequestNoticeEvent = (notice: ThreadPullRequestNotice) =>
  notice.summary.replace(/^#\d+:\s*/, "");

export function PullRequestNoticePill({ notice }: { notice: ThreadPullRequestNotice }) {
  const label = pullRequestNoticeEvent(notice);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-4 max-w-24 shrink-0 items-center truncate rounded-full border px-1.5 text-3xs leading-none",
              notice.outcome === "failed"
                ? "border-destructive/40 text-destructive-foreground"
                : notice.outcome === "completed"
                  ? "border-success/40 text-success-foreground"
                  : "border-info/40 text-info-foreground",
            )}
          >
            {label}
          </span>
        }
      />
      <TooltipPopup side="top">Pull request {notice.summary}</TooltipPopup>
    </Tooltip>
  );
}
