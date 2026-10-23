import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  JiraIssue,
  JiraStatusCategory,
  JiraTicketDraft,
  JiraTicketMatch,
  JiraTicketNotice,
  JiraTicketUpdates,
} from "@t3tools/contracts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const parseJson = (value: string): unknown => Option.getOrUndefined(decodeJson(value));

/** A Jira key such as AIPR-1309, as people type it in a message or a branch name. */
export const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;

/** The fields a sync asks for; everything else in Jira's reply is dropped. */
export const JIRA_SEARCH_FIELDS = ["summary", "issuetype", "status", "parent", "updated"] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

function statusCategoryOf(status: Record<string, unknown> | undefined): JiraStatusCategory {
  const key = text(record(status?.statusCategory)?.key);
  return key === "done" ? "done" : key === "indeterminate" ? "indeterminate" : "new";
}

/** Jira gives sub-tasks -1 and initiatives 2; older types without a level count as tasks. */
function levelOf(issueType: Record<string, unknown> | undefined): number {
  const level = issueType?.hierarchyLevel;
  if (typeof level === "number" && Number.isInteger(level)) return level;
  return issueType?.subtask === true ? -1 : 0;
}

function issueFrom(
  node: Record<string, unknown>,
  assignedToMe: boolean,
  siteUrl: string | null,
): JiraIssue | undefined {
  const key = text(node.key);
  const fields = record(node.fields);
  if (key === undefined || fields === undefined) return undefined;
  const issueType = record(fields.issuetype);
  const status = record(fields.status);
  const parentKey = text(record(fields.parent)?.key) ?? null;
  return {
    key,
    summary: text(fields.summary) ?? key,
    type: text(issueType?.name) ?? "Task",
    level: levelOf(issueType),
    status: text(status?.name) ?? "Unknown",
    statusCategory: statusCategoryOf(status),
    parentKey,
    assignedToMe,
    updatedAt: text(fields.updated) ?? null,
    url: text(node.webUrl) ?? (siteUrl === null ? null : `${siteUrl}/browse/${key}`),
  };
}

export interface ParsedIssueSearch {
  readonly issues: ReadonlyArray<JiraIssue>;
  /** Parents seen only inside a child's `parent` field; their own parent is still unknown. */
  readonly parents: ReadonlyArray<JiraIssue>;
  readonly siteUrl: string | null;
}

function siteFromUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  const match = /^(https:\/\/[^/]+)\//.exec(url);
  return match?.[1] ?? null;
}

/**
 * Reads the Atlassian connector's search reply. It has come back both as `issues: [...]` and as
 * `issues: { nodes: [...] }`, so both are accepted. Returns undefined when it is not a search
 * reply at all, such as an error message.
 */
export function parseIssueSearch(
  reply: string,
  assignedToMe: boolean,
  knownSiteUrl: string | null,
): ParsedIssueSearch | undefined {
  const root = record(parseJson(reply));
  const issuesField = root?.issues;
  const nodes = Array.isArray(issuesField)
    ? issuesField
    : Array.isArray(record(issuesField)?.nodes)
      ? (record(issuesField)?.nodes as ReadonlyArray<unknown>)
      : undefined;
  if (nodes === undefined) return undefined;
  const entries = nodes.flatMap((node) => {
    const entry = record(node);
    return entry === undefined ? [] : [entry];
  });
  const siteUrl =
    knownSiteUrl ??
    entries.map((entry) => siteFromUrl(text(entry.webUrl) ?? text(entry.self))).find(Boolean) ??
    null;
  const issues = entries.flatMap((entry) => {
    const issue = issueFrom(entry, assignedToMe, siteUrl);
    return issue === undefined ? [] : [issue];
  });
  const seen = new Set(issues.map((issue) => issue.key));
  const parents = new Map<string, JiraIssue>();
  for (const entry of entries) {
    const parent = record(record(entry.fields)?.parent);
    if (parent === undefined) continue;
    const issue = issueFrom(parent, false, siteUrl);
    if (issue !== undefined && !seen.has(issue.key)) parents.set(issue.key, issue);
  }
  return { issues, parents: [...parents.values()], siteUrl };
}

/** The first Atlassian site in the connector's `getAccessibleAtlassianResources` reply. */
export function parseAccessibleSite(reply: string): { id: string; url: string | null } | undefined {
  const parsed = parseJson(reply);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record(parsed)?.resources)
      ? (record(parsed)?.resources as ReadonlyArray<unknown>)
      : [];
  for (const item of list) {
    const entry = record(item);
    const id = text(entry?.id);
    if (id !== undefined) return { id, url: text(entry?.url) ?? null };
  }
  return undefined;
}

const SIGNED_OUT =
  /\b(401|403|unauthori[sz]ed|forbidden|re-?authenticat|authenticat\w* (failed|required|expired)|token (has )?expired|not (logged|signed) in|log ?in again|sign ?in again|needs-auth)\b/i;

export function looksSignedOut(message: string): boolean {
  return SIGNED_OUT.test(message);
}

export interface SyncMerge {
  readonly issues: ReadonlyArray<JiraIssue>;
  readonly notices: ReadonlyArray<JiraTicketNotice>;
}

/**
 * Folds a sync into the stored tree. A full sync replaces the user's own tickets; an incremental
 * one only updates what changed. Linked tickets and the path above open ones are kept, so chips
 * and breadcrumbs still render when a ticket closes.
 */
export function mergeSync(input: {
  readonly previous: ReadonlyArray<JiraIssue>;
  readonly fetched: ReadonlyArray<JiraIssue>;
  readonly parents: ReadonlyArray<JiraIssue>;
  readonly full: boolean;
  readonly linkedKeys: ReadonlySet<string>;
  readonly ticketUpdates: Readonly<Record<string, JiraTicketUpdates>>;
  readonly at: string;
}): SyncMerge {
  const byKey = new Map<string, JiraIssue>();
  for (const issue of input.previous) {
    if (input.full && issue.assignedToMe) continue;
    byKey.set(issue.key, issue);
  }
  for (const parent of input.parents) {
    const known = byKey.get(parent.key);
    // A stub from a child's `parent` field never overwrites what a search returned.
    byKey.set(
      parent.key,
      known === undefined ? parent : { ...known, summary: parent.summary, status: parent.status },
    );
  }
  for (const issue of input.fetched) {
    const known = byKey.get(issue.key);
    byKey.set(issue.key, {
      ...issue,
      parentKey: issue.parentKey ?? known?.parentKey ?? null,
      assignedToMe: issue.assignedToMe || known?.assignedToMe === true,
    });
  }

  const notices: Array<JiraTicketNotice> = [];
  const previousByKey = new Map(input.previous.map((issue) => [issue.key, issue]));
  for (const issue of input.fetched) {
    const before = previousByKey.get(issue.key);
    if (before === undefined || before.status === issue.status) continue;
    if (input.ticketUpdates[issue.key] !== "notify") continue;
    notices.push({
      key: issue.key,
      at: input.at,
      summary: `${issue.key} moved from ${before.status} to ${issue.status}`,
    });
  }

  // Keep open own tickets, linked ones, and every ancestor of those.
  const keep = new Set<string>();
  const keepWithAncestors = (key: string) => {
    let current: string | null = key;
    for (let depth = 0; current !== null && depth < 6 && !keep.has(current); depth += 1) {
      keep.add(current);
      current = byKey.get(current)?.parentKey ?? null;
    }
  };
  for (const issue of byKey.values()) {
    if (issue.assignedToMe && issue.statusCategory !== "done") keepWithAncestors(issue.key);
  }
  for (const key of input.linkedKeys) keepWithAncestors(key);
  return { issues: [...byKey.values()].filter((issue) => keep.has(issue.key)), notices };
}

/** Parents the tree points at but does not hold, so the next query can fetch them. */
export function missingAncestors(issues: ReadonlyArray<JiraIssue>): ReadonlyArray<string> {
  const known = new Map(issues.map((issue) => [issue.key, issue]));
  const missing = new Set<string>();
  for (const issue of issues) {
    if (issue.parentKey !== null && !known.has(issue.parentKey)) missing.add(issue.parentKey);
    // A stub from a child's `parent` field has no update time and may have a parent of its own.
    if (issue.updatedAt === null && issue.parentKey === null && issue.level < 2) {
      missing.add(issue.key);
    }
  }
  return [...missing];
}

export const LEVEL_NAMES: Readonly<Record<string, string>> = {
  "2": "Initiative",
  "1": "Epic",
  "0": "Task",
  "-1": "Sub-task",
};
export const levelName = (level: number) =>
  LEVEL_NAMES[String(level)] ?? (level > 2 ? "Initiative" : "Task");

/** One line per ticket, short enough that a cheap model reads the whole tree. */
export function formatTree(issues: ReadonlyArray<JiraIssue>): string {
  return [...issues]
    .toSorted((a, b) => b.level - a.level || a.key.localeCompare(b.key))
    .map(
      (issue) =>
        `${issue.key} | ${levelName(issue.level)} | ${issue.status} | ${issue.summary}${
          issue.parentKey === null ? "" : ` | parent ${issue.parentKey}`
        }${issue.assignedToMe ? "" : " | not mine"}`,
    )
    .join("\n");
}

export function buildMatchPrompt(input: {
  readonly message: string;
  readonly issues: ReadonlyArray<JiraIssue>;
}): string {
  return [
    "You link a developer's chat to their Jira tickets.",
    "Below is their open Jira tree (key | level | status | summary | parent) and the first message of a new chat.",
    "",
    "Pick up to 3 tickets the chat is most likely about, best first. Prefer tasks and sub-tasks over epics and initiatives.",
    "Use confidence high only when the message clearly matches the ticket; medium when it plausibly does; low otherwise. Say why in a few words.",
    "If no task or sub-task fits well, return no matches and draft a new ticket instead:",
    '- under an epic, type "Task"; under a task, type "Sub-task". Never under an initiative.',
    "- pick the parent that fits best, write a short summary (under 80 characters) and a 1-3 sentence description.",
    "If the message is not development work (a question, chit-chat), return no matches and no draft.",
    "",
    "Tree:",
    formatTree(input.issues.filter((issue) => issue.statusCategory !== "done")),
    "",
    "Message:",
    input.message.slice(0, 4_000),
  ].join("\n");
}

export const MATCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches", "draft"],
  properties: {
    matches: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "confidence", "reason"],
        properties: {
          key: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" },
        },
      },
    },
    draft: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["parentKey", "type", "summary", "description"],
          properties: {
            parentKey: { type: "string" },
            type: { type: "string", enum: ["Task", "Sub-task"] },
            summary: { type: "string" },
            description: { type: "string" },
          },
        },
      ],
    },
  },
} as const;

/** Keeps only matches and a draft that fit the stored tree; a model can name keys that don't. */
export function validateMatch(
  output: unknown,
  issues: ReadonlyArray<JiraIssue>,
): { matches: ReadonlyArray<JiraTicketMatch>; draft: JiraTicketDraft | null } {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const root = record(output);
  const matches: Array<JiraTicketMatch> = [];
  for (const item of Array.isArray(root?.matches) ? root.matches : []) {
    const entry = record(item);
    const key = text(entry?.key)?.toUpperCase();
    if (key === undefined || !byKey.has(key) || matches.some((match) => match.key === key)) {
      continue;
    }
    const confidence = entry?.confidence;
    matches.push({
      key,
      confidence:
        confidence === "high" || confidence === "medium" || confidence === "low"
          ? confidence
          : "low",
      reason: text(entry?.reason) ?? "",
    });
  }
  const draftEntry = record(root?.draft);
  let draft: JiraTicketDraft | null = null;
  const parent = byKey.get(text(draftEntry?.parentKey)?.toUpperCase() ?? "");
  const summary = text(draftEntry?.summary);
  if (
    matches.length === 0 &&
    parent !== undefined &&
    summary !== undefined &&
    (parent.level === 0 || parent.level === 1)
  ) {
    draft = {
      parentKey: parent.key,
      // The parent decides the type, whatever the model said.
      type: parent.level === 1 ? "Task" : "Sub-task",
      summary: summary.slice(0, 200),
      description: text(draftEntry?.description) ?? "",
    };
  }
  return { matches: matches.slice(0, 3), draft };
}

/** A key typed in the message that the tree knows is a sure match, with no model needed. */
export function keysMentioned(message: string, issues: ReadonlyArray<JiraIssue>): string[] {
  const known = new Set(issues.map((issue) => issue.key));
  const found: string[] = [];
  for (const match of message.toUpperCase().matchAll(JIRA_KEY_PATTERN)) {
    const key = match[1];
    if (key !== undefined && known.has(key) && !found.includes(key)) found.push(key);
  }
  return found;
}

/** Statuses the user's Jira workflow can move a ticket to. */
export const JIRA_STATUSES = ["To Do", "In Progress", "Blocked", "Done"] as const;

export const CHANGES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["currentDescription", "status", "comment", "description"],
  properties: {
    currentDescription: { type: "string" },
    status: { anyOf: [{ type: "null" }, { type: "string", enum: [...JIRA_STATUSES] }] },
    comment: { anyOf: [{ type: "null" }, { type: "string" }] },
    description: { anyOf: [{ type: "null" }, { type: "string" }] },
  },
} as const;
