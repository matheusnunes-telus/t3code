import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, JiraIssue, JiraSnapshot, ThreadId } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { issueByKey } from "~/state/jira";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { JiraKey, JiraLevelTag, JiraStatusBadge } from "./JiraTicketBits";

export type SidebarGroupBy = "project" | "ticket";

const GROUP_BY_STORAGE_KEY = "t3code:sidebar-group-by";
const UNLINKED_PREVIEW_COUNT = 8;

function readGroupBy(): SidebarGroupBy {
  try {
    return window.localStorage.getItem(GROUP_BY_STORAGE_KEY) === "ticket" ? "ticket" : "project";
  } catch {
    return "project";
  }
}

/** Projects or tickets, remembered per browser. */
export function useSidebarGroupBy(): [SidebarGroupBy, (value: SidebarGroupBy) => void] {
  const [value, setValue] = useState<SidebarGroupBy>(readGroupBy);
  return [
    value,
    (next) => {
      setValue(next);
      try {
        window.localStorage.setItem(GROUP_BY_STORAGE_KEY, next);
      } catch {
        // Not remembered; the choice still holds for this session.
      }
    },
  ];
}

export function SidebarGroupByToggle({
  value,
  onChange,
}: {
  value: SidebarGroupBy;
  onChange: (value: SidebarGroupBy) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Group threads by"
      className="inline-flex items-center gap-0.5 rounded-md bg-sidebar-control-surface p-0.5"
    >
      {(["project", "ticket"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "cursor-pointer rounded-sm px-1.5 text-xs leading-5 outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            value === option
              ? "bg-background text-foreground shadow-xs dark:bg-input"
              : "text-sidebar-muted-foreground/80 hover:text-foreground",
          )}
        >
          {option === "project" ? "Projects" : "Tickets"}
        </button>
      ))}
    </div>
  );
}

/** The epic (or initiative) a ticket's threads are filed under in the sidebar. */
function groupKeyOf(snapshot: JiraSnapshot, issue: JiraIssue | undefined, key: string): string {
  let current = issue;
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    if (current.level >= 1) return current.key;
    if (current.parentKey === null) return current.key;
    current = issueByKey(snapshot, current.parentKey);
  }
  return key;
}

function ThreadRow({
  shell,
  active,
  indent,
}: {
  shell: EnvironmentThreadShell;
  active: boolean;
  indent: number;
}) {
  const navigate = useNavigate();
  const pullRequest = visibleThreadPullRequests(shell.pullRequests)[0];
  return (
    <li>
      <button
        type="button"
        data-active={active}
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
          })
        }
        style={{ paddingLeft: `${0.5 + indent * 0.75}rem` }}
        className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg pr-2 text-left text-sm text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[active=true]:bg-sidebar-row-selected"
      >
        <span className="min-w-0 flex-1 truncate">{shell.title}</span>
        {pullRequest ? (
          <span className="shrink-0 font-mono text-3xs text-sidebar-muted-foreground">
            #{pullRequest.number}
            {pullRequest.snapshot?.state === "merged" ? " ✓" : ""}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function TicketRow({
  issue,
  issueKey,
  indent,
}: {
  issue: JiraIssue | undefined;
  issueKey: string;
  indent: number;
}) {
  return (
    <li
      style={{ paddingLeft: `${0.5 + indent * 0.75}rem` }}
      className="flex h-6 min-w-0 items-center gap-1.5 pr-2 text-xs text-sidebar-muted-foreground"
    >
      <JiraKey value={issueKey} />
      <span className="min-w-0 flex-1 truncate">{issue?.summary ?? ""}</span>
      {issue ? <JiraStatusBadge issue={issue} /> : null}
    </li>
  );
}

/**
 * Threads filed by the Jira tickets they link: epics are the groups, tasks and sub-tasks sit
 * under them, threads under those. Threads with no ticket come last.
 */
export function JiraSidebarTicketList({
  environmentId,
  snapshot,
  routeThreadKey,
}: {
  environmentId: EnvironmentId;
  snapshot: JiraSnapshot;
  routeThreadKey: string | null;
}) {
  const [showAllUnlinked, setShowAllUnlinked] = useState(false);
  const shells = useThreadShells().filter(
    (shell) => shell.environmentId === environmentId && shell.archivedAt === null,
  );
  const shellById = new Map(shells.map((shell) => [shell.id, shell]));
  const isActive = (threadId: ThreadId) =>
    routeThreadKey === scopedThreadKey(scopeThreadRef(environmentId, threadId));

  // ticket key -> its threads, for tickets with at least one live thread.
  const threadsByKey = new Map<string, EnvironmentThreadShell[]>();
  for (const link of snapshot.links) {
    const shell = shellById.get(link.threadId);
    if (shell === undefined) continue;
    threadsByKey.set(link.key, [...(threadsByKey.get(link.key) ?? []), shell]);
  }
  // group key -> ticket keys under it.
  const groups = new Map<string, string[]>();
  for (const key of threadsByKey.keys()) {
    const group = groupKeyOf(snapshot, issueByKey(snapshot, key), key);
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }
  const linkedThreadIds = new Set(
    snapshot.links.filter((link) => shellById.has(link.threadId)).map((link) => link.threadId),
  );
  const unlinked = shells
    .filter((shell) => !linkedThreadIds.has(shell.id) && shell.settledAt === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleUnlinked = showAllUnlinked ? unlinked : unlinked.slice(0, UNLINKED_PREVIEW_COUNT);

  return (
    <div className="flex flex-col gap-1" data-jira-sidebar>
      {[...groups.entries()].map(([groupKey, keys]) => {
        const group = issueByKey(snapshot, groupKey);
        const initiative =
          group?.parentKey === null || group === undefined
            ? undefined
            : issueByKey(snapshot, group.parentKey);
        // A task's sub-tasks sit under it; everything else is a direct child of the group.
        const topKeys = keys
          .filter((key) => {
            const parent = issueByKey(snapshot, key)?.parentKey;
            return parent === null || parent === undefined || !keys.includes(parent);
          })
          .toSorted();
        return (
          <section key={groupKey} className="flex flex-col">
            <Tooltip>
              <TooltipTrigger
                render={
                  <div className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-xs text-sidebar-muted-foreground" />
                }
              >
                {group ? <JiraLevelTag level={group.level} /> : null}
                <JiraKey value={groupKey} />
                <span className="min-w-0 truncate">{group?.summary ?? ""}</span>
              </TooltipTrigger>
              <TooltipPopup side="right">
                {initiative
                  ? `${initiative.key} · ${initiative.summary}`
                  : (group?.summary ?? groupKey)}
              </TooltipPopup>
            </Tooltip>
            <ul className="flex flex-col">
              {topKeys.map((key) => {
                const children = keys.filter(
                  (child) => child !== key && issueByKey(snapshot, child)?.parentKey === key,
                );
                return (
                  <li key={key}>
                    <ul className="flex flex-col">
                      {key === groupKey ? null : (
                        <TicketRow issue={issueByKey(snapshot, key)} issueKey={key} indent={1} />
                      )}
                      {(threadsByKey.get(key) ?? []).map((shell) => (
                        <ThreadRow
                          key={shell.id}
                          shell={shell}
                          active={isActive(shell.id)}
                          indent={key === groupKey ? 1 : 2}
                        />
                      ))}
                      {children.map((child) => (
                        <li key={child}>
                          <ul className="flex flex-col">
                            <TicketRow
                              issue={issueByKey(snapshot, child)}
                              issueKey={child}
                              indent={2}
                            />
                            {(threadsByKey.get(child) ?? []).map((shell) => (
                              <ThreadRow
                                key={shell.id}
                                shell={shell}
                                active={isActive(shell.id)}
                                indent={3}
                              />
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {groups.size === 0 ? (
        <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
          No thread is linked to a ticket yet.
        </p>
      ) : null}
      {unlinked.length > 0 ? (
        <section className="flex flex-col">
          <div className="flex h-6 items-center px-2 text-xs text-sidebar-muted-foreground/70">
            No ticket
          </div>
          <ul className="flex flex-col">
            {visibleUnlinked.map((shell) => (
              <ThreadRow key={shell.id} shell={shell} active={isActive(shell.id)} indent={1} />
            ))}
          </ul>
          {unlinked.length > UNLINKED_PREVIEW_COUNT ? (
            <button
              type="button"
              onClick={() => setShowAllUnlinked((value) => !value)}
              className="cursor-pointer px-5 py-1 text-left text-xs text-sidebar-muted-foreground hover:text-foreground"
            >
              {showAllUnlinked ? "Show less" : `Show all (${unlinked.length})`}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
