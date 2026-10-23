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
]);
export type JiraCommand = typeof JiraCommand.Type;
