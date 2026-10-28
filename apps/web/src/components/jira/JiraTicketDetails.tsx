import type {
  EnvironmentId,
  JiraIssue,
  JiraIssueDetails,
  JiraStatusName,
} from "@t3tools/contracts";
import { ChevronDownIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { relativeAge, useJiraCommand } from "~/state/jira";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

const STATUSES: ReadonlyArray<JiraStatusName> = ["To Do", "In Progress", "Blocked", "Done"];

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
        {STATUSES.map((status) => (
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}

const formatDay = (value: string | null) => {
  if (value === null) return null;
  // A date-only value (the due date) is a calendar day, not UTC midnight.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/** Sprint, people, dates and description, read from Jira when the ticket is shown. */
export function JiraTicketDetails({
  environmentId,
  issueKey,
  details,
  now,
}: {
  environmentId: EnvironmentId;
  issueKey: string;
  details: JiraIssueDetails | undefined;
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
  // oxlint-disable-next-line t3code/react-effect-budget -- showing a ticket is what asks Jira for its details; the panel can open from the chip, the menu or a restored layout, so no single handler covers it.
  useEffect(() => {
    if (stale) void load();
    // Only a new ticket asks again; staleness is checked when it is shown.
  }, [issueKey]);

  if (details === undefined) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {loading ? <LoaderIcon className="size-3 animate-spin" /> : null}
        {loading ? "Reading the ticket from Jira…" : "Ticket details aren't loaded."}
        {loading ? null : (
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
            onClick={() => void load()}
          >
            Load
          </button>
        )}
      </p>
    );
  }

  const sprint = details.sprint
    ? `${details.sprint.name}${details.sprint.state === "active" ? "" : ` (${details.sprint.state})`}`
    : null;
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
        <Field label="Sprint">
          {sprint ?? <span className="text-muted-foreground">None</span>}
        </Field>
        <Field label="Priority">{details.priority ?? "None"}</Field>
        <Field label="Assignee">{details.assignee ?? "Unassigned"}</Field>
        <Field label="Reporter">{details.reporter ?? "None"}</Field>
        {details.labels.length > 0 ? (
          <Field label="Labels">{details.labels.join(", ")}</Field>
        ) : null}
        {details.dueDate ? <Field label="Due">{formatDay(details.dueDate)}</Field> : null}
        <Field label="Created">{formatDay(details.createdAt) ?? "None"}</Field>
      </dl>
      <div>
        <p className="mb-1 flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Description
          <span className="flex-1" />
          <button
            type="button"
            disabled={loading}
            aria-label="Read the ticket from Jira again"
            className="inline-flex cursor-pointer items-center gap-1 font-normal tracking-normal normal-case hover:text-foreground"
            onClick={() => void load()}
          >
            <RefreshCwIcon className={cn("size-3", loading && "animate-spin")} />
            read {relativeAge(details.fetchedAt, now)}
          </button>
        </p>
        {details.description.length === 0 ? (
          <p className="text-xs text-muted-foreground">No description.</p>
        ) : (
          <>
            <p
              className={cn(
                "text-xs leading-relaxed whitespace-pre-wrap",
                !expanded && "line-clamp-6",
              )}
            >
              {details.description}
            </p>
            {details.description.length > 400 || details.description.split("\n").length > 6 ? (
              <button
                type="button"
                className="mt-1 cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
