import {
  type JiraChange,
  type JiraChangeSet,
  type JiraCommand,
  type JiraIssue,
  JiraError,
  JiraIssue as JiraIssueSchema,
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
  type ThreadId,
} from "@t3tools/contracts";
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
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildMatchPrompt,
  CHANGES_OUTPUT_SCHEMA,
  JIRA_SEARCH_FIELDS,
  JIRA_STATUSES,
  keysMentioned,
  looksSignedOut,
  MATCH_OUTPUT_SCHEMA,
  mergeSync,
  missingAncestors,
  parseAccessibleSite,
  parseIssueSearch,
  validateMatch,
} from "./jiraModel.ts";

/** Server names the claude.ai Atlassian connector has gone by; any of them may run. */
const ATLASSIAN_TOOL_PREFIXES = ["mcp__claude_ai_Atlassian", "mcp__atlassian", "mcp__Atlassian"];
const SYNC_INTERVAL = Duration.hours(1);
const FULL_SYNC_INTERVAL = Duration.hours(24);
const TICK_INTERVAL = Duration.minutes(5);
const MAX_SEARCH_RESULTS = 100;

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

/** Why a connector call failed, so sync status can say "signed out" rather than "failed". */
class JiraCallError extends Data.TaggedError("JiraCallError")<{
  readonly kind: "signed-out" | "unavailable" | "failed";
  readonly message: string;
}> {}

export interface JiraFirstMessage {
  readonly threadId: ThreadId;
  readonly message: string;
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
      readonly threadId: ThreadId;
      readonly key: string;
      readonly reason?: string | undefined;
    }) => Effect.Effect<void, JiraError>;
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
    readonly command: (input: JiraCommand) => Effect.Effect<void, JiraError>;
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

  const snapshotOf = (current: StoreFile, settings: ServerSettingsValue | null): JiraSnapshot => {
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
    };
  };

  const currentSnapshot = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    return snapshotOf(yield* Ref.get(store), settings);
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
        message:
          "This provider cannot reach Jira. Pick a Claude provider whose account has the Atlassian connector.",
      });
    }
    return { agent: instance.connectorAgent, modelSelection };
  });

  const runAgent = Effect.fn("JiraService.runAgent")(function* (
    request: Omit<Parameters<ConnectorAgent["run"]>[0], "modelSelection">,
  ) {
    const { agent, modelSelection } = yield* resolveAgent;
    return yield* agent.run({ ...request, modelSelection }).pipe(
      Effect.mapError(
        (error) =>
          new JiraCallError({
            kind: looksSignedOut(error.detail) ? "signed-out" : "failed",
            message: error.detail,
          }),
      ),
    );
  });

  /** Tells "the connector isn't there" and "it lost its login" apart from a plain failure. */
  const connectorProblem = (result: ConnectorAgentResult) => {
    const hasTools = result.availableTools.some((tool) =>
      ATLASSIAN_TOOL_PREFIXES.some((prefix) => tool.startsWith(`${prefix}__`)),
    );
    if (hasTools) return undefined;
    const server = result.mcpServers.find((candidate) => /atlassian/i.test(candidate.name));
    if (server !== undefined && server.status !== "connected") {
      return new JiraCallError({
        kind: "signed-out",
        message: `The Atlassian connector is ${server.status}. Reconnect it in your claude.ai connector settings.`,
      });
    }
    return new JiraCallError({
      kind: "unavailable",
      message:
        "This provider's account has no Atlassian connector. Connect Atlassian in claude.ai, or pick another provider.",
    });
  };

  /** One connector tool call. The model only places the call; its reply is read here, raw. */
  const callTool = Effect.fn("JiraService.callTool")(function* (
    operation: string,
    tool: string,
    args: Record<string, unknown>,
  ) {
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
        kind: "failed",
        message: `The agent did not call ${tool}.`,
      });
    }
    if (reply.isError) {
      return yield* new JiraCallError({
        kind: looksSignedOut(reply.text) ? "signed-out" : "failed",
        message: reply.text.slice(0, 500),
      });
    }
    return reply.text;
  });

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

  const search = Effect.fn("JiraService.search")(function* (
    cloudId: string,
    jql: string,
    mine: boolean,
  ) {
    const reply = yield* callTool("jira.search", "searchJiraIssuesUsingJql", {
      cloudId,
      jql,
      fields: JIRA_SEARCH_FIELDS,
      maxResults: MAX_SEARCH_RESULTS,
    });
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

  const setSync = (patch: Partial<StoreFile["sync"]>) =>
    update((state) => ({ ...state, sync: { ...state.sync, ...patch } }));

  const runSync = Effect.fn("JiraService.runSync")(
    function* (full: boolean) {
      const startedAt = yield* nowIso;
      yield* setSync({ status: "syncing", lastAttemptAt: startedAt, message: null });
      const cloudId = yield* ensureSite;
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
      const own = yield* search(cloudId, jql, true);

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
        const fetched = yield* search(cloudId, `key in (${wanted.join(",")})`, false);
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
    const current = yield* Ref.get(store);
    if (current.issues.length === 0) return;
    if (
      findSuggestion(current, input.threadId) !== undefined ||
      current.links.some((link) => link.threadId === input.threadId)
    ) {
      return;
    }
    yield* fork(runMatch(input.threadId, input.message));
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
      const cloudId = yield* ensureSite;
      const accountId = yield* ensureAccountId.pipe(Effect.orElseSucceed(() => null));
      const projectKey = input.draft.parentKey.split("-")[0] ?? input.draft.parentKey;
      const reply = yield* callTool("jira.createIssue", "createJiraIssue", {
        cloudId,
        projectKey,
        issueTypeName: input.draft.type,
        summary: input.draft.summary,
        description: input.draft.description,
        parent: input.draft.parentKey,
        ...(accountId === null ? {} : { assignee_account_id: accountId }),
      });
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
      lastReply: (yield* lastAssistantText(threadId)).slice(-4_000),
    };
  });

  const draftChanges = Effect.fn("JiraService.draftChanges")(function* (
    threadId: ThreadId,
    key: string,
    reason: string,
  ) {
    const cloudId = yield* ensureSite.pipe(Effect.mapError((error) => jiraError(error.message)));
    const context = yield* threadContext(threadId);
    const issue = (yield* Ref.get(store)).issues.find((candidate) => candidate.key === key);
    const result = yield* runAgent({
      operation: "jira.draftChanges",
      toolPrefixes: ATLASSIAN_TOOL_PREFIXES,
      outputSchema: CHANGES_OUTPUT_SCHEMA,
      prompt: [
        `First call the Atlassian tool getJiraIssue once with ${encodeJson({ cloudId, issueIdOrKey: key, fields: ["summary", "status", "description"] })}. Call no other tool.`,
        "Then draft updates to that ticket from the developer's chat below. Nothing is sent; the developer reviews every change.",
        `- status: one of ${JIRA_STATUSES.join(", ")}, only when the work clearly moved it; otherwise null.`,
        "- comment: 1-3 plain sentences on what changed, with pull request links when there are any; null if there is nothing new.",
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
    if (status.length > 0 && status !== issue?.status)
      proposed.push({ kind: "status", to: status });
    const comment = typeof output.comment === "string" ? output.comment.trim() : "";
    if (comment.length > 0) proposed.push({ kind: "comment", body: comment });
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
    const proposed = yield* draftChanges(input.threadId, key, reason);
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

  const describeChange = (change: JiraChange) => {
    switch (change.kind) {
      case "status":
        return `Move it to the status "${change.to}": call getTransitionsForJiraIssue, then transitionJiraIssue with the transition that leads to that status.`;
      case "comment":
        return `Add this comment with addCommentToJiraIssue:\n${change.body}`;
      case "description":
        return `Replace its description with editJiraIssue, setting fields.description to:\n${change.to}`;
    }
  };

  const applyChanges = Effect.fn("JiraService.applyChanges")(function* (
    set: JiraChangeSet,
    changesToApply: ReadonlyArray<JiraChange>,
  ) {
    const cloudId = yield* ensureSite;
    const result = yield* runAgent({
      operation: "jira.applyChanges",
      toolPrefixes: ATLASSIAN_TOOL_PREFIXES,
      prompt: [
        `Apply exactly these changes to Jira issue ${set.key} (cloudId ${cloudId}), in order, with the Atlassian tools. Do nothing else.`,
        ...changesToApply.map((change, index) => `${index + 1}. ${describeChange(change)}`),
        "Reply with done, or with what failed.",
      ].join("\n\n"),
    });
    const problem = connectorProblem(result);
    if (problem !== undefined) return yield* problem;
    const failed = result.toolResults.find((entry) => entry.isError);
    if (failed !== undefined) {
      return yield* new JiraCallError({
        kind: looksSignedOut(failed.text) ? "signed-out" : "failed",
        message: failed.text.slice(0, 500),
      });
    }
    if (result.toolResults.length === 0) {
      return yield* new JiraCallError({ kind: "failed", message: "No change was made." });
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
      applyChanges(set, chosen).pipe(
        Effect.andThen(setChangeSet(set.id, { state: "applied" })),
        Effect.andThen(sync({}).pipe(Effect.ignore)),
        Effect.catchTags({
          JiraCallError: (error) =>
            setChangeSet(set.id, { state: "failed", message: error.message }),
        }),
      ),
    );
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
    const threadIds = [...new Set(current.links.map((entry) => entry.threadId))];
    for (const threadId of threadIds) {
      const records = yield* threads.getThreadRecords(threadId, []).pipe(Effect.option);
      if (records._tag === "None") continue;
      const seen = current.pullRequests[threadId];
      const now: Record<string, string> = {};
      const events: Array<string> = [];
      for (const pr of records.value.thread.pullRequests ?? []) {
        if (pr.source === "stack-dismissed") continue;
        const id = `${pr.repository}#${pr.number}`;
        const state = pr.snapshot?.state ?? "open";
        now[id] = state;
        if (seen === undefined) continue;
        if (seen[id] === undefined) events.push(`Pull request ${id} was opened`);
        else if (seen[id] !== state && state === "merged") {
          events.push(`Pull request ${id} was merged`);
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
        yield* fork(proposeChanges({ threadId, key: entry.key, reason: events.join("; ") }));
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
    switch (input.type) {
      case "sync":
        return sync(input);
      case "link":
        return link(input);
      case "suggestion":
        return suggestion(input);
      case "createTicket":
        return createTicket(input);
      case "proposeChanges":
        return proposeChanges(input);
      case "resolveChanges":
        return resolveChanges(input);
      case "ticketUpdates":
        return setTicketUpdates(input);
      case "clearNotice":
        return clearNotice(input);
    }
  };

  return JiraService.of({
    subscribe,
    sync,
    link,
    suggestion,
    createTicket,
    proposeChanges,
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
