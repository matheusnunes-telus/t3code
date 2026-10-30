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
import * as ProcessRunner from "../processRunner.ts";
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
      if (operation === "jira.draftTicket") {
        return {
          toolResults: [],
          availableTools: [],
          mcpServers: [],
          // The model names the wrong type; the epic parent makes it a Task.
          output: {
            matches: [],
            draft: {
              parentKey: "AIPR-1177",
              type: "Sub-task",
              summary: "Board export button",
              description: "Add an export button to the board.",
            },
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
      // The login lapsed: Claude Code reports the connector but loads none of its tools.
      if (prompt.includes("getJiraIssue")) {
        return {
          toolResults: [],
          output: "done",
          availableTools: [],
          mcpServers: [{ name: "claude.ai Atlassian", status: "needs-auth" }],
        } satisfies ConnectorAgentResult;
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

/** A fake `acli`: answers each argument list, or fails to start as if it isn't installed. */
type FakeCli = (args: ReadonlyArray<string>) => { readonly stdout: string; readonly code: number };

const missingCli = Layer.mock(ProcessRunner.ProcessRunner)({
  run: (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cause: new Error("ENOENT"),
      }),
    ),
});

const fakeCli = (answer: FakeCli, ran: Array<ReadonlyArray<string>>) =>
  Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) =>
      Effect.sync(() => {
        ran.push(input.args);
        const { stdout, code } = answer(input.args);
        return {
          stdout,
          stderr: code === 0 ? "" : stdout,
          code: code as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

const makeLayer = (
  calls: Ref.Ref<ReadonlyArray<ConnectorAgentRun>>,
  cli: Layer.Layer<ProcessRunner.ProcessRunner> = missingCli,
) =>
  JiraService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        cli,
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
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_threadId, _records, options) =>
            Effect.succeed({
              thread: { title: "Board export", pullRequests: [] },
              messages:
                options?.messageRoles?.[0] === "user"
                  ? [{ text: "add an export button to the board agent" }]
                  : [{ text: "Added the button." }],
            }) as never,
        }),
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

const SIGNED_IN = "✓ Authenticated\n  Site: example.atlassian.net\n";

/** Answers `acli` like Jira would for the same tree the fake connector holds. */
const cliJira =
  (signedIn: { value: boolean }): FakeCli =>
  (args) => {
    const [, group, action] = args;
    if (group === "auth") {
      return signedIn.value
        ? { stdout: SIGNED_IN, code: 0 }
        : { stdout: "✗ Not authenticated", code: 1 };
    }
    if (!signedIn.value) return { stdout: "✗ Error: unauthorized", code: 1 };
    const tree = {
      "AIPR-1309": node("AIPR-1309", "Board agent buttons", "Task", 0, "AIPR-1177"),
      "AIPR-1177": node("AIPR-1177", "Board agent", "Epic", 1, "AIPR-1057"),
      "AIPR-1057": node("AIPR-1057", "GAINS", "Initiative", 2),
    };
    if (group === "workitem" && action === "search") {
      const jql = args[args.indexOf("--jql") + 1] ?? "";
      const keys = jql.startsWith("key in")
        ? Object.keys(tree).filter((key) => jql.includes(key))
        : ["AIPR-1309"];
      return { stdout: encodeJson(keys.map((key) => ({ key, fields: {} }))), code: 0 };
    }
    if (group === "workitem" && action === "view") {
      const key = args[3] as keyof typeof tree;
      return { stdout: encodeJson(tree[key]), code: 0 };
    }
    if (group === "board" && action === "search") {
      return { stdout: encodeJson({ values: [{ id: 430, type: "scrum" }] }), code: 0 };
    }
    if (group === "board" && action === "list-sprints") {
      return {
        stdout: encodeJson({ sprints: [{ id: 5851, name: "Sprint 22", state: "active" }] }),
        code: 0,
      };
    }
    if (group === "workitem" && action === "create") {
      return { stdout: encodeJson({ key: "AIPR-1400" }), code: 0 };
    }
    return { stdout: `unexpected ${args.join(" ")}`, code: 1 };
  };

describe("JiraService", () => {
  it.effect("syncs through acli when it is installed, without the connector", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ConnectorAgentRun>>([]);
      const ran: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const jira = yield* JiraService.JiraService;
        yield* jira.command({ type: "sync" });
        const synced = yield* waitFor(jira, (snapshot) => snapshot.sync.status === "ok");
        expect(synced.signIn).toBe("cli");
        expect(synced.siteUrl).toBe("https://example.atlassian.net");
        expect(synced.issues.map((issue) => [issue.key, issue.parentKey])).toEqual(
          expect.arrayContaining([
            ["AIPR-1309", "AIPR-1177"],
            ["AIPR-1177", "AIPR-1057"],
            ["AIPR-1057", null],
          ]),
        );
        expect(synced.sprints).toEqual([
          { id: 5851, name: "Sprint 22", state: "active", boardId: 430 },
        ]);
        expect(yield* Ref.get(calls)).toEqual([]);

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
        yield* waitFor(jira, (snapshot) =>
          snapshot.links.some((entry) => entry.key === "AIPR-1400"),
        );
        const create = ran.find((args) => args[2] === "create");
        expect(create).toEqual(
          expect.arrayContaining(["--project", "AIPR", "--parent", "AIPR-1309", "@me"]),
        );
      }).pipe(Effect.provide(makeLayer(calls, fakeCli(cliJira({ value: true }), ran))));
    }),
  );

  it.effect("marks Jira signed out when acli loses its login", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ConnectorAgentRun>>([]);
      const signedIn = { value: true };
      yield* Effect.gen(function* () {
        const jira = yield* JiraService.JiraService;
        yield* jira.command({ type: "sync" });
        yield* waitFor(jira, (snapshot) => snapshot.sync.status === "ok");
        signedIn.value = false;
        const failed = yield* jira
          .command({ type: "loadDetails", key: "AIPR-1309" })
          .pipe(Effect.flip);
        expect(failed.message).toContain("acli jira auth login");
        const signedOut = yield* waitFor(jira, (snapshot) => snapshot.sync.status === "signed-out");
        expect(signedOut.signIn).toBe("cli");
      }).pipe(Effect.provide(makeLayer(calls, fakeCli(cliJira(signedIn), []))));
    }),
  );

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

        // By default the first message only offers to look; nothing runs until asked.
        yield* jira.onFirstMessage({ threadId, message: "tweak the board agent buttons" });
        const offered = yield* waitFor(jira, (snapshot) =>
          snapshot.suggestions.some((entry) => entry.state === "offered"),
        );
        expect(offered.suggestions[0]?.matches).toEqual([]);
        expect((yield* Ref.get(calls)).some((call) => call.operation === "jira.match")).toBe(false);

        yield* jira.command({ type: "suggestion", threadId, action: "rematch" });
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

  it.effect("marks Jira signed out when any call finds the login gone", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ConnectorAgentRun>>([]);
      yield* Effect.gen(function* () {
        const jira = yield* JiraService.JiraService;
        yield* jira.command({ type: "sync" });
        yield* waitFor(jira, (snapshot) => snapshot.sync.status === "ok");
        const failed = yield* jira
          .command({ type: "loadDetails", key: "AIPR-1309" })
          .pipe(Effect.flip);
        expect(failed.message).toContain("sign in again");
        const signedOut = yield* waitFor(jira, (snapshot) => snapshot.sync.status === "signed-out");
        expect(signedOut.sync.message).toContain("claude.ai connector settings");
      }).pipe(Effect.provide(makeLayer(calls)));
    }),
  );

  it.effect("drafts a new ticket from the chat without writing to Jira", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ConnectorAgentRun>>([]);
      yield* Effect.gen(function* () {
        const jira = yield* JiraService.JiraService;
        yield* jira.command({ type: "sync" });
        yield* waitFor(jira, (snapshot) => snapshot.sync.status === "ok");
        const draft = yield* jira.command({ type: "draftTicket", threadId });
        expect(draft).toEqual({
          parentKey: "AIPR-1177",
          summary: "Board export button",
          description: "Add an export button to the board.",
        });
        const call = (yield* Ref.get(calls)).find(
          (entry) => entry.operation === "jira.draftTicket",
        );
        expect(call?.toolPrefixes).toEqual([]);
        expect(call?.prompt).toContain("add an export button to the board agent");
        expect(call?.prompt).toContain("Added the button.");
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

  it.effect("links a ticket key typed in the first message without asking or a model", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ConnectorAgentRun>>([]);
      yield* Effect.gen(function* () {
        const jira = yield* JiraService.JiraService;
        yield* jira.command({ type: "sync" });
        yield* waitFor(jira, (snapshot) => snapshot.sync.status === "ok");
        yield* jira.onFirstMessage({ threadId, message: "fix AIPR-1309 buttons" });
        const ready = yield* waitFor(jira, (snapshot) =>
          snapshot.suggestions.some((entry) => entry.state === "ready"),
        );
        expect(ready.suggestions[0]?.matches[0]).toMatchObject({
          key: "AIPR-1309",
          confidence: "high",
        });
        expect((yield* Ref.get(calls)).some((call) => call.operation === "jira.match")).toBe(false);
      }).pipe(Effect.provide(makeLayer(calls)));
    }),
  );
});
