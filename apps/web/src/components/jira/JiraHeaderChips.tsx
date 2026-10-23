import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, JiraSnapshot, ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon, PanelRightIcon, PlusIcon, TicketIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  issueByKey,
  levelLabel,
  relativeAge,
  threadTicketKeys,
  ticketThreadIds,
  useJiraCommand,
  useJiraSnapshot,
} from "~/state/jira";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  JiraKey,
  JiraLevelTag,
  JiraStatusBadge,
  JiraTicketPath,
  JiraTicketThreads,
} from "./JiraTicketBits";

const CHIP_CLASS =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-1.5 text-xs outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent";

/** How the link was made, in words, for the bottom of the popover. */
function linkReason(snapshot: JiraSnapshot, threadId: ThreadId, key: string): string {
  const link = snapshot.links.find((entry) => entry.threadId === threadId && entry.key === key);
  switch (link?.source) {
    case "suggestion":
      return "Linked from T3's suggestion.";
    case "created":
      return "Created from this thread.";
    default:
      return "Linked by hand.";
  }
}

function JiraTicketChip({
  environmentId,
  threadId,
  snapshot,
  issueKey,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshot: JiraSnapshot;
  issueKey: string;
}) {
  const command = useJiraCommand(environmentId);
  const [open, setOpen] = useState(false);
  const issue = issueByKey(snapshot, issueKey);
  const now = Date.now();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" className={CHIP_CLASS} aria-label={`Jira ${issueKey}`} />}
      >
        <JiraKey value={issueKey} />
        {issue ? (
          <span className="text-muted-foreground">{issue.status}</span>
        ) : (
          <span className="text-muted-foreground">not synced</span>
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-2 text-sm">
          <JiraTicketPath snapshot={snapshot} issueKey={issueKey} />
          <div className="flex items-baseline gap-2">
            <JiraKey value={issueKey} />
            <span className="font-medium">{issue?.summary ?? "Not in the synced tree yet"}</span>
          </div>
          {issue ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <JiraLevelTag level={issue.level} />
              <JiraStatusBadge issue={issue} />
              <span>synced {relativeAge(snapshot.sync.lastSyncedAt, now)}</span>
            </div>
          ) : null}
          <div className="border-t border-border pt-2">
            <p className="mb-1 text-xs text-muted-foreground">Threads on this ticket</p>
            <JiraTicketThreads
              environmentId={environmentId}
              threadIds={ticketThreadIds(snapshot, issueKey)}
              currentThreadId={threadId}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="compact"
              variant="outline"
              onClick={() => {
                setOpen(false);
                useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "jira");
              }}
            >
              <PanelRightIcon />
              Ticket panel
            </Button>
            {issue?.url ? (
              <Button
                size="compact"
                variant="outline"
                render={<a href={issue.url} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon />
                Jira
              </Button>
            ) : null}
            <Button
              size="compact"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                void command({ type: "link", threadId, key: issueKey, linked: false });
              }}
            >
              Unlink
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {linkReason(snapshot, threadId, issueKey)}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Tasks, then sub-tasks, then epics and initiatives. */
const pickerRank = (level: number) => (level === 0 ? 0 : level < 0 ? 1 : level + 1);

/** Links a ticket by hand, searching the synced tree by key or summary. */
function JiraAddTicket({
  environmentId,
  threadId,
  snapshot,
  hasLinks,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshot: JiraSnapshot;
  hasLinks: boolean;
}) {
  const command = useJiraCommand(environmentId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const linked = new Set(threadTicketKeys(snapshot, threadId));
  const needle = query.trim().toLowerCase();
  const candidates = snapshot.issues
    .filter((issue) => issue.statusCategory !== "done" && !linked.has(issue.key))
    .filter(
      (issue) =>
        needle.length === 0 ||
        issue.key.toLowerCase().includes(needle) ||
        issue.summary.toLowerCase().includes(needle),
    )
    // Tasks and sub-tasks first: threads are usually task-sized work.
    .toSorted((a, b) => pickerRank(a.level) - pickerRank(b.level) || a.key.localeCompare(b.key))
    .slice(0, 30);
  const typedKey = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(query.trim())
    ? query.trim().toUpperCase()
    : null;
  const link = (key: string) => {
    setOpen(false);
    setQuery("");
    void command({ type: "link", threadId, key, linked: true });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Link a Jira ticket"
                  className={cn(CHIP_CLASS, "border-dashed text-muted-foreground")}
                />
              }
            />
          }
        >
          {hasLinks ? <PlusIcon className="size-3" /> : <TicketIcon className="size-3" />}
          {hasLinks ? null : <span>ticket</span>}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Link a Jira ticket</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-96">
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            size="sm"
            placeholder="Search by key or summary"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const first = typedKey ?? candidates[0]?.key;
              if (first) link(first);
            }}
          />
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {candidates.map((issue) => (
              <li key={issue.key}>
                <button
                  type="button"
                  onClick={() => link(issue.key)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent"
                >
                  <JiraKey value={issue.key} />
                  <span className="min-w-0 flex-1 truncate">{issue.summary}</span>
                  <span className="shrink-0 text-muted-foreground">{levelLabel(issue.level)}</span>
                </button>
              </li>
            ))}
            {candidates.length === 0 && typedKey === null ? (
              <li className="px-1.5 py-1 text-xs text-muted-foreground">No open tickets match.</li>
            ) : null}
            {typedKey !== null && !candidates.some((issue) => issue.key === typedKey) ? (
              <li>
                <button
                  type="button"
                  onClick={() => link(typedKey)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent"
                >
                  Link <JiraKey value={typedKey} /> anyway
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** The thread's Jira tickets as chips beside its title, plus a picker to link one. */
export function JiraHeaderChips({
  environmentId,
  threadId,
  className,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  className?: string | undefined;
}) {
  const snapshot = useJiraSnapshot(environmentId);
  if (snapshot === null || !snapshot.enabled) return null;
  const keys = threadTicketKeys(snapshot, threadId);
  const suggestion = snapshot.suggestions.find(
    (entry) => entry.threadId === threadId && entry.state === "ready",
  );
  const suggestedKey = keys.length === 0 ? suggestion?.matches[0]?.key : undefined;
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)} data-jira-header-chips>
      {keys.map((key) => (
        <JiraTicketChip
          key={key}
          environmentId={environmentId}
          threadId={threadId}
          snapshot={snapshot}
          issueKey={key}
        />
      ))}
      {suggestedKey ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(CHIP_CLASS, "cursor-default border-dashed text-muted-foreground")}
              />
            }
          >
            <JiraKey value={`${suggestedKey}?`} className="text-muted-foreground" />
            suggested
          </TooltipTrigger>
          <TooltipPopup side="bottom">Confirm it in the card above the message box.</TooltipPopup>
        </Tooltip>
      ) : null}
      <JiraAddTicket
        environmentId={environmentId}
        threadId={threadId}
        snapshot={snapshot}
        hasLinks={keys.length > 0 || suggestedKey !== undefined}
      />
    </div>
  );
}
