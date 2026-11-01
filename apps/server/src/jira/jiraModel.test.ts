import type { JiraIssue } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  adfToText,
  buildMatchPrompt,
  commentText,
  keysMentioned,
  looksSignedOut,
  mergeSync,
  missingAncestors,
  parseAccessibleSite,
  parseBoardIds,
  parseBoardSprints,
  parseCliSearchKeys,
  parseIssueDetails,
  parseIssueSearch,
  parseOpenSprints,
  validateFormDraft,
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
    expect(looksSignedOut('{"error":"invalid_token","message":"Token revoked"}')).toBe(true);
    expect(looksSignedOut("Your session has expired")).toBe(true);
    expect(looksSignedOut("Field 'parent' is invalid")).toBe(false);
  });
});

describe("validateFormDraft", () => {
  const tree = [
    issue({ key: "AIPR-1177", level: 1, type: "Epic" }),
    issue({ key: "AIPR-1057", level: 2, type: "Initiative" }),
  ];

  it("keeps the text and the parent when the parent fits", () => {
    expect(
      validateFormDraft(
        { draft: { parentKey: "aipr-1177", summary: "Add alerting", description: "Goal." } },
        tree,
      ),
    ).toEqual({ parentKey: "AIPR-1177", summary: "Add alerting", description: "Goal." });
  });

  it("keeps the text when no parent fits, leaving the parent to the user", () => {
    for (const parentKey of [null, "AIPR-1057", "NOPE-1"]) {
      expect(validateFormDraft({ draft: { parentKey, summary: "Add alerting" } }, tree)).toEqual({
        parentKey: null,
        summary: "Add alerting",
        description: "",
      });
    }
  });

  it("gives nothing without a summary", () => {
    expect(validateFormDraft({ draft: { parentKey: "AIPR-1177" } }, tree)).toBeNull();
    expect(validateFormDraft(null, tree)).toBeNull();
  });
});

describe("parseIssueDetails", () => {
  it("reads the description, the latest sprint and the people from getJiraIssue", () => {
    const details = parseIssueDetails(
      encodeJson({
        key: "AIPR-1320",
        fields: {
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Redeploy from main." }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "board-agent" }] },
                    ],
                  },
                ],
              },
            ],
          },
          priority: { name: "High" },
          assignee: { displayName: "Matheus" },
          reporter: null,
          labels: ["security"],
          created: "2026-10-20T10:00:00.000-0300",
          duedate: null,
          customfield_10020: [
            { id: 1, name: "GAINS 41", state: "closed", boardId: 7 },
            { id: 2, name: "GAINS 42", state: "active", boardId: 7 },
          ],
        },
      }),
      "2026-10-28T00:00:00.000Z",
    );
    expect(details).toMatchObject({
      key: "AIPR-1320",
      description: "Redeploy from main.\n\n- board-agent",
      priority: "High",
      assignee: "Matheus",
      reporter: null,
      labels: ["security"],
      sprint: { name: "GAINS 42", state: "active" },
      dueDate: null,
    });
  });

  it("unwraps the connector's issues.nodes reply and prefers the active sprint", () => {
    const details = parseIssueDetails(
      encodeJson({
        issues: {
          nodes: [
            {
              key: "AIPR-1310",
              fields: {
                description: null,
                priority: { name: "Medium" },
                customfield_10020: [
                  { id: 5851, name: "Sprint 22 - GAINS", state: "active", boardId: 430 },
                  { id: 5841, name: "Sprint 21 - GAINS", state: "closed", boardId: 430 },
                ],
              },
            },
          ],
        },
      }),
      "2026-10-28T00:00:00.000Z",
    );
    expect(details).toMatchObject({
      key: "AIPR-1310",
      description: "",
      priority: "Medium",
      sprint: { name: "Sprint 22 - GAINS", state: "active" },
    });
  });

  it("keeps plain text descriptions and rejects replies that aren't an issue", () => {
    expect(adfToText("already text")).toBe("already text");
    expect(parseIssueDetails("Issue not found", "2026-10-28T00:00:00.000Z")).toBeUndefined();
  });
});

describe("parseOpenSprints", () => {
  it("collects each open sprint once, active first, and drops closed ones", () => {
    const sprint = (id: number, name: string, state: string) => ({ id, name, state, boardId: 430 });
    const sprints = parseOpenSprints(
      encodeJson({
        issues: {
          nodes: [
            {
              fields: {
                customfield_10020: [
                  sprint(5852, "Sprint 23 - GAINS", "future"),
                  sprint(5841, "Sprint 21 - GAINS", "closed"),
                ],
              },
            },
            { fields: { customfield_10020: [sprint(5851, "Sprint 22 - GAINS", "active")] } },
            { fields: { customfield_10020: [sprint(5852, "Sprint 23 - GAINS", "future")] } },
            { fields: { customfield_10020: null } },
          ],
        },
      }),
    );
    expect(sprints?.map((entry) => entry.name)).toEqual(["Sprint 22 - GAINS", "Sprint 23 - GAINS"]);
    expect(parseOpenSprints("not json")).toBeUndefined();
  });
});

describe("Atlassian CLI replies", () => {
  it("reads search keys, scrum boards and open sprints", () => {
    expect(parseCliSearchKeys(encodeJson([{ key: "AIPR-1" }, null, { key: "AIPR-2" }]))).toEqual([
      "AIPR-1",
      "AIPR-2",
    ]);
    expect(parseCliSearchKeys("✗ Error: unauthorized")).toBeUndefined();
    expect(
      parseBoardIds(
        encodeJson({
          values: [
            { id: 430, type: "scrum" },
            { id: 431, type: "kanban" },
          ],
        }),
      ),
    ).toEqual([430]);
    const sprints = parseBoardSprints([
      {
        boardId: 430,
        reply: encodeJson({
          sprints: [
            { id: 5852, name: "Sprint 23 - GAINS", state: "future" },
            { id: 5851, name: "Sprint 22 - GAINS", state: "active" },
            { id: 5841, name: "Sprint 21", state: "closed" },
          ],
        }),
      },
      { boardId: 431, reply: "not json" },
    ]);
    expect(sprints).toEqual([
      { id: 5851, name: "Sprint 22 - GAINS", state: "active", boardId: 430 },
      { id: 5852, name: "Sprint 23 - GAINS", state: "future", boardId: 430 },
    ]);
  });

  it("counts acli's sign-out wording as signed out", () => {
    expect(looksSignedOut("✗ Not authenticated")).toBe(true);
  });

  it("posts a comment's pull request links as a footer after the prose", () => {
    expect(commentText({ body: "Board answers now use the meeting date." })).toBe(
      "Board answers now use the meeting date.",
    );
    expect(
      commentText({
        body: "Board answers now use the meeting date.",
        links: ["https://github.com/acme/app/pull/1", "https://github.com/acme/app/pull/2"],
      }),
    ).toBe(
      "Board answers now use the meeting date.\n\nPull requests:\n- https://github.com/acme/app/pull/1\n- https://github.com/acme/app/pull/2",
    );
  });
});
