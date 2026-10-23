import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  JiraSnapshot,
  JiraTicketUpdates,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  BellIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  PencilLineIcon,
  TicketIcon,
} from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { useThreadShell, useThreadShells } from "~/state/entities";
import {
  issueByKey,
  issuePath,
  relativeAge,
  threadTicketKeys,
  ticketThreadIds,
  useJiraCommand,
  useJiraSnapshot,
} from "~/state/jira";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  JiraKey,
  JiraLevelTag,
  JiraStatusBadge,
  JiraTicketPath,
  JiraTicketThreads,
} from "./JiraTicketBits";
import { JiraSyncStatus } from "./JiraSyncStatus";

const UPDATE_LEVELS: ReadonlyArray<{
  readonly value: JiraTicketUpdates;
  readonly label: string;
  readonly description: string;
  readonly icon: typeof BellIcon;
}> = [
  {
    value: "link",
    label: "Link only",
    description: "Keeps the link. No notifications.",
    icon: PullRequestGlyph.link,
  },
  {
    value: "notify",
    label: "Notify",
    description: "Notifies you when a sync sees its status change.",
    icon: BellIcon,
  },
];

function TicketUpdatesToggle({
  value,
  onChange,
}: {
  value: JiraTicketUpdates;
  onChange: (value: JiraTicketUpdates) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Ticket updates"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-input/40 p-0.5"
    >
      {UPDATE_LEVELS.map((level) => {
        const active = level.value === value;
        const Icon = level.icon;
        return (
          <Tooltip key={level.value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={level.label}
                  onClick={() => {
                    if (!active) onChange(level.value);
                  }}
                  className={cn(
                    "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    active
                      ? "bg-background text-foreground shadow-xs dark:bg-input"
                      : "hover:text-foreground",
                  )}
                />
              }
            >
              <Icon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-64">
              <span className="font-medium">{level.label}</span>
              <span className="block text-muted-foreground">{level.description}</span>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

function TicketPullRequests({
  environmentId,
  threadIds,
}: {
  environmentId: EnvironmentId;
  threadIds: ReadonlyArray<ThreadId>;
}) {
  const shells = useThreadShells();
  const pullRequests = shells
    .filter((shell) => shell.environmentId === environmentId && threadIds.includes(shell.id))
    .flatMap((shell) => visibleThreadPullRequests(shell.pullRequests));
  if (pullRequests.length === 0) {
    return <p className="text-xs text-muted-foreground">No pull requests yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {pullRequests.map((pr) => {
        const state = pr.snapshot?.state ?? "open";
        return (
          <li key={`${pr.repository}#${pr.number}`}>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent"
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  state === "merged"
                    ? "bg-info"
                    : state === "closed"
                      ? "bg-destructive"
                      : "bg-success",
                )}
              />
              <span className="shrink-0 font-mono text-muted-foreground">#{pr.number}</span>
              <span className="min-w-0 flex-1 truncate">{pr.snapshot?.title ?? pr.repository}</span>
              <span className="shrink-0 text-muted-foreground">{state}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function TicketCard({
  environmentId,
  threadRef,
  snapshot,
  issueKey,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  snapshot: JiraSnapshot;
  issueKey: string;
}) {
  const command = useJiraCommand(environmentId);
  const shell = useThreadShell(threadRef);
  const newThread = useNewThreadHandler();
  const [drafting, setDrafting] = useState(false);
  const issue = issueByKey(snapshot, issueKey);
  const threadIds = ticketThreadIds(snapshot, issueKey);
  const now = Date.now();

  const startThread = async () => {
    if (shell === null) return;
    const session = await newThread(scopeProjectRef(environmentId, shell.projectId)).then(
      (result) => result,
      () => null,
    );
    if (session === null) return;
    const path = issuePath(snapshot, issueKey)
      .map((parent) => `${parent.key} ${parent.summary}`)
      .join(" > ");
    useComposerDraftStore
      .getState()
      .setPrompt(
        session.draftId,
        `Jira ${issueKey}: ${issue?.summary ?? ""}${path.length > 0 ? ` (under ${path})` : ""}\nRead the ticket with the Atlassian tools if you need its details.\n\n`,
      );
  };

  const draftUpdate = async () => {
    setDrafting(true);
    await command({ type: "proposeChanges", threadId: threadRef.threadId, key: issueKey });
    setDrafting(false);
  };

  return (
    <section className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <JiraKey value={issueKey} />
        {issue ? <JiraStatusBadge issue={issue} /> : null}
        {issue ? <JiraLevelTag level={issue.level} /> : null}
        <span className="flex-1" />
        <TicketUpdatesToggle
          value={snapshot.ticketUpdates[issueKey] ?? "link"}
          onChange={(updates) => void command({ type: "ticketUpdates", key: issueKey, updates })}
        />
      </div>
      <h3 className="text-sm font-medium">{issue?.summary ?? "Not in the synced tree yet"}</h3>
      <JiraTicketPath snapshot={snapshot} issueKey={issueKey} />
      <p className="text-xs text-muted-foreground">
        Synced {relativeAge(snapshot.sync.lastSyncedAt, now)} by the agent ·{" "}
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          onClick={() => void command({ type: "sync" })}
        >
          Refresh
        </button>
      </p>
      <div>
        <p className="mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Threads ({threadIds.length})
        </p>
        <JiraTicketThreads
          environmentId={environmentId}
          threadIds={threadIds}
          currentThreadId={threadRef.threadId}
        />
      </div>
      <div>
        <p className="mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Pull requests
        </p>
        <TicketPullRequests environmentId={environmentId} threadIds={threadIds} />
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Button size="compact" onClick={() => void startThread()}>
          <MessageSquarePlusIcon />
          New thread for this ticket
        </Button>
        <Button
          size="compact"
          variant="outline"
          disabled={drafting}
          onClick={() => void draftUpdate()}
        >
          <PencilLineIcon />
          {drafting ? "Drafting…" : "Draft a Jira update"}
        </Button>
        {issue?.url ? (
          <Button
            size="compact"
            variant="ghost"
            render={<a href={issue.url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            Open in Jira
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** The right panel's Jira tab: every ticket linked to this thread, with its threads and PRs. */
export function JiraTicketPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environmentId = threadRef.environmentId;
  const snapshot = useJiraSnapshot(environmentId);
  if (snapshot === null || !snapshot.enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <TicketIcon className="size-5" />
        Jira is off. Turn it on in Settings, under Jira.
      </div>
    );
  }
  const keys = threadTicketKeys(snapshot, threadRef.threadId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {keys.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <TicketIcon className="size-5" />
            No ticket is linked to this thread. Link one from the ticket chip beside the title.
          </div>
        ) : (
          keys.map((key) => (
            <TicketCard
              key={key}
              environmentId={environmentId}
              threadRef={threadRef}
              snapshot={snapshot}
              issueKey={key}
            />
          ))
        )}
      </div>
      <div className="border-t border-border px-4 py-2">
        <JiraSyncStatus environmentId={environmentId} />
      </div>
    </div>
  );
}
