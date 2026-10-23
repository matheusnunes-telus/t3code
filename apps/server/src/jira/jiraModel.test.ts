import type { JiraIssue } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  buildMatchPrompt,
  keysMentioned,
  looksSignedOut,
  mergeSync,
  missingAncestors,
  parseAccessibleSite,
  parseIssueSearch,
  validateMatch,
} from "./jiraModel.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const status = (name: string, key: "new" | "indeterminate" | "done") => ({
  self: "https://example.atlassian.net/rest/api/3/status/1",
  name,
  statusCategory: { key, colorName: "blue" },
});
const issueType = (name: string, hierarchyLevel: number) => ({
  self: "https://example.atlassian.net/rest/api/3/issuetype/1",
  name,
  hierarchyLevel,
  subtask: hierarchyLevel === -1,
});

/** Shaped like the connector's real reply: `issues.nodes`, with bulky nested objects. */
const searchReply = encodeJson({
  issues: {
    nodes: [
      {
        key: "AIPR-1310",
        webUrl: "https://example.atlassian.net/browse/AIPR-1310",
        fields: {
          summary: "Implement health check monitoring",
          issuetype: issueType("Sub-task", -1),
          status: status("In Progress", "indeterminate"),
          updated: "2026-10-22T10:00:00.000-0400",
          parent: {
            key: "AIPR-1283",
            fields: {
              summary: "Implement alerting framework",
              issuetype: issueType("Task", 0),
              status: status("In Progress", "indeterminate"),
            },
          },
        },
      },
      {
        key: "AIPR-1309",
        webUrl: "https://example.atlassian.net/browse/AIPR-1309",
        fields: {
          summary: "UI adjusments",
          issuetype: issueType("Task", 0),
          status: status("To Do", "new"),
          updated: "2026-10-21T10:00:00.000-0400",
          parent: {
            key: "AIPR-1177",
            fields: {
              summary: "[Board agent]: Maintain & Improve",
              issuetype: issueType("Epic", 1),
              status: status("To Do", "new"),
            },
          },
        },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
});

const issue = (overrides: Partial<JiraIssue> & Pick<JiraIssue, "key">): JiraIssue => ({
  summary: overrides.key,
  type: "Task",
  level: 0,
  status: "To Do",
  statusCategory: "new",
  parentKey: null,
  assignedToMe: true,
  updatedAt: "2026-10-22T10:00:00.000Z",
  url: null,
  ...overrides,
});

describe("parseIssueSearch", () => {
  it("keeps only the fields the tree needs, plus parents as stubs", () => {
    const parsed = parseIssueSearch(searchReply, true, null);
    expect(parsed?.siteUrl).toBe("https://example.atlassian.net");
    expect(parsed?.issues).toEqual([
      {
        key: "AIPR-1310",
        summary: "Implement health check monitoring",
        type: "Sub-task",
        level: -1,
        status: "In Progress",
        statusCategory: "indeterminate",
        parentKey: "AIPR-1283",
        assignedToMe: true,
        updatedAt: "2026-10-22T10:00:00.000-0400",
        url: "https://example.atlassian.net/browse/AIPR-1310",
      },
      expect.objectContaining({ key: "AIPR-1309", level: 0, parentKey: "AIPR-1177" }),
    ]);
    expect(parsed?.parents.map((parent) => [parent.key, parent.level, parent.updatedAt])).toEqual([
      ["AIPR-1283", 0, null],
      ["AIPR-1177", 1, null],
    ]);
  });

  it("accepts a plain issues array, and rejects text that is not a search reply", () => {
    const flat = encodeJson({ issues: [{ key: "AIPR-1", fields: { summary: "One" } }] });
    expect(parseIssueSearch(flat, false, "https://site")?.issues[0]).toMatchObject({
      key: "AIPR-1",
      level: 0,
      assignedToMe: false,
      url: "https://site/browse/AIPR-1",
    });
    expect(parseIssueSearch("Error: unauthorized", true, null)).toBeUndefined();
  });
});

describe("mergeSync", () => {
  it("walks to missing ancestors and keeps them while their children are open", () => {
    const parsed = parseIssueSearch(searchReply, true, null)!;
    const merged = mergeSync({
      previous: [],
      fetched: parsed.issues,
      parents: parsed.parents,
      full: true,
      linkedKeys: new Set(),
      ticketUpdates: {},
      at: "2026-10-23T00:00:00.000Z",
    });
    expect(merged.issues.map((entry) => entry.key).toSorted()).toEqual([
      "AIPR-1177",
      "AIPR-1283",
      "AIPR-1309",
      "AIPR-1310",
    ]);
    // The task stub has no parent yet, the epic stub may sit under an initiative.
    expect(missingAncestors(merged.issues).toSorted()).toEqual(["AIPR-1177", "AIPR-1283"]);
  });

  it("drops closed tickets unless linked, and notices status changes on notify tickets", () => {
    const previous = [
      issue({ key: "A-1", status: "In Progress" }),
      issue({ key: "A-2", status: "In Progress" }),
      issue({ key: "A-3", status: "To Do" }),
    ];
    const merged = mergeSync({
      previous,
      fetched: [
        issue({ key: "A-1", status: "Done", statusCategory: "done" }),
        issue({ key: "A-2", status: "Done", statusCategory: "done" }),
      ],
      parents: [],
      full: false,
      linkedKeys: new Set(["A-2"]),
      ticketUpdates: { "A-2": "notify" },
      at: "2026-10-23T00:00:00.000Z",
    });
    expect(merged.issues.map((entry) => entry.key)).toEqual(["A-2", "A-3"]);
    expect(merged.notices).toEqual([
      { key: "A-2", at: "2026-10-23T00:00:00.000Z", summary: "A-2 moved from In Progress to Done" },
    ]);
  });

  it("replaces own tickets on a full sync", () => {
    const merged = mergeSync({
      previous: [issue({ key: "A-1" }), issue({ key: "E-1", level: 1, assignedToMe: false })],
      fetched: [issue({ key: "A-2", parentKey: "E-1" })],
      parents: [],
      full: true,
      linkedKeys: new Set(),
      ticketUpdates: {},
      at: "2026-10-23T00:00:00.000Z",
    });
    expect(merged.issues.map((entry) => entry.key).toSorted()).toEqual(["A-2", "E-1"]);
  });
});

describe("matching", () => {
  const tree = [
    issue({ key: "AIPR-1177", level: 1, type: "Epic", summary: "Board agent" }),
    issue({ key: "AIPR-1309", parentKey: "AIPR-1177", summary: "UI adjustments" }),
    issue({ key: "AIPR-1057", level: 2, type: "Initiative", summary: "Board Agent" }),
  ];

  it("finds keys typed in the message, ignoring unknown ones", () => {
    expect(keysMentioned("pick up aipr-1309 and XYZ-1, then AIPR-1309 again", tree)).toEqual([
      "AIPR-1309",
    ]);
  });

  it("puts the whole open tree and the message in the prompt", () => {
    const prompt = buildMatchPrompt({ message: "fix the board agent buttons", issues: tree });
    expect(prompt).toContain("AIPR-1309 | Task | To Do | UI adjustments | parent AIPR-1177");
    expect(prompt).toContain("fix the board agent buttons");
  });

  it("keeps only known matches, and fixes the draft type from its parent", () => {
    expect(
      validateMatch(
        {
          matches: [
            { key: "aipr-1309", confidence: "high", reason: "same screen" },
            { key: "NOPE-1", confidence: "high", reason: "made up" },
          ],
          draft: null,
        },
        tree,
      ),
    ).toEqual({
      matches: [{ key: "AIPR-1309", confidence: "high", reason: "same screen" }],
      draft: null,
    });
    expect(
      validateMatch(
        {
          matches: [],
          draft: {
            parentKey: "AIPR-1309",
            type: "Task",
            summary: "Dark mode toggle",
            description: "Add it.",
          },
        },
        tree,
      ).draft,
    ).toEqual({
      parentKey: "AIPR-1309",
      type: "Sub-task",
      summary: "Dark mode toggle",
      description: "Add it.",
    });
    // Never under an initiative.
    expect(
      validateMatch(
        {
          matches: [],
          draft: { parentKey: "AIPR-1057", type: "Task", summary: "x", description: "" },
        },
        tree,
      ).draft,
    ).toBeNull();
  });
});

describe("connector replies", () => {
  it("reads the first accessible site", () => {
    expect(
      parseAccessibleSite(
        encodeJson([{ id: "cloud-1", url: "https://example.atlassian.net", name: "example" }]),
      ),
    ).toEqual({ id: "cloud-1", url: "https://example.atlassian.net" });
  });

  it("tells a lost login from other errors", () => {
    expect(looksSignedOut("Request failed with status 401 Unauthorized")).toBe(true);
    expect(looksSignedOut("The Atlassian connector is needs-auth.")).toBe(true);
    expect(looksSignedOut("Field 'parent' is invalid")).toBe(false);
  });
});
