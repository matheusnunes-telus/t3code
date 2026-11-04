import {
  type JiraChange,
  type JiraChangeSet,
  type JiraCommand,
  type JiraCommandResult,
  type JiraIssue,
  JiraError,
  JiraIssue as JiraIssueSchema,
  JiraIssueDetails as JiraIssueDetailsSchema,
  JiraSprint as JiraSprintSchema,
  JiraChangeSet as JiraChangeSetSchema,
  type JiraSnapshot,
  JiraSyncState,
  JiraThreadLink as JiraThreadLinkSchema,
  type JiraThreadLink,
  JiraThreadSuggestion as JiraThreadSuggestionSchema,
  type JiraThreadSuggestion,
  type JiraTicketDraft,
  JiraTicketNotice,
  JiraTicketUpdates,
  type ModelSelection,
  type ServerSettings as ServerSettingsValue,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { ConnectorAgent, ConnectorAgentResult } from "@t3tools/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildDraftTicketPrompt,
  buildMatchPrompt,
  CHANGES_OUTPUT_SCHEMA,
  commentText,
  JIRA_SEARCH_FIELDS,
  JIRA_DETAIL_FIELDS,
  JIRA_STATUSES,
  parseIssueDetails,
  keysMentioned,
  looksSignedOut,
  MATCH_OUTPUT_SCHEMA,
  mergeSync,
  missingAncestors,
  parseAccessibleSite,
  parseBoardIds,
  parseBoardSprints,
  parseCliSearchKeys,
  parseIssueSearch,
  parseOpenSprints,
  transitionTo,
  unwrapMcpReply,
  DRAFT_OUTPUT_SCHEMA,
  validateFormDraft,
  validateMatch,
} from "./jiraModel.ts";

/**
 * Your own Atlassian MCP server, as `claude mcp add` saves it. Runs load only this server, under
 * this name, so they keep its login and skip the account's other connectors.
 */
const ATLASSIAN_MCP_NAME = "atlassian";
const ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v2/mcp";
const ATLASSIAN_MCP_SERVERS = { [ATLASSIAN_MCP_NAME]: { type: "http", url: ATLASSIAN_MCP_URL } };
const ATLASSIAN_TOOL_PREFIXES = [`mcp__${ATLASSIAN_MCP_NAME}`];
/** After MCP fails in a way `acli` can cover, calls skip it for a while instead of waiting on it. */
const MCP_RETRY_AFTER = Duration.minutes(15);
const SYNC_INTERVAL = Duration.hours(1);
const FULL_SYNC_INTERVAL = Duration.hours(24);
const TICK_INTERVAL = Duration.minutes(5);
const MAX_SEARCH_RESULTS = 100;
/** The Atlassian CLI reads one ticket per call, so a sync reads a few at once. */
const CLI_CONCURRENCY = 6;
const CLI_SIGNED_OUT_MESSAGE =
  "The Atlassian CLI is signed out. Sign in again from the notification, or run acli jira auth login --web.";
const MCP_SIGNED_OUT_MESSAGE =
  "The Atlassian MCP login is gone. Sign in again from the notification, or run claude mcp login atlassian.";

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  cloudId: Schema.NullOr(Schema.String),
  siteUrl: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  lastFullSyncAt: Schema.NullOr(Schema.String),
  sync: JiraSyncState,
  issues: Schema.Array(JiraIssueSchema),
  links: Schema.Array(JiraThreadLinkSchema),
  suggestions: Schema.Array(JiraThreadSuggestionSchema),
  changeSets: Schema.Array(JiraChangeSetSchema),
  ticketUpdates: Schema.Record(Schema.String, JiraTicketUpdates),
  notices: Schema.Array(JiraTicketNotice),
  /** Each linked thread's pull request states as last seen, keyed `repository#number`. */
  pullRequests: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  /** Optional so stores written before ticket details still load. */
  details: Schema.optionalKey(Schema.Record(Schema.String, JiraIssueDetailsSchema)),
  sprints: Schema.optionalKey(Schema.Array(JiraSprintSchema)),
});
type StoreFile = typeof StoreFile.Type;

const EMPTY_STORE: StoreFile = {
  version: 1,
  cloudId: null,
  siteUrl: null,
  accountId: null,
  lastFullSyncAt: null,
  sync: { status: "never", lastSyncedAt: null, lastAttemptAt: null, message: null },
  issues: [],
  links: [],
  suggestions: [],
  changeSets: [],
  ticketUpdates: {},
  notices: [],
  pullRequests: {},
};

const decodeStore = Schema.decodeUnknownOption(Schema.fromJsonString(StoreFile));
const encodeStore = Schema.encodeSync(Schema.fromJsonString(StoreFile));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Why a Jira call failed, so sync status can say "signed out" rather than "failed". "agent" is
 * the model run itself failing, such as at a usage limit, which says nothing about Jira.
 */
class JiraCallError extends Data.TaggedError("JiraCallError")<{
  readonly kind: "signed-out" | "unavailable" | "agent" | "failed";
  readonly message: string;
}> {}

export interface JiraFirstMessage {
  readonly threadId: ThreadId;
  readonly message: string;
  /** The chat's project, whose settings can turn suggestions off. */
  readonly projectId?: ProjectId;
  /** A "No project" chat, which gets no suggestion unless the setting asks for it. */
  readonly noProject?: boolean;
}

/** Called when a thread's first message arrives, so Jira can suggest its ticket. */
export class JiraFirstMessageHook extends Context.Reference<
  ((input: JiraFirstMessage) => Effect.Effect<void>) | undefined
>("t3/jira/JiraFirstMessageHook", { defaultValue: () => undefined }) {}

export class JiraService extends Context.Service<
  JiraService,
  {
    readonly subscribe: () => Stream.Stream<JiraSnapshot>;
    readonly sync: (input: {
      readonly full?: boolean | undefined;
    }) => Effect.Effect<void, JiraError>;
    readonly link: (input: {
      readonly threadId: ThreadId;
      readonly key: string;
      readonly linked: boolean;
    }) => Effect.Effect<void, JiraError>;
    readonly suggestion: (input: {
      readonly threadId: ThreadId;
      readonly action: "dismiss" | "rematch";
    }) => Effect.Effect<void, JiraError>;
    readonly createTicket: (input: {
      readonly threadId: ThreadId;
      readonly draft: JiraTicketDraft;
    }) => Effect.Effect<void, JiraError>;
    readonly proposeChanges: (input: {
      /** A merge always offers a status change, even when the model suggests none. */
      readonly merged?: boolean;
      readonly threadId: ThreadId;
      readonly key: string;
      readonly reason?: string | undefined;
    }) => Effect.Effect<void, JiraError>;
    readonly suggestDoneOnSettle: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    readonly resolveChanges: (input: {
      readonly id: string;
      readonly action: "apply" | "dismiss";
      readonly changes?: ReadonlyArray<JiraChange> | undefined;
    }) => Effect.Effect<void, JiraError>;
    readonly setTicketUpdates: (input: {
      readonly key: string;
      readonly updates: "link" | "notify";
    }) => Effect.Effect<void, JiraError>;
    readonly clearNotice: (input: { readonly key: string }) => Effect.Effect<void, JiraError>;
    readonly command: (input: JiraCommand) => Effect.Effect<JiraCommandResult, JiraError>;
    readonly onFirstMessage: (input: JiraFirstMessage) => Effect.Effect<void>;
  }
>()("t3/jira/JiraService") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const olderThan = (iso: string | null, duration: Duration.Duration, now: number) =>
  iso === null || now - Date.parse(iso) > Duration.toMillis(duration);

const jiraError = (message: string) => new JiraError({ message });

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const scope = yield* Effect.scope;

  const storePath = path.join(stateDir, "jira.json");
  const initial = yield* fileSystem.readFileString(storePath).pipe(
    Effect.map((raw) => decodeStore(raw)),
    Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value : EMPTY_STORE)),
    Effect.orElseSucceed(() => EMPTY_STORE),
  );
  // A sync or match cut off by a restart would otherwise spin forever.
  const store = yield* Ref.make<StoreFile>({
    ...initial,
    sync:
      initial.sync.status === "syncing"
        ? { ...initial.sync, status: initial.sync.lastSyncedAt === null ? "never" : "ok" }
        : initial.sync,
    suggestions: initial.suggestions.map((suggestion) =>
      suggestion.state === "matching" || suggestion.state === "creating"
        ? { ...suggestion, state: "failed" as const, message: "Interrupted by a restart." }
        : suggestion,
    ),
    changeSets: initial.changeSets.map((set) =>
      set.state === "applying"
        ? { ...set, state: "failed" as const, message: "Interrupted by a restart." }
        : set,
    ),
  });
  const changes = yield* PubSub.sliding<void>(1);
  const writeLock = yield* Semaphore.make(1);
  const syncLock = yield* Semaphore.make(1);
  const signInLock = yield* Semaphore.make(1);

  const persist = writeLock.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(store);
      const temp = `${storePath}.tmp`;
      yield* fileSystem.writeFileString(temp, encodeStore(current));
      yield* fileSystem.rename(temp, storePath);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not save Jira state.").pipe(Effect.annotateLogs({ cause })),
      ),
    ),
  );

  const update = (mutate: (current: StoreFile) => StoreFile) =>
    Ref.update(store, mutate).pipe(
      Effect.andThen(persist),
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.asVoid,
    );

  const fork = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Jira background work failed.").pipe(Effect.annotateLogs({ cause })),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const selection = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.jiraModelSelection),
    Effect.orElseSucceed(() => null),
  );

  /**
   * Jira calls go through the Atlassian MCP first and fall back to the Atlassian CLI (`acli`).
   * Each one's login, as the last call found it. MCP is "unavailable" when the Jira provider
   * cannot run it at all; `acli` is "missing" when it is not installed.
   */
  const mcp = yield* Ref.make<"unknown" | "ready" | "signed-out" | "unavailable">("unknown");
  const cli = yield* Ref.make<"unknown" | "ready" | "missing" | "signed-out">("unknown");
  /** When MCP may be tried again after a failure `acli` covered. */
  const mcpSkipUntil = yield* Ref.make(0);
  /** Which one the last call that worked went through. */
  const via = yield* Ref.make<"mcp" | "cli" | null>(null);
  /** The MCP sign-in page while a sign-in waits, in case no browser tab opened. */
  const signInUrl = yield* Ref.make<string | null>(null);

  const snapshotOf = (
    current: StoreFile,
    settings: ServerSettingsValue | null,
    logins: {
      readonly signIn: JiraSnapshot["signIn"];
      readonly via: JiraSnapshot["via"];
      readonly mcpSignedOut: boolean;
      readonly signInUrl: string | null;
    },
  ): JiraSnapshot => {
    const enabled = settings?.jiraModelSelection != null;
    return {
      enabled,
      sync: enabled ? current.sync : { ...current.sync, status: "off" },
      siteUrl: current.siteUrl,
      issues: current.issues,
      links: current.links,
      suggestions: current.suggestions,
      changeSets: current.changeSets,
      ticketUpdates: current.ticketUpdates,
      notices: current.notices,
      details: current.details ?? {},
      sprints: current.sprints ?? [],
      ...logins,
    };
  };

  const currentSnapshot = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const mcpState = yield* Ref.get(mcp);
    const cliState = yield* Ref.get(cli);
    return snapshotOf(yield* Ref.get(store), settings, {
      signIn:
        mcpState !== "unavailable"
          ? "mcp"
          : cliState !== "missing" && cliState !== "unknown"
            ? "cli"
            : "none",
      via: yield* Ref.get(via),
      mcpSignedOut: mcpState === "signed-out",
      signInUrl: yield* Ref.get(signInUrl),
    });
  });

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const settingsChanges = yield* serverSettings.subscribeChanges;
        return Stream.concat(
          Stream.fromEffect(currentSnapshot),
          Stream.merge(
            Stream.fromSubscription(subscription),
            settingsChanges.pipe(Stream.map(() => undefined)),
          ).pipe(Stream.mapEffect(() => currentSnapshot)),
        );
      }),
    );

  const resolveAgent = Effect.gen(function* () {
    const modelSelection = yield* selection;
    if (modelSelection === null) {
      return yield* new JiraCallError({ kind: "unavailable", message: "Jira is off." });
    }
    const instance = yield* registry.getInstance(modelSelection.instanceId);
    if (instance?.connectorAgent === undefined) {
      return yield* new JiraCallError({
        kind: "unavailable",
        message: "This provider cannot reach Jira. Pick a Claude provider for Jira.",
      });
    }
    return { agent: instance.connectorAgent, modelSelection };
  });

  const runAgent = Effect.fn("JiraService.runAgent")(function* (
    request: Omit<Parameters<ConnectorAgent["run"]>[0], "modelSelection" | "mcpServers">,
  ) {
    const { agent, modelSelection } = yield* resolveAgent;
    return yield* agent
      .run({
        ...request,
        modelSelection,
        // Runs without Atlassian tools load no server at all.
        mcpServers: request.toolPrefixes.length > 0 ? ATLASSIAN_MCP_SERVERS : {},
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new JiraCallError({
              kind: looksSignedOut(error.detail) ? "signed-out" : "agent",
              message: error.detail,
            }),
        ),
      );
  });

  /** Tells "the MCP server isn't there" and "it lost its login" apart from a plain failure. */
  const connectorProblem = (result: ConnectorAgentResult) => {
    const hasTools = result.availableTools.some((tool) =>
      ATLASSIAN_TOOL_PREFIXES.some((prefix) => tool.startsWith(`${prefix}__`)),
    );
    if (hasTools) return undefined;
    const server = result.mcpServers.find((candidate) => candidate.name === ATLASSIAN_MCP_NAME);
    if (server?.status === "needs-auth") {
      return new JiraCallError({ kind: "signed-out", message: MCP_SIGNED_OUT_MESSAGE });
    }
    return new JiraCallError({
      kind: "agent",
      message: `The Atlassian MCP server is ${server?.status ?? "missing"}.`,
    });
  };

  const setLogin = <S>(ref: Ref.Ref<S>, state: S) =>
    Ref.getAndSet(ref, state).pipe(
      Effect.flatMap((previous) =>
        previous === state ? Effect.void : PubSub.publish(changes, undefined),
      ),
      Effect.asVoid,
    );

  /** One MCP tool call. The model only places the call; its reply is read here, raw. */
  const callTool = Effect.fn("JiraService.callTool")(
    function* (operation: string, tool: string, args: Record<string, unknown>) {
      const result = yield* runAgent({
        operation,
        toolPrefixes: ATLASSIAN_TOOL_PREFIXES,
        prompt: [
          `Call the Atlassian tool ${tool} exactly once with exactly these arguments, then reply with the single word done.`,
          "Do not call any other tool and do not summarize the result.",
          "",
          encodeJson(args),
        ].join("\n"),
      });
      const problem = connectorProblem(result);
      if (problem !== undefined) return yield* problem;
      const reply = result.toolResults.findLast((entry) => entry.tool.endsWith(`__${tool}`));
      if (reply === undefined) {
        return yield* new JiraCallError({
          kind: "agent",
          message: `The agent did not call ${tool}.`,
        });
      }
      if (reply.isError) {
        return yield* new JiraCallError({
          kind: looksSignedOut(reply.text) ? "signed-out" : "failed",
          message: reply.text.slice(0, 500),
        });
      }
      return unwrapMcpReply(reply.text);
    },
    (effect) =>
      effect.pipe(
        Effect.tap(() => setLogin(mcp, "ready")),
        Effect.tapError((error) =>
          error.kind === "signed-out"
            ? setLogin(mcp, "signed-out")
            : error.kind === "unavailable"
              ? setLogin(mcp, "unavailable")
              : Effect.void,
        ),
      ),
  );

  /** Asks `acli` whether its login works, and notes the site it is signed in to. */
  const checkCli = Effect.gen(function* () {
    const result = yield* runner
      .run({ command: "acli", args: ["jira", "auth", "status"], timeout: "20 seconds" })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      const state = result.failure._tag === "ProcessSpawnError" ? "missing" : "signed-out";
      yield* setLogin(cli, state);
      return state;
    }
    const output = `${result.success.stdout}\n${result.success.stderr}`;
    const state =
      result.success.code === 0 && /✓\s*Authenticated/.test(output) ? "ready" : "signed-out";
    yield* setLogin(cli, state);
    const site = /Site:\s*(\S+)/.exec(output)?.[1];
    if (state === "ready" && site !== undefined && (yield* Ref.get(store)).siteUrl === null) {
      yield* update((current) => ({ ...current, siteUrl: `https://${site}` }));
    }
    return state;
  });

  /** True when `acli` can take a call now; a login it lacked is looked at again. */
  const cliReady = Effect.gen(function* () {
    const state = yield* Ref.get(cli);
    if (state === "ready") return true;
    return state !== "missing" && (yield* checkCli) === "ready";
  });

  /** Keeps the sync status's "signed out" in step with what each call finds. */
  const trackLogin = <A>(effect: Effect.Effect<A, JiraCallError>) =>
    effect.pipe(
      // Any call can find the login gone, not only a sync, and any call that works proves it back.
      Effect.tapError((error) =>
        error.kind === "signed-out"
          ? setSync({ status: "signed-out", message: error.message })
          : Effect.void,
      ),
      Effect.tap(() =>
        Effect.gen(function* () {
          const { sync } = yield* Ref.get(store);
          if (sync.status !== "signed-out") return;
          yield* setSync({ status: sync.lastSyncedAt === null ? "never" : "ok", message: null });
        }),
      ),
    );

  /** One `acli` call; its stdout comes back as is. A failure checks the login to say why. */
  const runCli = Effect.fn("JiraService.runCli")(function* (args: ReadonlyArray<string>) {
    const result = yield* runner
      .run({ command: "acli", args, timeout: "90 seconds" })
      .pipe(Effect.result);
    if (result._tag === "Success" && result.success.code === 0) {
      yield* setLogin(cli, "ready");
      return result.success.stdout;
    }
    const message =
      result._tag === "Failure"
        ? result.failure.message
        : (result.success.stderr.trim() || result.success.stdout.trim()).slice(0, 500);
    const state = yield* checkCli;
    return yield* new JiraCallError({
      kind: state === "signed-out" ? "signed-out" : state === "missing" ? "unavailable" : "failed",
      message: state === "signed-out" ? CLI_SIGNED_OUT_MESSAGE : message.replace(/^✗\s*/, ""),
    });
  });

  const preferMcpSignOut = Effect.fn("JiraService.preferMcpSignOut")(function* (
    error: JiraCallError,
  ) {
    if (error.kind !== "signed-out" || (yield* Ref.get(mcp)) !== "signed-out") {
      return yield* error;
    }
    return yield* new JiraCallError({ kind: "signed-out", message: MCP_SIGNED_OUT_MESSAGE });
  });

  /**
   * One Jira call: through MCP, or through `acli` when MCP is signed out or its agent cannot run,
   * such as at a usage limit. A Jira error from MCP is final; `acli` would only repeat it. Calls
   * `acli` has no way to make pass no fallback.
   */
  const viaMcp = <A>(
    mcpCall: Effect.Effect<A, JiraCallError>,
    cliCall?: Effect.Effect<A, JiraCallError>,
  ) =>
    trackLogin(
      Effect.gen(function* () {
        const fallback = cliCall !== undefined && (yield* cliReady) ? cliCall : undefined;
        // With both logins gone, the MCP one is what Sign in fixes, so its message wins.
        const viaCli = (call: Effect.Effect<A, JiraCallError>) =>
          call.pipe(
            Effect.tap(() => setLogin(via, "cli")),
            Effect.catchTags({ JiraCallError: preferMcpSignOut }),
          );
        const now = yield* Clock.currentTimeMillis;
        if (fallback !== undefined && now < (yield* Ref.get(mcpSkipUntil))) {
          return yield* viaCli(fallback);
        }
        const result = yield* Effect.result(mcpCall);
        if (result._tag === "Success") {
          yield* setLogin(via, "mcp");
          return result.success;
        }
        if (fallback === undefined || result.failure.kind === "failed") {
          return yield* result.failure;
        }
        yield* Effect.logInfo("Jira falls back to the Atlassian CLI.").pipe(
          Effect.annotateLogs({ reason: result.failure.message }),
        );
        yield* Ref.set(mcpSkipUntil, now + Duration.toMillis(MCP_RETRY_AFTER));
        return yield* viaCli(fallback);
      }),
    );

  const ensureSite = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const current = yield* Ref.get(store);
    const configured = settings?.jiraSite.trim() ?? "";
    if (configured.length > 0) {
      if (current.cloudId !== configured) {
        yield* update((state) => ({ ...state, cloudId: configured }));
      }
      return configured;
    }
    if (current.cloudId !== null) return current.cloudId;
    const reply = yield* callTool("jira.discoverSite", "getAccessibleAtlassianResources", {});
    const site = parseAccessibleSite(reply);
    if (site === undefined) {
      return yield* new JiraCallError({
        kind: "failed",
        message: "The Atlassian connector returned no Jira site.",
      });
    }
    yield* update((state) => ({
      ...state,
      cloudId: site.id,
      siteUrl: state.siteUrl ?? site.url,
    }));
    return site.id;
  });

  const ensureAccountId = Effect.gen(function* () {
    const current = yield* Ref.get(store);
    if (current.accountId !== null) return current.accountId;
    const reply = yield* callTool("jira.whoAmI", "atlassianUserInfo", {});
    const accountId = /"account_?[iI]d"\s*:\s*"([^"]+)"/.exec(reply)?.[1] ?? null;
    if (accountId !== null) yield* update((state) => ({ ...state, accountId }));
    return accountId;
  });

  /**
   * `acli` search only returns a few fields, never the parent, so it finds the keys and each
   * ticket is read on its own. The result is shaped like the connector's search reply.
   */
  const cliSearch = Effect.fn("JiraService.cliSearch")(function* (jql: string) {
    const reply = yield* runCli([
      "jira",
      "workitem",
      "search",
      "--jql",
      jql,
      // `key` alone comes back as nulls.
      "--fields",
      "summary",
      "--limit",
      String(MAX_SEARCH_RESULTS),
      "--json",
    ]);
    const keys = parseCliSearchKeys(reply);
    if (keys === undefined) {
      return yield* new JiraCallError({
        kind: "failed",
        message: `Jira's search reply could not be read: ${reply.slice(0, 200)}`,
      });
    }
    const issues = yield* Effect.forEach(
      keys,
      (key) =>
        runCli([
          "jira",
          "workitem",
          "view",
          key,
          "--fields",
          JIRA_SEARCH_FIELDS.join(","),
          "--json",
        ]),
      { concurrency: CLI_CONCURRENCY },
    );
    return `{"issues":[${issues.join(",")}]}`;
  });

  const search = Effect.fn("JiraService.search")(function* (jql: string, mine: boolean) {
    const reply = yield* viaMcp(
      Effect.gen(function* () {
        return yield* callTool("jira.search", "searchJiraIssuesUsingJql", {
          cloudId: yield* ensureSite,
          jql,
          fields: JIRA_SEARCH_FIELDS,
          maxResults: MAX_SEARCH_RESULTS,
          // The default view drops the parent, the type's level and the status category.
          view: "full",
        });
      }),
      cliSearch(jql),
    );
    const siteUrl = (yield* Ref.get(store)).siteUrl;
    const parsed = parseIssueSearch(reply, mine, siteUrl);
    if (parsed === undefined) {
      return yield* new JiraCallError({
        kind: looksSignedOut(reply) ? "signed-out" : "failed",
        message: `Jira's search reply could not be read: ${reply.slice(0, 200)}`,
      });
    }
    if (siteUrl === null && parsed.siteUrl !== null) {
      yield* update((state) => ({ ...state, siteUrl: parsed.siteUrl }));
    }
    return parsed;
  });

  /**
   * MCP reads the open sprints off tickets that sit in one; `acli` lists each project board's
   * sprints, which also holds upcoming sprints nobody has filled yet.
   */
  const openSprints = Effect.fn("JiraService.openSprints")(function* (
    projects: ReadonlyArray<string>,
  ) {
    const fromBoards = Effect.gen(function* () {
      const boards = yield* Effect.forEach(
        projects,
        (project) =>
          runCli(["jira", "board", "search", "--project", project, "--json"]).pipe(
            Effect.map(parseBoardIds),
          ),
        { concurrency: CLI_CONCURRENCY },
      );
      const replies = yield* Effect.forEach(
        [...new Set(boards.flat())],
        (boardId) =>
          runCli([
            "jira",
            "board",
            "list-sprints",
            "--id",
            String(boardId),
            "--state",
            "active,future",
            "--json",
          ]).pipe(Effect.map((reply) => ({ boardId, reply }))),
        { concurrency: CLI_CONCURRENCY },
      );
      return parseBoardSprints(replies);
    });
    const fromTickets = Effect.gen(function* () {
      const reply = yield* callTool("jira.sprints", "searchJiraIssuesUsingJql", {
        cloudId: yield* ensureSite,
        jql: `project in (${projects.join(",")}) AND sprint in openSprints()`,
        fields: ["customfield_10020"],
        maxResults: MAX_SEARCH_RESULTS,
        view: "full",
      });
      return parseOpenSprints(reply);
    });
    return yield* viaMcp(fromTickets, fromBoards);
  });

  /** One ticket's fields, as a REST-shaped issue either way. */
  const readIssue = (key: string, fields: ReadonlyArray<string>) =>
    viaMcp(
      Effect.gen(function* () {
        return yield* callTool("jira.issueDetails", "getJiraIssue", {
          cloudId: yield* ensureSite,
          issueIdOrKey: key,
          fields: [...fields],
          fieldsByKeys: true,
          view: "full",
        });
      }),
      runCli(["jira", "workitem", "view", key, "--fields", fields.join(","), "--json"]),
    );

  const setSync = (patch: Partial<StoreFile["sync"]>) =>
    update((state) => ({ ...state, sync: { ...state.sync, ...patch } }));

  const runSync = Effect.fn("JiraService.runSync")(
    function* (full: boolean) {
      const startedAt = yield* nowIso;
      yield* setSync({ status: "syncing", lastAttemptAt: startedAt, message: null });
      // A sync is the moment to notice `acli` was installed, or signed in, since the last one.
      if ((yield* Ref.get(cli)) !== "ready") yield* checkCli;
      const before = yield* Ref.get(store);
      const fullSync =
        full ||
        before.issues.length === 0 ||
        olderThan(before.lastFullSyncAt, FULL_SYNC_INTERVAL, Date.parse(startedAt));
      // Relative minutes, because absolute JQL dates are read in the account's own time zone.
      const minutes =
        before.sync.lastSyncedAt === null
          ? 60 * 24
          : Math.ceil((Date.parse(startedAt) - Date.parse(before.sync.lastSyncedAt)) / 60_000) + 10;
      const jql = fullSync
        ? "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
        : `assignee = currentUser() AND updated >= -${minutes}m ORDER BY updated DESC`;
      const own = yield* search(jql, true);

      const mergeInto = (
        state: StoreFile,
        fetched: ReadonlyArray<JiraIssue>,
        parents: ReadonlyArray<JiraIssue>,
        asFull: boolean,
      ) => {
        const merged = mergeSync({
          previous: state.issues,
          fetched,
          parents,
          full: asFull,
          linkedKeys: new Set(state.links.map((link) => link.key)),
          ticketUpdates: state.ticketUpdates,
          at: startedAt,
        });
        return {
          ...state,
          issues: merged.issues,
          notices: [
            ...state.notices.filter(
              (notice) => !merged.notices.some((next) => next.key === notice.key),
            ),
            ...merged.notices,
          ],
        };
      };
      yield* update((state) => mergeInto(state, own.issues, own.parents, fullSync));

      if (fullSync || before.sprints === undefined) {
        const projects = [
          ...new Set(
            (yield* Ref.get(store)).issues
              .filter((issue) => issue.assignedToMe)
              .flatMap((issue) => issue.key.split("-").slice(0, 1)),
          ),
        ];
        if (projects.length > 0) {
          const sprints = yield* openSprints(projects);
          if (sprints !== undefined) yield* update((state) => ({ ...state, sprints }));
        }
      }

      // Walk up to the initiatives, and fetch linked tickets the tree does not hold.
      const asked = new Set<string>();
      for (let round = 0; round < 3; round += 1) {
        const current = yield* Ref.get(store);
        const known = new Set(current.issues.map((issue) => issue.key));
        const wanted = [
          ...new Set([
            ...missingAncestors(current.issues),
            ...current.links.map((link) => link.key).filter((key) => !known.has(key)),
          ]),
        ]
          .filter((key) => !asked.has(key))
          .slice(0, 50);
        if (wanted.length === 0) break;
        for (const key of wanted) asked.add(key);
        const fetched = yield* search(`key in (${wanted.join(",")})`, false);
        yield* update((state) => mergeInto(state, fetched.issues, fetched.parents, false));
        if (fetched.issues.length === 0) break;
      }
      const finishedAt = yield* nowIso;
      yield* update((state) => ({
        ...state,
        lastFullSyncAt: fullSync ? finishedAt : state.lastFullSyncAt,
        sync: { status: "ok", lastSyncedAt: finishedAt, lastAttemptAt: startedAt, message: null },
      }));
    },
    (effect) =>
      effect.pipe(
        Effect.catchTags({
          JiraCallError: (error) =>
            setSync({
              status:
                error.kind === "signed-out"
                  ? "signed-out"
                  : error.kind === "unavailable"
                    ? "unavailable"
                    : "failed",
              message: error.message,
            }),
        }),
      ),
  );

  const sync: JiraService["Service"]["sync"] = Effect.fn("JiraService.sync")(function* (input) {
    if ((yield* selection) === null) return yield* jiraError("Jira is off.");
    // A second request while one runs would only repeat it.
    yield* syncLock.withPermitsIfAvailable(1)(runSync(input.full === true));
  });

  const findSuggestion = (state: StoreFile, threadId: ThreadId) =>
    state.suggestions.find((suggestion) => suggestion.threadId === threadId);

  const putSuggestion = (suggestion: JiraThreadSuggestion) =>
    update((state) => ({
      ...state,
      suggestions: [
        ...state.suggestions.filter((entry) => entry.threadId !== suggestion.threadId),
        suggestion,
      ],
    }));

  const runMatch = Effect.fn("JiraService.runMatch")(function* (
    threadId: ThreadId,
    message: string,
  ) {
    const createdAt = yield* nowIso;
    const issues = (yield* Ref.get(store)).issues;
    const named = keysMentioned(message, issues);
    if (named.length > 0) {
      return yield* putSuggestion({
        threadId,
        createdAt,
        state: "ready",
        matches: named.slice(0, 3).map((key) => ({
          key,
          confidence: "high" as const,
          reason: "Named in your message",
        })),
        draft: null,
        message: null,
      });
    }
    yield* putSuggestion({
      threadId,
      createdAt,
      state: "matching",
      matches: [],
      draft: null,
      message: null,
    });
    const result = yield* runAgent({
      operation: "jira.match",
      toolPrefixes: [],
      prompt: buildMatchPrompt({ message, issues }),
      outputSchema: MATCH_OUTPUT_SCHEMA,
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      return yield* putSuggestion({
        threadId,
        createdAt,
        state: "failed",
        matches: [],
        draft: null,
        message: result.failure.message,
      });
    }
    const { matches, draft } = validateMatch(result.success.output, issues);
    yield* putSuggestion({
      threadId,
      createdAt,
      state: "ready",
      matches,
      draft,
      message: null,
    });
  });

  const onFirstMessage: JiraService["Service"]["onFirstMessage"] = Effect.fn(
    "JiraService.onFirstMessage",
  )(function* (input) {
    if ((yield* selection) === null || input.message.trim().length === 0) return;
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    const mode =
      settings._tag === "None"
        ? "ask"
        : resolveProjectSettings(settings.value, input.projectId ?? null).settings.jiraSuggest;
    if (mode === "off") return;
    if (
      input.noProject === true &&
      !(settings._tag === "Some" && settings.value.jiraSuggestNoProject)
    ) {
      return;
    }
    const current = yield* Ref.get(store);
    if (current.issues.length === 0) return;
    if (
      findSuggestion(current, input.threadId) !== undefined ||
      current.links.some((link) => link.threadId === input.threadId)
    ) {
      return;
    }
    // A key typed in the message is a sure match and costs no model call, so it never waits.
    if (mode === "always" || keysMentioned(input.message, current.issues).length > 0) {
      return yield* fork(runMatch(input.threadId, input.message));
    }
    yield* putSuggestion({
      threadId: input.threadId,
      createdAt: yield* nowIso,
      state: "offered",
      matches: [],
      draft: null,
      message: null,
    });
  });

  const link: JiraService["Service"]["link"] = Effect.fn("JiraService.link")(function* (input) {
    const key = input.key.trim().toUpperCase();
    const linkedAt = yield* nowIso;
    yield* update((state) => {
      const others = state.links.filter(
        (entry) => !(entry.threadId === input.threadId && entry.key === key),
      );
      if (!input.linked) return { ...state, links: others };
      const suggestion = findSuggestion(state, input.threadId);
      const entry: JiraThreadLink = {
        threadId: input.threadId,
        key,
        linkedAt,
        source: suggestion?.matches.some((match) => match.key === key) ? "suggestion" : "manual",
      };
      return {
        ...state,
        links: [...others, entry],
        // Linking answers the suggestion.
        suggestions: state.suggestions.map((candidate) =>
          candidate.threadId === input.threadId && candidate.state === "ready"
            ? { ...candidate, state: "dismissed" as const }
            : candidate,
        ),
      };
    });
    const known = (yield* Ref.get(store)).issues.some((issue) => issue.key === key);
    if (input.linked && !known) yield* fork(sync({}));
  });

  const firstUserMessage = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }).pipe(
      Effect.map((records) => records.messages.find((message) => message.text.trim().length > 0)),
      Effect.mapError(() => jiraError("Could not read the thread.")),
    );

  const suggestion: JiraService["Service"]["suggestion"] = Effect.fn("JiraService.suggestion")(
    function* (input) {
      if (input.action === "dismiss") {
        const createdAt = yield* nowIso;
        const current = findSuggestion(yield* Ref.get(store), input.threadId);
        return yield* putSuggestion({
          ...(current ?? {
            threadId: input.threadId,
            createdAt,
            matches: [],
            draft: null,
            message: null,
          }),
          state: "dismissed",
        });
      }
      if ((yield* selection) === null) return yield* jiraError("Jira is off.");
      const message = yield* firstUserMessage(input.threadId);
      if (message === undefined) return yield* jiraError("This thread has no message to match.");
      yield* fork(runMatch(input.threadId, message.text));
    },
  );

  /** A ticket was created, but a step after that failed; the toast says which. */
  const noteCreateFailure = Effect.fn("JiraService.noteCreateFailure")(function* (
    key: string,
    summary: string,
  ) {
    const at = yield* nowIso;
    yield* update((state) => ({
      ...state,
      notices: [...state.notices.filter((notice) => notice.key !== key), { key, at, summary }],
    }));
  });

  const createTicket: JiraService["Service"]["createTicket"] = Effect.fn(
    "JiraService.createTicket",
  )(function* (input) {
    const before = findSuggestion(yield* Ref.get(store), input.threadId);
    const createdAt = yield* nowIso;
    const base = before ?? {
      threadId: input.threadId,
      createdAt,
      matches: [],
      draft: input.draft,
      message: null,
    };
    yield* putSuggestion({ ...base, draft: input.draft, state: "creating", message: null });
    const work = Effect.gen(function* () {
      const projectKey = input.draft.parentKey.split("-")[0] ?? input.draft.parentKey;
      const sprintId = input.draft.sprintId;
      // MCP files the ticket in its sprint as it creates it; `acli` cannot, so that comes after.
      const { reply, sprintLeft } = yield* viaMcp(
        Effect.gen(function* () {
          const cloudId = yield* ensureSite;
          const accountId = yield* ensureAccountId.pipe(Effect.orElseSucceed(() => null));
          const reply = yield* callTool("jira.createIssue", "createJiraIssue", {
            cloudId,
            projectKey,
            issueType: input.draft.type,
            summary: input.draft.summary,
            description: input.draft.description,
            parent: input.draft.parentKey,
            ...(accountId === null ? {} : { assignee: accountId }),
            ...(sprintId == null ? {} : { assignToSprint: String(sprintId) }),
          });
          return { reply, sprintLeft: /"assigned"\s*:\s*false/.test(reply) };
        }),
        runCli([
          "jira",
          "workitem",
          "create",
          "--project",
          projectKey,
          "--type",
          input.draft.type,
          "--summary",
          input.draft.summary,
          "--description",
          input.draft.description,
          "--parent",
          input.draft.parentKey,
          "--assignee",
          "@me",
          "--json",
        ]).pipe(Effect.map((reply) => ({ reply, sprintLeft: sprintId != null }))),
      );
      const key = /"key"\s*:\s*"([A-Z][A-Z0-9]+-\d+)"/.exec(reply)?.[1];
      if (key === undefined) {
        return yield* new JiraCallError({
          kind: "failed",
          message: `Jira did not return the new ticket's key: ${reply.slice(0, 200)}`,
        });
      }
      const linkedAt = yield* nowIso;
      yield* update((state) => ({
        ...state,
        issues: [
          ...state.issues.filter((issue) => issue.key !== key),
          {
            key,
            summary: input.draft.summary,
            type: input.draft.type,
            level: input.draft.type === "Task" ? 0 : -1,
            status: "To Do",
            statusCategory: "new",
            parentKey: input.draft.parentKey,
            assignedToMe: true,
            updatedAt: linkedAt,
            url: state.siteUrl === null ? null : `${state.siteUrl}/browse/${key}`,
          },
        ],
        links: [
          ...state.links.filter((entry) => entry.threadId !== input.threadId || entry.key !== key),
          { threadId: input.threadId, key, linkedAt, source: "created" as const },
        ],
        suggestions: state.suggestions.map((candidate) =>
          candidate.threadId === input.threadId
            ? { ...candidate, state: "dismissed" as const, message: null }
            : candidate,
        ),
      }));
      if (sprintLeft && sprintId != null) {
        yield* moveToSprint(key, sprintId).pipe(
          Effect.catchTags({
            JiraCallError: (error) =>
              noteCreateFailure(
                key,
                `Created ${key}, but it could not join the sprint: ${error.message}`,
              ),
          }),
        );
      }
      const status = input.draft.status;
      if (status !== undefined && status !== "To Do") {
        yield* moveToStatus(key, status).pipe(
          Effect.catchTags({
            JiraCallError: (error) =>
              noteCreateFailure(
                key,
                `Created ${key}, but it could not move to ${status}: ${error.message}`,
              ),
          }),
        );
      }
    }).pipe(
      Effect.catchTags({
        JiraCallError: (error) =>
          putSuggestion({ ...base, draft: input.draft, state: "ready", message: error.message }),
      }),
    );
    yield* fork(work);
  });

  const lastAssistantText = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["assistant"] }).pipe(
      Effect.map(
        (records) =>
          records.messages.findLast((message) => message.text.trim().length > 0)?.text ?? "",
      ),
      Effect.orElseSucceed(() => ""),
    );

  const threadContext = Effect.fn("JiraService.threadContext")(function* (threadId: ThreadId) {
    const records = yield* threads
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError(() => jiraError("Could not read the thread.")));
    const pullRequests = (records.thread.pullRequests ?? [])
      .filter((pr) => pr.source !== "stack-dismissed")
      .map(
        (pr) =>
          `- ${pr.repository}#${pr.number} (${pr.snapshot?.state ?? "open"}): ${
            pr.snapshot?.title ?? ""
          } ${pr.url}`,
      );
    return {
      title: records.thread.title,
      pullRequests,
      pullRequestUrls: (records.thread.pullRequests ?? [])
        .filter((pr) => pr.source !== "stack-dismissed")
        .map((pr) => pr.url),
      lastReply: (yield* lastAssistantText(threadId)).slice(-4_000),
    };
  });

  const draftTicket = Effect.fn("JiraService.draftTicket")(function* (threadId: ThreadId) {
    if ((yield* selection) === null) return yield* jiraError("Jira is off.");
    const issues = (yield* Ref.get(store)).issues;
    const context = yield* threadContext(threadId);
    const first = yield* firstUserMessage(threadId);
    const result = yield* runAgent({
      operation: "jira.draftTicket",
      toolPrefixes: [],
      prompt: buildDraftTicketPrompt({
        title: context.title,
        firstMessage: first?.text ?? "",
        lastReply: context.lastReply,
        issues,
      }),
      outputSchema: DRAFT_OUTPUT_SCHEMA,
    }).pipe(Effect.mapError((error) => jiraError(error.message)));
    return validateFormDraft(result.output, issues);
  });

  const draftChanges = Effect.fn("JiraService.draftChanges")(function* (
    threadId: ThreadId,
    key: string,
    reason: string,
    merged: boolean,
  ) {
    // The ticket is read here, so the model that drafts needs no tools.
    const currentDescription = yield* readIssue(key, ["description"]).pipe(
      Effect.map((reply) => parseIssueDetails(reply, "")?.description ?? ""),
      Effect.mapError((error) => jiraError(error.message)),
    );
    const context = yield* threadContext(threadId);
    const issue = (yield* Ref.get(store)).issues.find((candidate) => candidate.key === key);
    const result = yield* runAgent({
      operation: "jira.draftChanges",
      toolPrefixes: [],
      outputSchema: CHANGES_OUTPUT_SCHEMA,
      prompt: [
        `The ticket's current description:\n${currentDescription.length === 0 ? "(empty)" : currentDescription}`,
        "Draft updates to that ticket from the developer's chat below. Nothing is sent; the developer reviews every change.",
        `- status: one of ${JIRA_STATUSES.join(", ")}, only when the work clearly moved it; otherwise null.`,
        "- comment: a short paragraph (2-4 sentences) for someone who reads the ticket, not the code. Start from the ticket's goal in its description: say what this step did toward it and what is left. Plain prose; no pull request numbers, repository names or URLs. null if there is nothing new.",
        "- links: URLs of the pull requests the comment is about, taken from the list below; [] if none.",
        "- description: a full replacement only when the scope clearly changed; otherwise null.",
        "- currentDescription: the ticket's current description as plain text.",
        "",
        `Why now: ${reason}`,
        `Ticket: ${key}${issue === undefined ? "" : ` (${issue.status}) ${issue.summary}`}`,
        `Chat title: ${context.title}`,
        "Pull requests:",
        context.pullRequests.length === 0 ? "- none" : context.pullRequests.join("\n"),
        "",
        "The chat's latest reply:",
        context.lastReply.length === 0 ? "(none)" : context.lastReply,
      ].join("\n"),
    }).pipe(Effect.mapError((error) => jiraError(error.message)));
    const output = (result.output ?? {}) as Record<string, unknown>;
    const proposed: Array<JiraChange> = [];
    const status = typeof output.status === "string" ? output.status.trim() : "";
    if (status.length > 0 && status !== issue?.status) {
      proposed.push({ kind: "status", to: status });
    } else if (merged && issue !== undefined && issue.statusCategory !== "done") {
      proposed.push({ kind: "status", to: "Done" });
    }
    const comment = typeof output.comment === "string" ? output.comment.trim() : "";
    // Only links to this chat's pull requests, so the model cannot invent one.
    const knownUrls = new Set(context.pullRequestUrls);
    const links = Array.isArray(output.links)
      ? output.links.filter(
          (link): link is string => typeof link === "string" && knownUrls.has(link.trim()),
        )
      : [];
    if (comment.length > 0) {
      proposed.push({
        kind: "comment",
        body: comment,
        ...(links.length > 0 ? { links: [...new Set(links.map((link) => link.trim()))] } : {}),
      });
    }
    const description = typeof output.description === "string" ? output.description.trim() : "";
    if (description.length > 0) {
      proposed.push({
        kind: "description",
        from: typeof output.currentDescription === "string" ? output.currentDescription : "",
        to: description,
      });
    }
    return proposed;
  });

  const proposeChanges: JiraService["Service"]["proposeChanges"] = Effect.fn(
    "JiraService.proposeChanges",
  )(function* (input) {
    if ((yield* selection) === null) return yield* jiraError("Jira is off.");
    const key = input.key.trim().toUpperCase();
    const reason = input.reason ?? "You asked for an update";
    const proposed = yield* draftChanges(input.threadId, key, reason, input.merged === true);
    const createdAt = yield* nowIso;
    const id = `${key}:${createdAt}`;
    yield* update((state) => ({
      ...state,
      // One waiting card per ticket: a newer draft replaces the older one.
      changeSets: [
        ...state.changeSets.filter((set) => !(set.key === key && set.state === "pending")),
        {
          id,
          threadId: input.threadId,
          key,
          createdAt,
          reason,
          changes: proposed,
          state: "pending" as const,
          message: proposed.length === 0 ? "Nothing to update right now." : null,
        },
      ],
    }));
  });

  /** One change through MCP: each is its own tool call, so a failure names the one that broke. */
  const mcpChange = Effect.fn("JiraService.mcpChange")(function* (key: string, change: JiraChange) {
    const cloudId = yield* ensureSite;
    switch (change.kind) {
      case "status": {
        const reply = yield* callTool("jira.transitions", "executeRead", {
          cloudId,
          name: "listJiraIssueTransitions",
          inputs: { issueIdOrKey: key },
        });
        const transitionId = transitionTo(reply, change.to);
        if (transitionId === undefined) {
          return yield* new JiraCallError({
            kind: "failed",
            message: `${key} cannot move to ${change.to} from where it is.`,
          });
        }
        yield* callTool("jira.transition", "transitionJiraIssue", {
          cloudId,
          issueIdOrKey: key,
          transitionId,
        });
        return;
      }
      case "comment":
        yield* callTool("jira.comment", "addOrEditJiraIssueComment", {
          cloudId,
          issueIdOrKey: key,
          commentBody: commentText(change),
        });
        return;
      case "description":
        yield* callTool("jira.editDescription", "editJiraIssue", {
          cloudId,
          issueIdOrKey: key,
          fields: { description: change.to },
        });
        return;
    }
  });

  const cliArgsFor = (key: string, change: JiraChange): ReadonlyArray<string> => {
    switch (change.kind) {
      case "status":
        return ["jira", "workitem", "transition", "--key", key, "--status", change.to, "--yes"];
      case "comment":
        return [
          "jira",
          "workitem",
          "comment",
          "create",
          "--key",
          key,
          "--body",
          commentText(change),
        ];
      case "description":
        return ["jira", "workitem", "edit", "--key", key, "--description", change.to, "--yes"];
    }
  };

  const applyChanges = Effect.fn("JiraService.applyChanges")(function* (
    key: string,
    changesToApply: ReadonlyArray<JiraChange>,
  ) {
    for (const change of changesToApply) {
      yield* viaMcp(mcpChange(key, change), runCli(cliArgsFor(key, change)).pipe(Effect.asVoid));
    }
  });

  const setChangeSet = (id: string, patch: Partial<JiraChangeSet>) =>
    update((state) => ({
      ...state,
      changeSets: state.changeSets.map((set) => (set.id === id ? { ...set, ...patch } : set)),
    }));

  const resolveChanges: JiraService["Service"]["resolveChanges"] = Effect.fn(
    "JiraService.resolveChanges",
  )(function* (input) {
    const set = (yield* Ref.get(store)).changeSets.find((candidate) => candidate.id === input.id);
    if (set === undefined) return yield* jiraError("That change is gone.");
    if (input.action === "dismiss") return yield* setChangeSet(set.id, { state: "dismissed" });
    const chosen = input.changes ?? set.changes;
    if (chosen.length === 0) return yield* setChangeSet(set.id, { state: "dismissed" });
    yield* setChangeSet(set.id, { state: "applying", changes: chosen, message: null });
    yield* fork(
      applyChanges(set.key, chosen).pipe(
        Effect.andThen(setChangeSet(set.id, { state: "applied" })),
        Effect.andThen(sync({}).pipe(Effect.ignore)),
        Effect.catchTags({
          JiraCallError: (error) =>
            setChangeSet(set.id, { state: "failed", message: error.message }),
        }),
      ),
    );
  });

  const moveToStatus = Effect.fn("JiraService.moveToStatus")(function* (
    key: string,
    status: (typeof JIRA_STATUSES)[number],
  ) {
    yield* applyChanges(key, [{ kind: "status", to: status }]);
    const statusCategory =
      status === "Done" ? "done" : status === "To Do" ? "new" : "indeterminate";
    // Shown at once; the sync that follows confirms it against Jira.
    yield* update((state) => ({
      ...state,
      issues: state.issues.map((issue) =>
        issue.key === key ? { ...issue, status, statusCategory } : issue,
      ),
    }));
    yield* fork(sync({}).pipe(Effect.ignore));
  });

  const setStatus = Effect.fn("JiraService.setStatus")(function* (input: {
    readonly key: string;
    readonly status: (typeof JIRA_STATUSES)[number];
  }) {
    if ((yield* selection) === null) return yield* jiraError("Jira is off.");
    yield* moveToStatus(input.key.toUpperCase(), input.status).pipe(
      Effect.mapError((error) => jiraError(error.message)),
    );
  });

  const loadDetails = Effect.fn("JiraService.loadDetails")(function* (input: {
    readonly key: string;
  }) {
    if ((yield* selection) === null) return yield* jiraError("Jira is off.");
    const key = input.key.toUpperCase();
    const details = yield* readIssue(key, JIRA_DETAIL_FIELDS).pipe(
      Effect.flatMap((reply) => Effect.map(nowIso, (at) => parseIssueDetails(reply, at))),
      Effect.mapError((error) => jiraError(error.message)),
    );
    if (details === undefined) return yield* jiraError(`Could not read ${key} from Jira.`);
    yield* update((state) => ({ ...state, details: { ...state.details, [key]: details } }));
  });

  /** Only MCP can move a ticket between sprints; `acli` has no way to. */
  const moveToSprint = Effect.fn("JiraService.moveToSprint")(function* (
    key: string,
    sprintId: number | null,
  ) {
    yield* viaMcp(
      Effect.gen(function* () {
        yield* callTool("jira.setSprint", "transitionJiraIssue", {
          cloudId: yield* ensureSite,
          issueIdOrKey: key,
          ...(sprintId === null ? { assignToBacklog: true } : { sprintId }),
        });
      }),
    );
  });

  const setSprint = Effect.fn("JiraService.setSprint")(function* (input: {
    readonly key: string;
    readonly sprintId: number | null;
  }) {
    if ((yield* selection) === null) return yield* jiraError("Jira is off.");
    const key = input.key.toUpperCase();
    yield* moveToSprint(key, input.sprintId).pipe(
      Effect.mapError((error) => jiraError(error.message)),
    );
    yield* loadDetails({ key });
  });

  /**
   * Runs `acli`'s browser login. Its token is saved as soon as the browser approves, but it can
   * then wait on a site picker, so the login is stopped once `acli` reports it works.
   */
  const cliSignIn = Effect.gen(function* () {
    const login = runner
      .run({ command: "acli", args: ["jira", "auth", "login", "--web"], timeout: "5 minutes" })
      .pipe(Effect.ignore);
    const signedIn = checkCli.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(Duration.seconds(3)),
        until: (state) => state === "ready",
      }),
      Effect.delay(Duration.seconds(3)),
    );
    yield* Effect.raceFirst(login, signedIn);
    if ((yield* checkCli) === "ready") return yield* sync({});
    yield* setSync({ status: "signed-out", message: CLI_SIGNED_OUT_MESSAGE });
  });

  /** Runs `claude mcp login` for the Atlassian MCP server, then syncs through it. */
  const mcpSignIn = Effect.gen(function* () {
    const { agent } = yield* resolveAgent;
    if (agent.signIn === undefined) {
      return yield* new JiraCallError({
        kind: "unavailable",
        message: "This provider cannot sign in to MCP servers.",
      });
    }
    yield* setLogin(signInUrl, null);
    yield* agent
      .signIn({
        name: ATLASSIAN_MCP_NAME,
        url: ATLASSIAN_MCP_URL,
        onUrl: (url) => setLogin(signInUrl, url),
      })
      .pipe(
        Effect.mapError(
          (error) => new JiraCallError({ kind: "signed-out", message: error.detail }),
        ),
        Effect.ensuring(setLogin(signInUrl, null)),
      );
    yield* setLogin(mcp, "unknown");
    yield* Ref.set(mcpSkipUntil, 0);
    yield* sync({});
  });

  /**
   * Signs in to MCP, or to `acli` when the Jira provider cannot run MCP. Starting `claude mcp
   * login` drops the login it replaces, so it only starts once a call has found that login gone.
   */
  const signIn = Effect.fn("JiraService.signIn")(function* () {
    if ((yield* selection) === null) return yield* jiraError("Jira is off.");
    const work = Effect.gen(function* () {
      if ((yield* Ref.get(mcp)) !== "signed-out") {
        yield* callTool("jira.whoAmI", "atlassianUserInfo", {}).pipe(Effect.ignore);
      }
      const state = yield* Ref.get(mcp);
      if (state === "signed-out") return yield* mcpSignIn;
      if (state === "unavailable" && (yield* Ref.get(cli)) !== "missing") return yield* cliSignIn;
      yield* sync({});
    }).pipe(
      Effect.catchTags({
        JiraCallError: (error) => setSync({ status: "signed-out", message: error.message }),
      }),
      // A second click while the browser is open would start a second login.
      signInLock.withPermitsIfAvailable(1),
    );
    yield* fork(work);
  });

  /**
   * Settling a chat whose ticket is still To Do or In Progress offers to move it to Done, as the
   * usual "Jira changes" card plus a toast, since the settled chat leaves the screen. Nothing is
   * sent to Jira until the user applies it.
   */
  const suggestDoneOnSettle: JiraService["Service"]["suggestDoneOnSettle"] = Effect.fn(
    "JiraService.suggestDoneOnSettle",
  )(function* (input) {
    if ((yield* selection) === null) return;
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    if (settings._tag === "Some" && !settings.value.jiraSuggestDoneOnSettle) return;
    const current = yield* Ref.get(store);
    const at = yield* nowIso;
    for (const entry of current.links.filter((link) => link.threadId === input.threadId)) {
      const key = entry.key;
      const issue = current.issues.find((candidate) => candidate.key === key);
      if (issue === undefined || issue.statusCategory === "done") continue;
      const waiting = current.changeSets.find((set) => set.key === key && set.state === "pending");
      if (waiting?.changes.some((change) => change.kind === "status") === true) continue;
      yield* update((state) => ({
        ...state,
        changeSets: [
          ...state.changeSets.filter((set) => set !== waiting),
          {
            id: waiting?.id ?? `${key}:${at}`,
            threadId: input.threadId,
            key,
            createdAt: waiting?.createdAt ?? at,
            reason: waiting?.reason ?? "You settled this chat",
            changes: [...(waiting?.changes ?? []), { kind: "status" as const, to: "Done" }],
            state: "pending" as const,
            message: null,
          },
        ],
        notices: [
          ...state.notices.filter((notice) => notice.key !== key),
          {
            key,
            at,
            summary: `${key} is still ${issue.status}. Mark it Done?`,
            threadId: input.threadId,
          },
        ],
      }));
    }
  });

  const setTicketUpdates: JiraService["Service"]["setTicketUpdates"] = (input) =>
    update((state) => ({
      ...state,
      ticketUpdates: { ...state.ticketUpdates, [input.key.toUpperCase()]: input.updates },
    }));

  const clearNotice: JiraService["Service"]["clearNotice"] = (input) =>
    update((state) => ({
      ...state,
      notices: state.notices.filter((notice) => notice.key !== input.key.toUpperCase()),
    }));

  /**
   * A linked thread that opens or merges a pull request gets a drafted Jira update. The first
   * look at a thread only records what is there, so old pull requests never trigger one.
   */
  const watchPullRequests = Effect.gen(function* () {
    const current = yield* Ref.get(store);
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    // Off by default: an opened pull request is only the start of the work, so only merges draft.
    const updateOnOpen = settings._tag === "Some" && settings.value.jiraUpdateOnPullRequestOpen;
    const threadIds = [...new Set(current.links.map((entry) => entry.threadId))];
    for (const threadId of threadIds) {
      const records = yield* threads.getThreadRecords(threadId, []).pipe(Effect.option);
      if (records._tag === "None") continue;
      const seen = current.pullRequests[threadId];
      const now: Record<string, string> = {};
      const events: Array<string> = [];
      let merged = false;
      for (const pr of records.value.thread.pullRequests ?? []) {
        if (pr.source === "stack-dismissed") continue;
        const id = `${pr.repository}#${pr.number}`;
        const state = pr.snapshot?.state ?? "open";
        now[id] = state;
        if (seen === undefined) continue;
        if (seen[id] === undefined) {
          if (updateOnOpen) events.push(`Pull request ${id} was opened`);
        } else if (seen[id] !== state && state === "merged") {
          events.push(`Pull request ${id} was merged`);
          merged = true;
        }
      }
      if (seen === undefined || encodeJson(seen) !== encodeJson(now)) {
        yield* update((state) => ({
          ...state,
          pullRequests: { ...state.pullRequests, [threadId]: now },
        }));
      }
      if (events.length === 0) continue;
      for (const entry of current.links.filter((candidate) => candidate.threadId === threadId)) {
        yield* fork(
          proposeChanges({ threadId, key: entry.key, reason: events.join("; "), merged }),
        );
      }
    }
  });

  const tick = Effect.gen(function* () {
    if ((yield* selection) === null) return;
    const current = yield* Ref.get(store);
    if (olderThan(current.sync.lastAttemptAt, SYNC_INTERVAL, yield* Clock.currentTimeMillis)) {
      yield* fork(sync({}));
    }
    yield* watchPullRequests;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Jira tick failed.").pipe(Effect.annotateLogs({ cause })),
    ),
  );

  // Found at start, so the snapshot says how to sign in before the first call needs it.
  yield* fork(checkCli);

  yield* tick.pipe(
    Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
    Effect.delay(Duration.seconds(20)),
    Effect.forkIn(scope),
  );

  // Turning Jira on, or pointing it at another provider, syncs right away.
  yield* Effect.gen(function* () {
    const settingsChanges = yield* serverSettings.subscribeChanges;
    let previous: ModelSelection | null = yield* selection;
    yield* settingsChanges.pipe(
      Stream.runForEach((settings) => {
        const next = settings.jiraModelSelection;
        const changed =
          next !== null &&
          (previous === null ||
            previous.instanceId !== next.instanceId ||
            previous.model !== next.model);
        previous = next;
        return changed ? fork(sync({})) : Effect.void;
      }),
    );
  }).pipe(Effect.scoped, Effect.forkIn(scope));

  const command: JiraService["Service"]["command"] = (input) => {
    const done = <E>(effect: Effect.Effect<void, E>) => Effect.as(effect, null);
    switch (input.type) {
      case "sync":
        return done(sync(input));
      case "link":
        return done(link(input));
      case "suggestion":
        return done(suggestion(input));
      case "draftTicket":
        return draftTicket(input.threadId);
      case "createTicket":
        return done(createTicket(input));
      case "proposeChanges":
        return done(proposeChanges(input));
      case "suggestDoneOnSettle":
        return done(suggestDoneOnSettle(input));
      case "resolveChanges":
        return done(resolveChanges(input));
      case "ticketUpdates":
        return done(setTicketUpdates(input));
      case "clearNotice":
        return done(clearNotice(input));
      case "setStatus":
        return done(setStatus(input));
      case "loadDetails":
        return done(loadDetails(input));
      case "setSprint":
        return done(setSprint(input));
      case "signIn":
        return done(signIn());
    }
  };

  return JiraService.of({
    subscribe,
    sync,
    link,
    suggestion,
    createTicket,
    proposeChanges,
    suggestDoneOnSettle,
    resolveChanges,
    setTicketUpdates,
    clearNotice,
    command,
    onFirstMessage,
  });
});

export const layer = Layer.effect(JiraService, make);

export const layerFirstMessageHook = Layer.effect(
  JiraFirstMessageHook,
  Effect.gen(function* () {
    const service = yield* JiraService;
    return service.onFirstMessage;
  }),
);
