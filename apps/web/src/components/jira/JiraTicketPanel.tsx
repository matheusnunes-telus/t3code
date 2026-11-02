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
  ChevronDownIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  PencilLineIcon,
  TicketIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { useThreadShell, useThreadShells } from "~/state/entities";
import {
  issueByKey,
  issuePath,
  jiraSyncHealth,
  relativeAge,
  threadTicketKeys,
  ticketThreadIds,
  useJiraCommand,
  useJiraSnapshot,
} from "~/state/jira";
import { useMinuteClock } from "../gcp/useMinuteClock";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { JiraKey, JiraLevelTag, JiraTicketPath, JiraTicketThreads } from "./JiraTicketBits";
import { JiraSyncStatus } from "./JiraSyncStatus";
import { JiraStatusMenu, JiraTicketDetails } from "./JiraTicketDetails";

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

/** How many pull requests show before "Show N more". */
const PULL_REQUESTS_SHOWN = 3;

function TicketPullRequests({
  environmentId,
  threadIds,
}: {
  environmentId: EnvironmentId;
  threadIds: ReadonlyArray<ThreadId>;
}) {
  const shells = useThreadShells();
  const [showAll, setShowAll] = useState(false);
  const pullRequests = shells
    .filter((shell) => shell.environmentId === environmentId && threadIds.includes(shell.id))
    .flatMap((shell) => visibleThreadPullRequests(shell.pullRequests))
    .toSorted((a, b) => b.number - a.number);
  const stateOf = (pr: (typeof pullRequests)[number]) =>
    pr.snapshot?.isDraft ? "draft" : (pr.snapshot?.state ?? "open");
  const counts = (["merged", "open", "draft", "closed"] as const)
    .map((state) => ({ state, count: pullRequests.filter((pr) => stateOf(pr) === state).length }))
    .filter((entry) => entry.count > 0);
  const shown = showAll ? pullRequests : pullRequests.slice(0, PULL_REQUESTS_SHOWN);

  return (
    <div>
      <SectionLabel
        end={counts
          .map(
            ({ state, count }) =>
              `${count} ${PULL_REQUEST_STATE_PRESENTATION[state].label.toLowerCase()}`,
          )
          .join(" · ")}
      >
        Pull requests
      </SectionLabel>
      {pullRequests.length === 0 ? (
        <p className="px-1.5 text-xs text-muted-foreground">No pull requests yet.</p>
      ) : (
        <>
          <div aria-hidden className="mx-1.5 mb-1 flex h-1 gap-0.5 overflow-hidden rounded-full">
            {counts.map(({ state, count }) => (
              <span
                key={state}
                className={cn(
                  "bg-current opacity-70",
                  PULL_REQUEST_STATE_PRESENTATION[state].toneClassName,
                )}
                style={{ flexGrow: count }}
              />
            ))}
          </div>
          <ul className="flex flex-col">
            {shown.map((pr) => {
              const presentation = PULL_REQUEST_STATE_PRESENTATION[stateOf(pr)];
              return (
                <li key={`${pr.repository}#${pr.number}`}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-xs hover:bg-accent"
                        />
                      }
                    >
                      <presentation.Icon
                        aria-hidden
                        className={cn("size-3 shrink-0", presentation.toneClassName)}
                      />
                      <span className="shrink-0 font-mono text-muted-foreground">#{pr.number}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {pr.snapshot?.title ?? pr.repository}
                      </span>
                    </TooltipTrigger>
                    <TooltipPopup>
                      {presentation.label} · {pr.repository}
                    </TooltipPopup>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          {pullRequests.length > PULL_REQUESTS_SHOWN ? (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3 shrink-0 transition-transform", showAll && "rotate-180")}
              />
              {showAll ? "Show fewer" : `Show ${pullRequests.length - PULL_REQUESTS_SHOWN} more`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function SectionLabel({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1.5 pb-1">
      <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {children}
      </span>
      {end ? <span className="ms-auto truncate text-xs text-muted-foreground">{end}</span> : null}
    </div>
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
  const now = useMinuteClock();
  const syncing = snapshot.sync.status === "syncing";

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

  const details = snapshot.details[issueKey];
  const refreshLabel = [
    `Synced ${relativeAge(snapshot.sync.lastSyncedAt, now)}${
      snapshot.via === "cli"
        ? " with the Atlassian CLI"
        : snapshot.via === "mcp"
          ? " through Atlassian MCP"
          : ""
    }`,
    details ? `details read ${relativeAge(details.fetchedAt, now)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <section className="flex flex-col gap-3 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex flex-col gap-1.5 px-1.5">
        <div className="flex items-center gap-2">
          <TicketIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <JiraKey value={issueKey} />
          {issue ? <JiraStatusMenu environmentId={environmentId} issue={issue} /> : null}
          {issue ? <JiraLevelTag level={issue.level} /> : null}
          <span className="flex-1" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Read ${issueKey} from Jira again`}
                  disabled={syncing}
                  onClick={() => {
                    void command({ type: "sync" });
                    void command({ type: "loadDetails", key: issueKey });
                  }}
                />
              }
            >
              <RefreshIcon refreshing={syncing} />
            </TooltipTrigger>
            <TooltipPopup>{refreshLabel}. Refresh</TooltipPopup>
          </Tooltip>
          <TicketUpdatesToggle
            value={snapshot.ticketUpdates[issueKey] ?? "link"}
            onChange={(updates) => void command({ type: "ticketUpdates", key: issueKey, updates })}
          />
        </div>
        <h3 className="text-sm leading-snug font-semibold">
          {issue?.summary ?? "Not in the synced tree yet"}
        </h3>
        <JiraTicketPath snapshot={snapshot} issueKey={issueKey} />
        <div className="pt-1">
          <JiraTicketDetails
            environmentId={environmentId}
            issueKey={issueKey}
            details={details}
            sprints={snapshot.sprints}
            now={now}
          />
        </div>
      </div>
      <div>
        <SectionLabel end={threadIds.length > 1 ? String(threadIds.length) : undefined}>
          Threads
        </SectionLabel>
        <JiraTicketThreads
          environmentId={environmentId}
          threadIds={threadIds}
          currentThreadId={threadRef.threadId}
        />
      </div>
      <TicketPullRequests environmentId={environmentId} threadIds={threadIds} />
      <div className="flex flex-wrap gap-1.5 px-1.5">
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
  const now = useMinuteClock();
  if (snapshot === null || !snapshot.enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <TicketIcon className="size-5" />
        Jira is off. Turn it on in Settings, under Jira.
      </div>
    );
  }
  const keys = threadTicketKeys(snapshot, threadRef.threadId);
  // A healthy sync is in each ticket's refresh tooltip; the footer is for problems and sign-in.
  const health = jiraSyncHealth(snapshot, now);
  const showSyncStatus = keys.length === 0 || (health !== "ok" && health !== "syncing");
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
      {showSyncStatus ? (
        <div className="border-t border-border px-4 py-2">
          <JiraSyncStatus environmentId={environmentId} />
        </div>
      ) : null}
    </div>
  );
}
