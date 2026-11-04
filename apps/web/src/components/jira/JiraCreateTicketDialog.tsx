import type {
  EnvironmentId,
  JiraSnapshot,
  JiraStatusName,
  JiraTicketFormDraft,
  ThreadId,
} from "@t3tools/contracts";
import { LoaderIcon, SparklesIcon } from "lucide-react";
import { type ReactElement, useState } from "react";

import { issueByKey, levelLabel, useJiraCommand } from "~/state/jira";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { JiraKey } from "./JiraTicketBits";

const BACKLOG = "backlog";

/** A ticket made from a chat is usually for the work happening now. */
export const NEW_TICKET_STATUS: JiraStatusName = "In Progress";
export const NEW_TICKET_STATUSES: ReadonlyArray<JiraStatusName> = ["To Do", "In Progress"];

/** The model's draft for the dialog, started by the click that opens it. */
export type JiraDraftRequest =
  | { readonly status: "drafting" }
  | { readonly status: "ready"; readonly draft: JiraTicketFormDraft | null }
  | { readonly status: "failed" };

/** Opens the new ticket dialog and starts the model's draft from the chat as it is now. */
export function useJiraCreateTicket({
  environmentId,
  threadId,
  snapshot,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshot: JiraSnapshot;
}): { open: () => void; dialog: ReactElement } {
  const command = useJiraCommand(environmentId);
  const [isOpen, setOpen] = useState(false);
  const [request, setRequest] = useState<JiraDraftRequest>({ status: "drafting" });
  const open = () => {
    const pending: JiraDraftRequest = { status: "drafting" };
    setRequest(pending);
    setOpen(true);
    void command({ type: "draftTicket", threadId }).then((result) =>
      setRequest((current) =>
        current !== pending
          ? current
          : result !== null && result._tag === "Success"
            ? { status: "ready", draft: result.value }
            : { status: "failed" },
      ),
    );
  };
  return {
    open,
    dialog: (
      <JiraCreateTicketDialog
        open={isOpen}
        onOpenChange={setOpen}
        environmentId={environmentId}
        threadId={threadId}
        snapshot={snapshot}
        request={request}
      />
    ),
  };
}

/**
 * A new ticket for this chat. The Jira model fills it in from the chat when it opens; nothing
 * reaches Jira until Create, which also links the ticket to the chat.
 */
export function JiraCreateTicketDialog({
  open,
  onOpenChange,
  environmentId,
  threadId,
  snapshot,
  request,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshot: JiraSnapshot;
  request: JiraDraftRequest;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        {/* Mounted per opening, so each one starts from that opening's draft. */}
        {open ? (
          <CreateTicketForm
            environmentId={environmentId}
            threadId={threadId}
            snapshot={snapshot}
            request={request}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function CreateTicketForm({
  environmentId,
  threadId,
  snapshot,
  request,
  onDone,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshot: JiraSnapshot;
  request: JiraDraftRequest;
  onDone: () => void;
}) {
  const command = useJiraCommand(environmentId);
  const [parentKey, setParentKey] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  // Work started from a chat is usually for now, so the active sprint comes first.
  const [sprintValue, setSprintValue] = useState(() => {
    const active = snapshot.sprints.find((sprint) => sprint.state === "active");
    return active === undefined ? BACKLOG : String(active.id);
  });
  const sprint = snapshot.sprints.find((candidate) => String(candidate.id) === sprintValue);
  const [status, setStatus] = useState<JiraStatusName>(NEW_TICKET_STATUS);
  // When the draft lands, it fills only the fields the user hasn't typed into yet.
  const [appliedRequest, setAppliedRequest] = useState<JiraDraftRequest | null>(null);
  if (appliedRequest !== request) {
    setAppliedRequest(request);
    if (request.status === "ready" && request.draft !== null) {
      const { draft } = request;
      setParentKey((current) => current || (draft.parentKey ?? ""));
      setSummary((current) => current || draft.summary);
      setDescription((current) => current || draft.description);
    }
  }
  // Epics take tasks and tasks take sub-tasks; initiatives and sub-tasks can't be parents here.
  const parents = snapshot.issues
    .filter((issue) => issue.statusCategory !== "done" && (issue.level === 1 || issue.level === 0))
    .toSorted((a, b) => b.level - a.level || a.key.localeCompare(b.key));
  const parent = parentKey ? issueByKey(snapshot, parentKey) : undefined;

  const canCreate = parent !== undefined && summary.trim().length > 0;
  const create = () => {
    if (!parent) return;
    void command({
      type: "createTicket",
      threadId,
      draft: {
        parentKey: parent.key,
        type: parent.level === 1 ? "Task" : "Sub-task",
        summary: summary.trim(),
        description: description.trim(),
        sprintId: sprint?.id ?? null,
        status,
      },
    });
    onDone();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New Jira ticket</DialogTitle>
        <DialogDescription>
          {request.status === "drafting" ? (
            <span className="inline-flex items-center gap-1.5">
              <LoaderIcon className="size-3.5 animate-spin" />
              Drafting from this chat…
            </span>
          ) : request.status === "failed" ? (
            "Couldn't draft from this chat. Fill it in below."
          ) : request.draft !== null ? (
            <span className="inline-flex items-center gap-1.5">
              <SparklesIcon className="size-3.5" />
              {request.draft.parentKey === null
                ? "Drafted from this chat. No parent in your tree fits, so pick one."
                : "Drafted from this chat. Edit anything before creating it."}
            </span>
          ) : (
            "Couldn't draft from this chat. Fill it in below."
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Parent</span>
            <Select value={parentKey} onValueChange={(value) => setParentKey(value ?? "")}>
              <SelectTrigger size="sm" aria-label="Parent ticket">
                <SelectValue>
                  {parent ? (
                    <span className="flex min-w-0 items-center gap-2">
                      <JiraKey value={parent.key} />
                      <span className="truncate">{parent.summary}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Choose an epic or task</span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup className="max-h-80">
                {parents.map((issue) => (
                  <SelectItem key={issue.key} hideIndicator value={issue.key}>
                    <span className="flex min-w-0 items-center gap-2">
                      <JiraKey value={issue.key} />
                      <span className="min-w-0 flex-1 truncate">{issue.summary}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {levelLabel(issue.level)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {parent ? (
              <span className="text-xs text-muted-foreground">
                Creates a {parent.level === 1 ? "task" : "sub-task"} under {parent.key}, assigned to
                you.
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Sprint</span>
            <Select value={sprintValue} onValueChange={(value) => setSprintValue(value ?? BACKLOG)}>
              <SelectTrigger size="sm" aria-label="Sprint">
                <SelectValue>
                  {sprint ? (
                    <span className="truncate">
                      {sprint.name}
                      {sprint.state === "active" ? null : (
                        <span className="text-muted-foreground"> · {sprint.state}</span>
                      )}
                    </span>
                  ) : (
                    "Backlog"
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {snapshot.sprints.map((candidate) => (
                  <SelectItem key={candidate.id} hideIndicator value={String(candidate.id)}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                      <span className="shrink-0 text-muted-foreground">{candidate.state}</span>
                    </span>
                  </SelectItem>
                ))}
                <SelectItem hideIndicator value={BACKLOG}>
                  Backlog
                </SelectItem>
              </SelectPopup>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Status</span>
            <Select
              value={status}
              onValueChange={(value) => setStatus(value ?? NEW_TICKET_STATUS)}
            >
              <SelectTrigger size="sm" aria-label="Status">
                <SelectValue>{status}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {NEW_TICKET_STATUSES.map((candidate) => (
                  <SelectItem key={candidate} hideIndicator value={candidate}>
                    {candidate}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Summary</span>
            <Input
              size="sm"
              value={summary}
              placeholder={request.status === "drafting" ? "Drafting…" : "What the ticket is for"}
              onChange={(event) => setSummary(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Description</span>
            <Textarea
              value={description}
              rows={4}
              placeholder={request.status === "drafting" ? "Drafting…" : "Optional"}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={!canCreate} onClick={create}>
          Create and link
        </Button>
      </DialogFooter>
    </>
  );
}
