import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Jira is reached only through an agent with the Atlassian connector, so the server keeps a
 * trimmed copy of the user's open tickets and shows its age instead of reading Jira live.
 */
export const JiraIssueKey = TrimmedNonEmptyString;
export type JiraIssueKey = typeof JiraIssueKey.Type;

/** Jira's own hierarchy numbers: initiative 2, epic 1, task/story/bug 0, sub-task -1. */
export const JiraHierarchyLevel = Schema.Int;

export const JiraStatusCategory = Schema.Literals(["new", "indeterminate", "done"]);
export type JiraStatusCategory = typeof JiraStatusCategory.Type;

export const JiraIssue = Schema.Struct({
  key: JiraIssueKey,
  summary: Schema.String,
  type: Schema.String,
  level: JiraHierarchyLevel,
  status: Schema.String,
  statusCategory: JiraStatusCategory,
  parentKey: Schema.NullOr(JiraIssueKey),
  /** False for a parent fetched only to show the path above the user's own tickets. */
  assignedToMe: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
});
export type JiraIssue = typeof JiraIssue.Type;

/** The statuses every ticket can move between; Jira's transitions are global for these. */
export const JiraStatusName = Schema.Literals(["To Do", "In Progress", "Blocked", "Done"]);
export type JiraStatusName = typeof JiraStatusName.Type;

/** A sprint seen on the user's projects' open tickets: the active one and any upcoming. */
export const JiraSprint = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  state: Schema.String,
  boardId: Schema.Int,
});
export type JiraSprint = typeof JiraSprint.Type;

/** What the panel shows beyond the synced tree, fetched when a ticket is opened. */
export const JiraIssueDetails = Schema.Struct({
  key: JiraIssueKey,
  fetchedAt: IsoDateTime,
  description: Schema.String,
  priority: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(Schema.String),
  reporter: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  /** The active sprint the ticket is in, else its upcoming or latest one. */
  sprint: Schema.NullOr(
    Schema.Struct({
      /** Optional so details read before sprints could be changed still load. */
      id: Schema.optionalKey(Schema.Int),
      name: Schema.String,
      state: Schema.String,
    }),
  ),
  createdAt: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
});
export type JiraIssueDetails = typeof JiraIssueDetails.Type;

export const JiraSyncStatus = Schema.Literals([
  "off",
  "never",
  "syncing",
  "ok",
  "failed",
  "signed-out",
  "unavailable",
]);
export type JiraSyncStatus = typeof JiraSyncStatus.Type;

export const JiraSyncState = Schema.Struct({
  status: JiraSyncStatus,
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
});
export type JiraSyncState = typeof JiraSyncState.Type;

export const JiraThreadLinkSource = Schema.Literals(["suggestion", "manual", "created"]);
export type JiraThreadLinkSource = typeof JiraThreadLinkSource.Type;

export const JiraThreadLink = Schema.Struct({
  threadId: ThreadId,
  key: JiraIssueKey,
  linkedAt: IsoDateTime,
  source: JiraThreadLinkSource,
});
export type JiraThreadLink = typeof JiraThreadLink.Type;

export const JiraMatchConfidence = Schema.Literals(["high", "medium", "low"]);
export type JiraMatchConfidence = typeof JiraMatchConfidence.Type;

export const JiraTicketMatch = Schema.Struct({
  key: JiraIssueKey,
  confidence: JiraMatchConfidence,
  reason: Schema.String,
});
export type JiraTicketMatch = typeof JiraTicketMatch.Type;

export const JiraTicketDraft = Schema.Struct({
  parentKey: JiraIssueKey,
  /** "Task" under an epic, "Sub-task" under a task. */
  type: Schema.Literals(["Task", "Sub-task"]),
  summary: TrimmedNonEmptyString,
  description: Schema.String,
  /** Null or missing leaves the ticket in the backlog. */
  sprintId: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});
export type JiraTicketDraft = typeof JiraTicketDraft.Type;

export const JiraSuggestionState = Schema.Literals([
  "matching",
  "ready",
  "creating",
  "dismissed",
  "failed",
]);
export type JiraSuggestionState = typeof JiraSuggestionState.Type;

export const JiraThreadSuggestion = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
  state: JiraSuggestionState,
  matches: Schema.Array(JiraTicketMatch),
  draft: Schema.NullOr(JiraTicketDraft),
  message: Schema.NullOr(Schema.String),
});
export type JiraThreadSuggestion = typeof JiraThreadSuggestion.Type;

export const JiraChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status"), to: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("comment"), body: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("description"), from: Schema.String, to: Schema.String }),
]);
export type JiraChange = typeof JiraChange.Type;

export const JiraChangeSetState = Schema.Literals([
  "pending",
  "applying",
  "applied",
  "failed",
  "dismissed",
]);
export type JiraChangeSetState = typeof JiraChangeSetState.Type;

/** Changes to one ticket that wait for the user; nothing reaches Jira before they apply them. */
export const JiraChangeSet = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  key: JiraIssueKey,
  createdAt: IsoDateTime,
  reason: Schema.String,
  changes: Schema.Array(JiraChange),
  state: JiraChangeSetState,
  message: Schema.NullOr(Schema.String),
});
export type JiraChangeSet = typeof JiraChangeSet.Type;

export const JiraTicketUpdates = Schema.Literals(["link", "notify"]);
export type JiraTicketUpdates = typeof JiraTicketUpdates.Type;

export const JiraTicketNotice = Schema.Struct({
  key: JiraIssueKey,
  at: IsoDateTime,
  summary: Schema.String,
});
export type JiraTicketNotice = typeof JiraTicketNotice.Type;

export const JiraSnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  sync: JiraSyncState,
  /** The site's address for ticket links, once a sync has found it. */
  siteUrl: Schema.NullOr(Schema.String),
  issues: Schema.Array(JiraIssue),
  links: Schema.Array(JiraThreadLink),
  suggestions: Schema.Array(JiraThreadSuggestion),
  changeSets: Schema.Array(JiraChangeSet),
  ticketUpdates: Schema.Record(Schema.String, JiraTicketUpdates),
  notices: Schema.Array(JiraTicketNotice),
  details: Schema.Record(Schema.String, JiraIssueDetails),
  sprints: Schema.Array(JiraSprint),
  /** How a lost login is fixed: T3 runs the Atlassian CLI's browser login, or claude.ai's connector. */
  signIn: Schema.Literals(["cli", "connector"]),
});
export type JiraSnapshot = typeof JiraSnapshot.Type;

export class JiraError extends Schema.TaggedError<JiraError>()("JiraError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const JiraSubscribeInput = Schema.Struct({});

/** Every Jira action goes through one command, so the RPC group stays small. */
export const JiraCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sync"), full: Schema.optional(Schema.Boolean) }),
  Schema.Struct({
    type: Schema.Literal("link"),
    threadId: ThreadId,
    key: JiraIssueKey,
    linked: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("suggestion"),
    threadId: ThreadId,
    action: Schema.Literals(["dismiss", "rematch"]),
  }),
  /** Drafts a new ticket from the chat for the user to edit; nothing reaches Jira. */
  Schema.Struct({ type: Schema.Literal("draftTicket"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("createTicket"),
    threadId: ThreadId,
    draft: JiraTicketDraft,
  }),
  Schema.Struct({
    type: Schema.Literal("proposeChanges"),
    threadId: ThreadId,
    key: JiraIssueKey,
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("resolveChanges"),
    id: TrimmedNonEmptyString,
    action: Schema.Literals(["apply", "dismiss"]),
    /** The changes to apply, as the user ticked and edited them. */
    changes: Schema.optional(Schema.Array(JiraChange)),
  }),
  Schema.Struct({
    type: Schema.Literal("ticketUpdates"),
    key: JiraIssueKey,
    updates: JiraTicketUpdates,
  }),
  Schema.Struct({ type: Schema.Literal("clearNotice"), key: JiraIssueKey }),
  /** Moves the ticket in Jira; the click is the user's approval. */
  Schema.Struct({ type: Schema.Literal("setStatus"), key: JiraIssueKey, status: JiraStatusName }),
  /** Moves the ticket to a sprint, or to the backlog with null. */
  Schema.Struct({
    type: Schema.Literal("setSprint"),
    key: JiraIssueKey,
    sprintId: Schema.NullOr(Schema.Int),
  }),
  /** Reads the ticket's description, sprint and the rest into the snapshot's details. */
  Schema.Struct({ type: Schema.Literal("loadDetails"), key: JiraIssueKey }),
  /** Opens the Atlassian CLI's browser login, then syncs once it works. */
  Schema.Struct({ type: Schema.Literal("signIn") }),
]);
export type JiraCommand = typeof JiraCommand.Type;

/** Pre-fill for the new ticket form. The parent is left empty when nothing in the tree fits. */
export const JiraTicketFormDraft = Schema.Struct({
  parentKey: Schema.NullOr(JiraIssueKey),
  summary: TrimmedNonEmptyString,
  description: Schema.String,
});
export type JiraTicketFormDraft = typeof JiraTicketFormDraft.Type;

/** `draftTicket` answers with its form draft (null when the model gave none); the rest with null. */
export const JiraCommandResult = Schema.NullOr(JiraTicketFormDraft);
export type JiraCommandResult = typeof JiraCommandResult.Type;
