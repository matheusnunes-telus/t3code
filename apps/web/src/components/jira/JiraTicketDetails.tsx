import type {
  EnvironmentId,
  JiraIssue,
  JiraIssueDetails,
  JiraSprint,
  JiraStatusName,
} from "@t3tools/contracts";
import {
  CalendarIcon,
  ChevronDownIcon,
  FlagIcon,
  LoaderIcon,
  TagIcon,
  TimerIcon,
  UserIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { useJiraCommand } from "~/state/jira";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const JIRA_STATUSES: ReadonlyArray<JiraStatusName> = [
  "To Do",
  "In Progress",
  "Blocked",
  "Done",
];

/** Details older than this are read again when the ticket is shown. */
const DETAILS_STALE_MS = 10 * 60 * 1000;

const STATUS_VARIANT = {
  new: "secondary",
  indeterminate: "info",
  done: "success",
} as const;

/** The status badge, which moves the ticket in Jira when you pick another status. */
export function JiraStatusMenu({
  environmentId,
  issue,
}: {
  environmentId: EnvironmentId;
  issue: Pick<JiraIssue, "key" | "status" | "statusCategory">;
}) {
  const command = useJiraCommand(environmentId);
  const [moving, setMoving] = useState<JiraStatusName | null>(null);
  const move = async (status: JiraStatusName) => {
    setMoving(status);
    await command({ type: "setStatus", key: issue.key, status });
    setMoving(null);
  };
  return (
    <Menu>
      <MenuTrigger
        disabled={moving !== null}
        aria-label={`Change status of ${issue.key}`}
        render={<button type="button" className="cursor-pointer rounded-md" />}
      >
        <Badge size="sm" variant={STATUS_VARIANT[issue.statusCategory]}>
          {moving === null ? (
            issue.status
          ) : (
            <span className="inline-flex items-center gap-1">
              <LoaderIcon className="size-3 animate-spin" />
              {moving}
            </span>
          )}
          {moving === null ? <ChevronDownIcon className="size-3 opacity-70" /> : null}
        </Badge>
      </MenuTrigger>
      <MenuPopup align="start">
        {JIRA_STATUSES.map((status) => (
          <MenuItem
            key={status}
            disabled={status === issue.status}
            onClick={() => void move(status)}
          >
            {status}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

const sprintLabel = (sprint: Pick<JiraSprint, "name" | "state">) =>
  `${sprint.name}${sprint.state === "active" ? "" : ` (${sprint.state})`}`;

const CHIP_CLASS =
  "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-1.5 text-xs";

/** The sprint chip, which moves the ticket to another open sprint or the backlog. */
function JiraSprintMenu({
  environmentId,
  issueKey,
  current,
  sprints,
}: {
  environmentId: EnvironmentId;
  issueKey: string;
  current: JiraIssueDetails["sprint"];
  sprints: ReadonlyArray<JiraSprint>;
}) {
  const command = useJiraCommand(environmentId);
  const [moving, setMoving] = useState<string | null>(null);
  const move = async (sprintId: number | null, label: string) => {
    setMoving(label);
    await command({ type: "setSprint", key: issueKey, sprintId });
    setMoving(null);
  };
  const inOpenSprint = current !== null && current.state !== "closed";
  return (
    <Menu>
      <MenuTrigger
        disabled={moving !== null}
        aria-label={`Change sprint of ${issueKey}`}
        render={
          <button
            type="button"
            className={cn(CHIP_CLASS, "cursor-pointer hover:bg-accent data-popup-open:bg-accent")}
          />
        }
      >
        {moving !== null ? (
          <LoaderIcon className="size-3 shrink-0 animate-spin" />
        ) : (
          <TimerIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("min-w-0 truncate", current === null && "text-muted-foreground")}>
          {moving ?? (current ? sprintLabel(current) : "Backlog")}
        </span>
        {moving === null ? <ChevronDownIcon className="size-3 shrink-0 opacity-70" /> : null}
      </MenuTrigger>
      <MenuPopup align="start">
        {sprints.map((sprint) => (
          <MenuItem
            key={sprint.id}
            disabled={current?.id === sprint.id}
            onClick={() => void move(sprint.id, sprint.name)}
          >
            {sprintLabel(sprint)}
          </MenuItem>
        ))}
        <MenuItem disabled={!inOpenSprint} onClick={() => void move(null, "Backlog")}>
          Backlog
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function Chip({ children, tooltip }: { children: ReactNode; tooltip?: ReactNode }) {
  if (tooltip === undefined) return <span className={CHIP_CLASS}>{children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={CHIP_CLASS} />}>{children}</TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

const priorityTone = (priority: string) =>
  /highest|high|critical|blocker/i.test(priority)
    ? "text-destructive"
    : /medium/i.test(priority)
      ? "text-warning"
      : "text-muted-foreground";

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

const formatDay = (value: string | null) => {
  if (value === null) return null;
  // A date-only value (the due date) is a calendar day, not UTC midnight.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/** How many lines the description shows before "Show more". */
const DESCRIPTION_LINES = 4;

/** Sprint, priority, people, dates and description, read from Jira when the ticket is shown. */
export function JiraTicketDetails({
  environmentId,
  issueKey,
  details,
  sprints,
  now,
}: {
  environmentId: EnvironmentId;
  issueKey: string;
  details: JiraIssueDetails | undefined;
  sprints: ReadonlyArray<JiraSprint>;
  now: number;
}) {
  const command = useJiraCommand(environmentId);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const load = async () => {
    setLoading(true);
    await command({ type: "loadDetails", key: issueKey });
    setLoading(false);
  };
  const stale = details === undefined || Date.parse(details.fetchedAt) < now - DETAILS_STALE_MS;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- showing a ticket is what asks Jira for its details; the panel can open from the chip, the menu or a restored layout, so no single handler covers it.
  useEffect(() => {
    if (stale) void load();
    // Only a new ticket asks again; staleness is checked when it is shown.
  }, [issueKey]);

  if (details === undefined) {
    return loading ? (
      <div className="flex flex-col gap-2 pt-1" aria-label="Reading the ticket from Jira">
        <div className="flex gap-1.5">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-24" />
        </div>
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
    ) : (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Ticket details aren't loaded.
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          onClick={() => void load()}
        >
          Load
        </button>
      </p>
    );
  }

  const people = [
    `Assignee: ${details.assignee ?? "Unassigned"}`,
    `Reporter: ${details.reporter ?? "None"}`,
    details.createdAt ? `Created ${formatDay(details.createdAt)}` : null,
  ].filter(Boolean);
  const longDescription =
    details.description.length > 400 || details.description.split("\n").length > DESCRIPTION_LINES;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1.5">
        <JiraSprintMenu
          environmentId={environmentId}
          issueKey={issueKey}
          current={details.sprint}
          sprints={sprints}
        />
        {details.priority ? (
          <Chip tooltip="Priority">
            <FlagIcon
              aria-hidden
              className={cn("size-3 shrink-0", priorityTone(details.priority))}
            />
            {details.priority}
          </Chip>
        ) : null}
        <Chip
          tooltip={
            <span className="flex flex-col">
              {people.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          }
        >
          {details.assignee ? (
            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-info/20 text-3xs font-semibold">
              {initials(details.assignee)}
            </span>
          ) : (
            <UserIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{details.assignee ?? "Unassigned"}</span>
        </Chip>
        {details.dueDate ? (
          <Chip tooltip="Due date">
            <CalendarIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            {formatDay(details.dueDate)}
          </Chip>
        ) : null}
        {details.labels.map((label) => (
          <Chip key={label}>
            <TagIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            {label}
          </Chip>
        ))}
      </div>
      {details.description.length === 0 ? (
        <p className="text-xs text-muted-foreground">No description.</p>
      ) : (
        <div>
          <p
            className={cn(
              "text-xs leading-relaxed whitespace-pre-wrap",
              !expanded && "line-clamp-4",
            )}
          >
            {details.description}
          </p>
          {longDescription ? (
            <button
              type="button"
              className="mt-1 cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
