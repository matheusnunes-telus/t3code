import { NodeServices } from "@effect/platform-node";
import { type JiraSnapshot, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  ConnectorAgentRun,
  ConnectorAgentResult,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as JiraService from "./JiraService.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const TOOL = (name: string) => `mcp__claude_ai_Atlassian__${name}`;
const threadId = ThreadId.make("thread-jira-1");

const node = (key: string, summary: string, type: string, level: number, parent?: string) => ({
  key,
  webUrl: `https://example.atlassian.net/browse/${key}`,
  fields: {
    summary,
    issuetype: { name: type, hierarchyLevel: level },
    status: { name: "To Do", statusCategory: { key: "new" } },
    updated: "2026-10-22T10:00:00.000-0400",
    ...(parent === undefined ? {} : { parent: { key: parent, fields: { summary: parent } } }),
  },
});

/** Plays the Atlassian connector: answers each tool the prompt names with a canned reply. */
const makeFakeAgent = (calls: Ref.Ref<ReadonlyArray<ConnectorAgentRun>>) => ({
  run: (request: ConnectorAgentRun) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (all) => [...all, request]);
      const reply = (tool: string, text: unknown): ConnectorAgentResult => ({
        toolResults: [
          {
            tool: TOOL(tool),
            input: {},
            isError: false,
            text: typeof text === "string" ? text : encodeJson(text),
          },
        ],
        output: "done",
        availableTools: [TOOL(tool)],
        mcpServers: [{ name: "claude.ai Atlassian", status: "connected" }],
      });
      const { prompt, operation } = request;
      if (operation === "jira.match") {
        return {
          toolResults: [],
          availableTools: [],
          mcpServers: [],
          output: {
            matches: [{ key: "AIPR-1309", confidence: "high", reason: "same screen" }],
            draft: null,
          },
        } satisfies ConnectorAgentResult;
      }
      if (prompt.includes("getAccessibleAtlassianResources")) {
        return reply("getAccessibleAtlassianResources", [
          { id: "cloud-1", url: "https://example.atlassian.net" },
        ]);
      }
      if (prompt.includes("atlassianUserInfo")) {
        return reply("atlassianUserInfo", { account_id: "me-1" });
      }
      if (prompt.includes("createJiraIssue")) {
        return reply("createJiraIssue", { id: "1", key: "AIPR-1400" });
      }
      if (prompt.includes("key in (")) {
        return reply("searchJiraIssuesUsingJql", {
          issues: [node("AIPR-1177", "Board agent", "Epic", 1, "AIPR-1057")].concat(
            prompt.includes("AIPR-1057") ? [node("AIPR-1057", "Board Agent", "Initiative", 2)] : [],
          ),
        });
      }
      if (prompt.includes("searchJiraIssuesUsingJql")) {
        return reply("searchJiraIssuesUsingJql", {
          issues: { nodes: [node("AIPR-1309", "UI adjustments", "Task", 0, "AIPR-1177")] },
        });
      }
      if (operation === "jira.applyChanges") {
        return {
          ...reply("addCommentToJiraIssue", { id: "c1" }),
          availableTools: [TOOL("addCommentToJiraIssue")],
        };
      }
      return yield* Effect.die(`Unexpected agent call: ${operation}`);
    }),
});

const makeLayer = (calls: Ref.Ref<ReadonlyArray<ConnectorAgentRun>>) =>
  JiraService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.ServerSettingsService.layerTest({
          jiraModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-5-5",
          },
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed({ connectorAgent: makeFakeAgent(calls) } as unknown as ProviderInstance),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-jira-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** Background work runs on forked fibers; wait for the snapshot that shows it finished. */
const waitFor = (
  service: JiraService.JiraService["Service"],
  predicate: (snapshot: JiraSnapshot) => boolean,
) =>
  service.subscribe().pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap((head) =>
      head._tag === "Some" ? Effect.succeed(head.value) : Effect.die("Jira stream ended."),
    ),
  );

describe("JiraService", () => {
  it.effect("syncs the tree up to the initiative, then suggests and links a ticket", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ConnectorAgentRun>>([]);
      yield* Effect.gen(function* () {
        const jira = yield* JiraService.JiraService;
        yield* jira.command({ type: "sync" });
        const synced = yield* waitFor(jira, (snapshot) => snapshot.sync.status === "ok");
        expect(synced.issues.map((issue) => [issue.key, issue.level, issue.parentKey])).toEqual(
          expect.arrayContaining([
            ["AIPR-1309", 0, "AIPR-1177"],
            ["AIPR-1177", 1, "AIPR-1057"],
            ["AIPR-1057", 2, null],
          ]),
        );
        expect(synced.siteUrl).toBe("https://example.atlassian.net");
        const searches = (yield* Ref.get(calls)).filter((call) =>
          call.prompt.includes("searchJiraIssuesUsingJql"),
        );
        expect(
          searches.every((call) => call.toolPrefixes.includes("mcp__claude_ai_Atlassian")),
        ).toBe(true);

        yield* jira.onFirstMessage({ threadId, message: "tweak the board agent buttons" });
        const suggested = yield* waitFor(jira, (snapshot) =>
          snapshot.suggestions.some((entry) => entry.state === "ready"),
        );
        expect(suggested.suggestions[0]?.matches).toEqual([
          { key: "AIPR-1309", confidence: "high", reason: "same screen" },
        ]);
        // The matcher gets no tools; it only reads the stored tree.
        expect(
          (yield* Ref.get(calls)).find((call) => call.operation === "jira.match")?.toolPrefixes,
        ).toEqual([]);

        yield* jira.command({ type: "link", threadId, key: "AIPR-1309", linked: true });
        const linked = yield* waitFor(jira, (snapshot) => snapshot.links.length === 1);
        expect(linked.links[0]).toMatchObject({ key: "AIPR-1309", source: "suggestion" });
        expect(linked.suggestions[0]?.state).toBe("dismissed");
      }).pipe(Effect.provide(makeLayer(calls)));
    }),
  );

  it.effect("creates a drafted ticket assigned to the user and links it", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ConnectorAgentRun>>([]);
      yield* Effect.gen(function* () {
        const jira = yield* JiraService.JiraService;
        yield* jira.command({
          type: "createTicket",
          threadId,
          draft: {
            parentKey: "AIPR-1309",
            type: "Sub-task",
            summary: "Dark mode toggle",
            description: "Add a theme toggle.",
          },
        });
        const created = yield* waitFor(jira, (snapshot) =>
          snapshot.links.some((entry) => entry.key === "AIPR-1400"),
        );
        expect(created.issues.find((issue) => issue.key === "AIPR-1400")).toMatchObject({
          level: -1,
          parentKey: "AIPR-1309",
          assignedToMe: true,
        });
        const create = (yield* Ref.get(calls)).find((call) =>
          call.prompt.includes("createJiraIssue"),
        );
        expect(create?.prompt).toContain('"assignee_account_id":"me-1"');
        expect(create?.prompt).toContain('"projectKey":"AIPR"');
      }).pipe(Effect.provide(makeLayer(calls)));
    }),
  );
});
