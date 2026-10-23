import type {
  EnvironmentId,
  JiraChange,
  JiraChangeSet,
  JiraSnapshot,
  JiraThreadSuggestion,
  JiraTicketDraft,
  ThreadId,
} from "@t3tools/contracts";
import { TicketIcon } from "lucide-react";
import { useState } from "react";

import { issueByKey, useJiraCommand, useJiraSnapshot } from "~/state/jira";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { JiraKey, JiraStatusBadge, JiraTicketPath } from "./JiraTicketBits";

type Command = ReturnType<typeof useJiraCommand>;

function MatchDetails({
  snapshot,
  suggestion,
  command,
}: {
  snapshot: JiraSnapshot;
  suggestion: JiraThreadSuggestion;
  command: Command;
}) {
  const [best, ...others] = suggestion.matches;
  if (best === undefined) return null;
  const issue = issueByKey(snapshot, best.key);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <JiraTicketPath snapshot={snapshot} issueKey={best.key} />
      <div className="flex min-w-0 items-center gap-2">
        <JiraKey value={best.key} />
        <span className="min-w-0 truncate font-medium">{issue?.summary ?? best.key}</span>
        {issue ? <JiraStatusBadge issue={issue} /> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {issue ? `${issue.type} · ` : ""}
        {best.reason}
      </p>
      {others.length > 0 ? (
        <ul className="mt-1 flex flex-col border-t border-border pt-1">
          {others.map((match) => {
            const other = issueByKey(snapshot, match.key);
            return (
              <li key={match.key} className="flex min-w-0 items-center gap-2 py-0.5 text-xs">
                <JiraKey value={match.key} />
                <span className="min-w-0 flex-1 truncate">{other?.summary ?? match.key}</span>
                <span className="shrink-0 text-muted-foreground">{match.confidence}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void command({
                      type: "link",
                      threadId: suggestion.threadId,
                      key: match.key,
                      linked: true,
                    })
                  }
                >
                  Link
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** The new ticket T3 drafted, editable before it goes to Jira. */
function DraftEditor({
  snapshot,
  draft,
  onChange,
  message,
}: {
  snapshot: JiraSnapshot;
  draft: JiraTicketDraft;
  onChange: (draft: JiraTicketDraft) => void;
  message: string | null;
}) {
  const parents = snapshot.issues
    .filter((issue) => issue.statusCategory !== "done" && (issue.level === 0 || issue.level === 1))
    .toSorted((a, b) => b.level - a.level || a.key.localeCompare(b.key));
  return (
    <div className="flex flex-col gap-2 text-sm">
      <JiraTicketPath snapshot={snapshot} issueKey={draft.parentKey} />
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input
          size="sm"
          aria-label="New ticket title"
          value={draft.summary}
          onChange={(event) => onChange({ ...draft, summary: event.currentTarget.value })}
        />
        <select
          aria-label="Parent"
          value={draft.parentKey}
          onChange={(event) => {
            const parent = issueByKey(snapshot, event.currentTarget.value);
            if (parent === undefined) return;
            onChange({
              ...draft,
              parentKey: parent.key,
              type: parent.level === 1 ? "Task" : "Sub-task",
            });
          }}
          className="h-8 max-w-56 rounded-md border border-input bg-background px-2 text-xs"
        >
          {parents.map((parent) => (
            <option key={parent.key} value={parent.key}>
              {parent.level === 1 ? "Task under" : "Sub-task under"} {parent.key} ·{" "}
              {parent.summary.slice(0, 40)}
            </option>
          ))}
        </select>
      </div>
      <Textarea
        size="sm"
        aria-label="New ticket description"
        value={draft.description}
        onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })}
      />
      {message ? <p className="text-xs text-destructive-foreground">{message}</p> : null}
    </div>
  );
}

function suggestionBanner(input: {
  snapshot: JiraSnapshot;
  suggestion: JiraThreadSuggestion;
  command: Command;
  draft: JiraTicketDraft | null;
  setDraft: (draft: JiraTicketDraft) => void;
}): ComposerBannerStackItem | null {
  const { snapshot, suggestion, command } = input;
  const threadId = suggestion.threadId;
  const dismiss = () => void command({ type: "suggestion", threadId, action: "dismiss" });
  const id = `jira-suggestion:${threadId}`;
  switch (suggestion.state) {
    case "dismissed":
      return null;
    case "matching":
      return {
        id,
        variant: "default",
        priority: "activity",
        icon: <Spinner className="size-4" />,
        title: "Looking for this thread's Jira ticket…",
      };
    case "creating":
      return {
        id,
        variant: "default",
        priority: "activity",
        icon: <Spinner className="size-4" />,
        title: "Creating the ticket in Jira…",
      };
    case "failed":
      return {
        id,
        variant: "warning",
        icon: <TicketIcon />,
        title: "Couldn't look for a Jira ticket",
        description: suggestion.message ?? undefined,
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void command({ type: "suggestion", threadId, action: "rematch" })}
          >
            Retry
          </Button>
        ),
        dismissLabel: "Dismiss",
        onDismiss: dismiss,
      };
    case "ready": {
      const best = suggestion.matches[0];
      if (best !== undefined) {
        return {
          id,
          variant: "info",
          icon: <TicketIcon />,
          title: `Likely ticket · ${best.confidence} match`,
          children: <MatchDetails snapshot={snapshot} suggestion={suggestion} command={command} />,
          actions: (
            <>
              <Button
                size="xs"
                onClick={() =>
                  void command({ type: "link", threadId, key: best.key, linked: true })
                }
              >
                Link {best.key}
              </Button>
              <Button size="xs" variant="ghost" onClick={dismiss}>
                Not a ticket
              </Button>
            </>
          ),
        };
      }
      const draft = input.draft ?? suggestion.draft;
      if (draft === null) return null;
      return {
        id,
        variant: suggestion.message ? "warning" : "info",
        icon: <TicketIcon />,
        title: "No matching ticket. Create one?",
        children: (
          <DraftEditor
            snapshot={snapshot}
            draft={draft}
            onChange={input.setDraft}
            message={suggestion.message}
          />
        ),
        actions: (
          <>
            <Button
              size="xs"
              disabled={draft.summary.trim().length === 0}
              onClick={() => void command({ type: "createTicket", threadId, draft })}
            >
              Create and link
            </Button>
            <Button size="xs" variant="ghost" onClick={dismiss}>
              Not a ticket
            </Button>
          </>
        ),
      };
    }
  }
}

const changeKey = (change: JiraChange) => change.kind;

function ChangeList({
  set,
  chosen,
  onChange,
}: {
  set: JiraChangeSet;
  chosen: ReadonlyArray<JiraChange>;
  onChange: (changes: ReadonlyArray<JiraChange>) => void;
}) {
  const isChosen = (change: JiraChange) => chosen.some((entry) => entry.kind === change.kind);
  const toggle = (change: JiraChange, on: boolean) =>
    onChange(
      on
        ? [...chosen.filter((entry) => entry.kind !== change.kind), change]
        : chosen.filter((entry) => entry.kind !== change.kind),
    );
  const edit = (change: JiraChange) =>
    onChange(chosen.map((entry) => (entry.kind === change.kind ? change : entry)));
  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {set.changes.map((change) => {
        const current = chosen.find((entry) => entry.kind === change.kind) ?? change;
        return (
          <li key={changeKey(change)} className="flex flex-col gap-1.5 py-1.5">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={isChosen(change)}
                onCheckedChange={(checked) => toggle(current, checked === true)}
              />
              {change.kind === "status" ? (
                <span>
                  Status → <span className="font-medium">{change.to}</span>
                </span>
              ) : change.kind === "comment" ? (
                <span>Comment</span>
              ) : (
                <span>Description</span>
              )}
            </label>
            {current.kind === "comment" ? (
              <Textarea
                size="sm"
                aria-label="Comment"
                value={current.body}
                disabled={!isChosen(change)}
                onChange={(event) => edit({ ...current, body: event.currentTarget.value })}
              />
            ) : null}
            {current.kind === "description" ? (
              <div className="rounded-md bg-background px-2 py-1.5 font-mono text-xs">
                {current.from.trim().length > 0 ? (
                  <p className="text-destructive-foreground line-through">
                    {current.from.slice(0, 400)}
                  </p>
                ) : null}
                <p className="text-success-foreground">{current.to}</p>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function changeSetBanner(input: {
  set: JiraChangeSet;
  command: Command;
  chosen: ReadonlyArray<JiraChange>;
  setChosen: (changes: ReadonlyArray<JiraChange>) => void;
}): ComposerBannerStackItem | null {
  const { set, command, chosen } = input;
  const id = `jira-changes:${set.id}`;
  const dismiss = () => void command({ type: "resolveChanges", id: set.id, action: "dismiss" });
  if (set.state === "applying") {
    return {
      id,
      variant: "default",
      priority: "activity",
      icon: <Spinner className="size-4" />,
      title: `Updating ${set.key} in Jira…`,
    };
  }
  if (set.state !== "pending" && set.state !== "failed") return null;
  if (set.changes.length === 0) {
    return {
      id,
      variant: "default",
      icon: <TicketIcon />,
      title: `${set.key}: nothing to update right now`,
      description: set.reason,
      dismissLabel: "Dismiss",
      onDismiss: dismiss,
    };
  }
  const apply = () =>
    void command({ type: "resolveChanges", id: set.id, action: "apply", changes: chosen });
  return {
    id,
    variant: "warning",
    priority: "urgent",
    icon: <TicketIcon />,
    title: `Jira changes for ${set.key}`,
    description: set.state === "failed" ? (set.message ?? "The update failed.") : set.reason,
    children: <ChangeList set={set} chosen={chosen} onChange={input.setChosen} />,
    actions: (
      <>
        <Button size="xs" disabled={chosen.length === 0} onClick={apply}>
          {set.state === "failed"
            ? "Retry"
            : `Apply ${chosen.length} change${chosen.length === 1 ? "" : "s"}`}
        </Button>
        <Button size="xs" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      </>
    ),
  };
}

/** Jira's cards above the message box: the ticket suggestion and changes waiting to apply. */
export function useJiraComposerBanners(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ComposerBannerStackItem[] {
  const snapshot = useJiraSnapshot(environmentId);
  const command = useJiraCommand(environmentId);
  const [draft, setDraft] = useState<{ threadId: ThreadId; draft: JiraTicketDraft } | null>(null);
  const [chosen, setChosen] = useState<Record<string, ReadonlyArray<JiraChange>>>({});
  if (snapshot === null || !snapshot.enabled || threadId === null) return [];
  const items: ComposerBannerStackItem[] = [];
  const suggestion = snapshot.suggestions.find((entry) => entry.threadId === threadId);
  const linked = snapshot.links.some((link) => link.threadId === threadId);
  if (suggestion !== undefined && !linked) {
    const item = suggestionBanner({
      snapshot,
      suggestion,
      command,
      draft: draft?.threadId === threadId ? draft.draft : null,
      setDraft: (next) => setDraft({ threadId, draft: next }),
    });
    if (item !== null) items.push(item);
  }
  for (const set of snapshot.changeSets) {
    if (set.threadId !== threadId) continue;
    const item = changeSetBanner({
      set,
      command,
      chosen: chosen[set.id] ?? set.changes,
      setChosen: (changes) => setChosen((current) => ({ ...current, [set.id]: changes })),
    });
    if (item !== null) items.push(item);
  }
  return items;
}
