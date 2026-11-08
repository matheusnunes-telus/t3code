import {
  type GcpAuthState,
  GcpCloudProject,
  type GcpCommand,
  type GcpCommandResult,
  GcpDelivery,
  type GcpDeployRun,
  type GcpEnvironmentResources,
  GcpError,
  GcpProjectLink,
  type GcpSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  classifyLogin,
  currentJobOf,
  deliverablePullRequests,
  deliveryStage,
  imagesServeCommit,
  parseWorkflowRuns,
  parseClusters,
  parseRunJobs,
  parseRunServices,
  formatTurnContext,
  gcloudCandidates,
  isTerraformCandidate,
  matchCloudProjects,
  nameTokens,
  prodEnvironmentOf,
  suggestEnvironments,
  type WorkflowFile,
} from "./gcpModel.ts";

/** Google's login lasts hours, so a check every few minutes notices expiry soon enough. */
const CHECK_INTERVAL = Duration.minutes(10);

/** Lets turn start ask for a project's Google Cloud context without depending on this service. */
export class GcpTurnContextHook extends Context.Reference<
  ((projectId: string) => Effect.Effect<string | null>) | undefined
>("t3/gcp/GcpTurnContextHook", { defaultValue: () => undefined }) {}

type DeliveryHoldInput = Pick<ProjectionStore.ProjectionThreadPullRequests, "projectId"> & {
  readonly pullRequests?: ProjectionStore.ProjectionThreadPullRequests["pullRequests"] | undefined;
};

/** Lets settling and Jira ask whether a chat still waits for Prod without depending on this service. */
export class GcpDeliveryHook extends Context.Reference<
  ((thread: DeliveryHoldInput) => Effect.Effect<boolean>) | undefined
>("t3/gcp/GcpDeliveryHook", { defaultValue: () => undefined }) {}

export class GcpService extends Context.Service<
  GcpService,
  {
    readonly subscribe: () => Stream.Stream<GcpSnapshot>;
    readonly command: (input: GcpCommand) => Effect.Effect<GcpCommandResult, GcpError>;
    readonly turnContext: (projectId: string) => Effect.Effect<string | null>;
    /** Read from the chat's own pull requests, so it holds from the moment of the merge. */
    readonly holdsForProd: (thread: DeliveryHoldInput) => Effect.Effect<boolean>;
  }
>()("t3/gcp/GcpService") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  links: Schema.Array(GcpProjectLink),
  cloudProjects: Schema.Array(GcpCloudProject),
  /** Saved so a client that starts before the first poll still sees which chats wait. */
  deliveries: Schema.optionalKey(Schema.Array(GcpDelivery)),
});
type StoreFile = typeof StoreFile.Type;
const EMPTY_STORE: StoreFile = { version: 1, links: [], cloudProjects: [] };
const decodeStore = Schema.decodeUnknownOption(Schema.fromJsonString(StoreFile));
const encodeStore = Schema.encodeSync(Schema.fromJsonString(StoreFile));
const encodeDeliveries = Schema.encodeSync(Schema.fromJsonString(Schema.Array(GcpDelivery)));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeProjects = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ projectId: Schema.String, name: Schema.optional(Schema.String) })),
  ),
);

const decodeMergeCommit = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })) }),
  ),
);

const INITIAL_AUTH: GcpAuthState = {
  gcloudPath: null,
  account: null,
  user: "unknown",
  applicationDefault: "unknown",
  checkedAt: null,
  signingIn: false,
  message: null,
};

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scope = yield* Effect.scope;

  const auth = yield* Ref.make<GcpAuthState>(INITIAL_AUTH);
  const storePath = path.join(stateDir, "gcp.json");
  const store = yield* Ref.make<StoreFile>(
    yield* fileSystem.readFileString(storePath).pipe(
      Effect.map((raw) => {
        const decoded = decodeStore(raw);
        return decoded._tag === "Some" ? decoded.value : EMPTY_STORE;
      }),
      Effect.orElseSucceed(() => EMPTY_STORE),
    ),
  );
  const writeLock = yield* Semaphore.make(1);
  // Read on demand and only kept in memory: it is a view of GCP, not something the user chose.
  const resources = yield* Ref.make<Record<string, GcpEnvironmentResources>>({});
  const loading = yield* Ref.make<ReadonlySet<string>>(new Set());
  const deploys = yield* Ref.make<ReadonlyArray<GcpDeployRun>>([]);
  const finishedDeploys = yield* Ref.make<ReadonlyArray<string>>([]);
  // Runs that finished before T3 started are history, not news.
  const startedAt = yield* nowIso;
  const lastDeployPoll = yield* Ref.make(0);
  const changes = yield* PubSub.sliding<void>(1);
  const checkLock = yield* Semaphore.make(1);
  const signInLock = yield* Semaphore.make(1);
  // Whether a run's commit contains a merge never changes, so each pair is asked once.
  const containsCache = new Map<string, boolean>();

  const settings = serverSettings.getSettings.pipe(
    Effect.map((value) => ({
      enabled: value.googleCloudEnabled,
      gcloudPath: value.gcloudPath,
      waitForProd: value.gcpWaitForProd,
    })),
    Effect.orElseSucceed(() => ({ enabled: true, gcloudPath: "", waitForProd: true })),
  );

  const setAuth = (patch: Partial<GcpAuthState>) =>
    Ref.update(auth, (current) => ({ ...current, ...patch })).pipe(
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.asVoid,
    );

  const updateStore = (mutate: (current: StoreFile) => StoreFile) =>
    Ref.update(store, mutate).pipe(
      Effect.andThen(
        writeLock.withPermits(1)(
          Effect.gen(function* () {
            const temp = `${storePath}.tmp`;
            yield* fileSystem.writeFileString(temp, encodeStore(yield* Ref.get(store)));
            yield* fileSystem.rename(temp, storePath);
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not save Google Cloud links.").pipe(
                Effect.annotateLogs({ cause }),
              ),
            ),
          ),
        ),
      ),
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.asVoid,
    );

  const fork = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Google Cloud background work failed.").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const findGcloud = Effect.gen(function* () {
    const { gcloudPath } = yield* settings;
    const systemPath = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => ""));
    const candidates = gcloudCandidates({
      configuredPath: gcloudPath,
      pathEntries: systemPath.split(process.platform === "win32" ? ";" : ":"),
      home: NodeOS.homedir(),
      platform: process.platform,
    });
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return null;
  });

  const run = (
    gcloud: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input,
    cwd?: string,
  ) =>
    runner.run({ command: gcloud, args, timeout, ...(cwd === undefined ? {} : { cwd }) }).pipe(
      Effect.map((output) => ({
        exitCode: output.code === null ? null : Number(output.code),
        stdout: output.stdout,
        stderr: output.stderr,
      })),
      Effect.orElseSucceed(() => ({
        exitCode: null,
        stdout: "",
        stderr: "gcloud did not answer in time.",
      })),
    );

  const checkLogin = checkLock.withPermits(1)(
    Effect.gen(function* () {
      if (!(yield* settings).enabled) return;
      yield* setAuth({ user: "checking", applicationDefault: "checking" });
      const gcloud = yield* findGcloud;
      const checkedAt = yield* nowIso;
      if (gcloud === null) {
        return yield* setAuth({
          gcloudPath: null,
          account: null,
          user: "missing",
          applicationDefault: "missing",
          checkedAt,
          message: "gcloud isn't installed, or isn't where T3 looks. Set its path in Settings.",
        });
      }
      const [user, applicationDefault, account] = yield* Effect.all(
        [
          run(gcloud, ["auth", "print-access-token", "--quiet"], "30 seconds"),
          run(
            gcloud,
            ["auth", "application-default", "print-access-token", "--quiet"],
            "30 seconds",
          ),
          run(gcloud, ["config", "get-value", "account", "--quiet"], "15 seconds"),
        ],
        { concurrency: "unbounded" },
      );
      const userLogin = classifyLogin(user);
      const defaultLogin = classifyLogin(applicationDefault);
      const accountName = account.exitCode === 0 ? account.stdout.trim() : "";
      yield* setAuth({
        gcloudPath: gcloud,
        account: accountName.length > 0 ? accountName : null,
        user: userLogin.status,
        applicationDefault: defaultLogin.status,
        checkedAt,
        message: userLogin.message ?? defaultLogin.message,
      });
      if (userLogin.status === "ok" && (yield* Ref.get(store)).cloudProjects.length === 0) {
        yield* fork(listProjects);
      }
    }),
  );

  /**
   * gcloud's browser sign-in. `--update-adc` renews the default credentials in the same flow,
   * so one approval fixes both logins.
   */
  const signIn = Effect.gen(function* () {
    if (!(yield* settings).enabled) return yield* new GcpError({ message: "Google Cloud is off." });
    const gcloud = yield* findGcloud;
    if (gcloud === null) {
      return yield* new GcpError({ message: "gcloud isn't installed, or T3 can't find it." });
    }
    yield* fork(
      Effect.gen(function* () {
        yield* setAuth({ signingIn: true });
        yield* run(gcloud, ["auth", "login", "--update-adc", "--quiet"], "10 minutes");
        yield* setAuth({ signingIn: false });
        yield* checkLogin;
      }).pipe(
        Effect.ensuring(Ref.update(auth, (current) => ({ ...current, signingIn: false }))),
        // A second click while the browser is open would start a second login.
        signInLock.withPermitsIfAvailable(1),
      ),
    );
  });

  const listProjects = Effect.gen(function* () {
    const gcloud = yield* findGcloud;
    if (gcloud === null) {
      return yield* new GcpError({ message: "gcloud isn't installed, or T3 can't find it." });
    }
    const output = yield* run(
      gcloud,
      ["projects", "list", "--format=json(projectId,name)", "--quiet"],
      "90 seconds",
    );
    const decoded = output.exitCode === 0 ? decodeProjects(output.stdout) : undefined;
    if (decoded === undefined || decoded._tag === "None") {
      return yield* new GcpError({
        message: classifyLogin(output).message ?? "gcloud could not list your projects.",
      });
    }
    const cloudProjects = decoded.value
      .map((project) => ({ projectId: project.projectId, name: project.name ?? project.projectId }))
      .toSorted((a, b) => a.projectId.localeCompare(b.projectId));
    yield* updateStore((current) => ({ ...current, cloudProjects }));
    return cloudProjects;
  });

  const readWorkflows = Effect.fn("GcpService.readWorkflows")(function* (root: string) {
    const folder = path.join(root, ".github", "workflows");
    const names = yield* fileSystem.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
    const files: Array<WorkflowFile> = [];
    for (const name of names.filter((entry) => /\.ya?ml$/.test(entry))) {
      const content = yield* fileSystem
        .readFileString(path.join(folder, name))
        .pipe(Effect.orElseSucceed(() => ""));
      files.push({ path: `.github/workflows/${name}`, content });
    }
    return files;
  });

  const hasTerraformFiles = Effect.fn("GcpService.hasTerraformFiles")(function* (folder: string) {
    const entries = yield* fileSystem.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
    if (entries.some((entry) => entry.endsWith(".tf"))) return true;
    // Terraform repos often keep their files one level down, per environment or module.
    for (const entry of entries.filter((name) => !name.startsWith(".")).slice(0, 40)) {
      const inner = yield* fileSystem
        .readDirectory(path.join(folder, entry))
        .pipe(Effect.orElseSucceed(() => []));
      if (inner.some((name) => name.endsWith(".tf"))) return true;
    }
    return false;
  });

  /** Folders next to the project that hold Terraform and share a word with its name. */
  const findTerraformRepos = Effect.fn("GcpService.findTerraformRepos")(function* (
    root: string,
    tokens: ReadonlyArray<string>,
  ) {
    const parent = path.dirname(root);
    const entries = yield* fileSystem.readDirectory(parent).pipe(Effect.orElseSucceed(() => []));
    const found: Array<string> = [];
    for (const entry of entries) {
      const folder = path.join(parent, entry);
      if (folder === root || !nameTokens(entry).some((token) => tokens.includes(token))) continue;
      const terraform = yield* hasTerraformFiles(folder);
      if (isTerraformCandidate({ folderName: entry, tokens, hasTerraformFiles: terraform })) {
        found.push(folder);
      }
    }
    return found;
  });

  const suggestLink = Effect.fn("GcpService.suggestLink")(function* (
    input: Extract<GcpCommand, { type: "suggestLink" }>,
  ) {
    const cached = (yield* Ref.get(store)).cloudProjects;
    const cloudProjects = cached.length > 0 ? cached : yield* listProjects;
    const tokens = nameTokens(input.title, path.basename(input.workspaceRoot));
    const workflows = yield* readWorkflows(input.workspaceRoot);
    const named = workflows.flatMap((file) =>
      cloudProjects.filter((project) => file.content.includes(project.projectId)),
    );
    // Projects a deploy workflow names count even when the names share no word.
    const matched = [
      ...new Map(
        [...matchCloudProjects(tokens, cloudProjects), ...named].map((project) => [
          project.projectId,
          project,
        ]),
      ).values(),
    ];
    return {
      key: input.key,
      title: input.title,
      projectIds: input.projectIds,
      workspaceRoot: input.workspaceRoot,
      environments: suggestEnvironments({ projects: matched, workflows }),
      terraformRepos: yield* findTerraformRepos(input.workspaceRoot, tokens),
    } satisfies GcpProjectLink;
  });

  const currentSnapshot = Effect.gen(function* () {
    const { enabled, waitForProd } = yield* settings;
    const current = yield* Ref.get(store);
    return {
      enabled,
      auth: yield* Ref.get(auth),
      links: current.links,
      cloudProjects: current.cloudProjects,
      resources: yield* Ref.get(resources),
      deploys: yield* Ref.get(deploys),
      finishedDeploys: yield* Ref.get(finishedDeploys),
      deliveries: enabled && waitForProd ? (current.deliveries ?? []) : [],
      loading: [...(yield* Ref.get(loading))],
    } satisfies GcpSnapshot;
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

  yield* Effect.suspend(() => pollDeploys(false)).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Google Cloud deploy poll failed.").pipe(Effect.annotateLogs({ cause })),
    ),
    Effect.repeat(Schedule.spaced(Duration.seconds(30))),
    Effect.delay(Duration.seconds(15)),
    Effect.forkIn(scope),
  );

  yield* checkLogin.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Google Cloud login check failed.").pipe(Effect.annotateLogs({ cause })),
    ),
    Effect.repeat(Schedule.spaced(CHECK_INTERVAL)),
    Effect.delay(Duration.seconds(5)),
    Effect.forkIn(scope),
  );

  // Turning it on, or pointing it at another gcloud, checks right away.
  yield* Effect.gen(function* () {
    const settingsChanges = yield* serverSettings.subscribeChanges;
    let previous = yield* settings;
    yield* settingsChanges.pipe(
      Stream.runForEach((next) => {
        const changed =
          next.googleCloudEnabled !== previous.enabled || next.gcloudPath !== previous.gcloudPath;
        previous = {
          enabled: next.googleCloudEnabled,
          gcloudPath: next.gcloudPath,
          waitForProd: next.gcpWaitForProd,
        };
        return changed && next.googleCloudEnabled ? fork(checkLogin) : Effect.void;
      }),
    );
  }).pipe(Effect.scoped, Effect.forkIn(scope));

  const command: GcpService["Service"]["command"] = (input) => {
    switch (input.type) {
      case "checkLogin":
        return Effect.as(checkLogin, null);
      case "signIn":
        return Effect.as(signIn, null);
      case "listProjects":
        return Effect.as(listProjects, null);
      case "suggestLink":
        return suggestLink(input);
      case "saveLink":
        return Effect.as(
          updateStore((current) => ({
            ...current,
            links: [...current.links.filter((link) => link.key !== input.link.key), input.link],
          })),
          null,
        );
      case "refreshDeploys":
        return Effect.as(pollDeploys(true), null);
      case "clearFinishedDeploys":
        return Effect.as(
          Ref.update(finishedDeploys, (current) =>
            current.filter((id) => !input.ids.includes(id)),
          ).pipe(Effect.andThen(PubSub.publish(changes, undefined))),
          null,
        );
      case "loadResources":
        return Effect.as(loadResources(input.projectId), null);
      case "removeLink":
        return Effect.as(
          updateStore((current) => ({
            ...current,
            links: current.links.filter((link) => link.key !== input.key),
          })),
          null,
        );
    }
  };

  const loadResources = Effect.fn("GcpService.loadResources")(function* (projectId: string) {
    const gcloud = yield* findGcloud;
    if (gcloud === null) {
      return yield* new GcpError({ message: "gcloud isn't installed, or T3 can't find it." });
    }
    const usesGke = (yield* Ref.get(store)).links.some((link) =>
      link.environments.some(
        (environment) => environment.projectId === projectId && environment.runtime === "gke",
      ),
    );
    const mark = (on: boolean) =>
      Ref.update(loading, (current) => {
        const next = new Set(current);
        if (on) next.add(projectId);
        else next.delete(projectId);
        return next;
      }).pipe(Effect.andThen(PubSub.publish(changes, undefined)));
    yield* mark(true);
    const list = (args: ReadonlyArray<string>) =>
      run(gcloud, [...args, `--project=${projectId}`, "--format=json", "--quiet"], "90 seconds");
    const [services, jobs, clusters] = yield* Effect.all(
      [
        list(["run", "services", "list"]),
        list(["run", "jobs", "list"]),
        usesGke
          ? list(["container", "clusters", "list"])
          : Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.ensuring(mark(false)));
    const parsed = (output: { exitCode: number | null; stdout: string }) => {
      if (output.exitCode !== 0) return null;
      const decoded = decodeJson(output.stdout);
      return decoded._tag === "Some" ? decoded.value : null;
    };
    const failure = [services, jobs, clusters].find((output) => output.exitCode !== 0);
    const next: GcpEnvironmentResources = {
      projectId,
      fetchedAt: yield* nowIso,
      services: parseRunServices(parsed(services)),
      jobs: parseRunJobs(parsed(jobs)),
      clusters: parseClusters(parsed(clusters)),
      message: failure === undefined ? null : classifyLogin(failure).message,
    };
    yield* Ref.update(resources, (current) => ({ ...current, [projectId]: next }));
    yield* PubSub.publish(changes, undefined);
  });

  const findGh = Effect.gen(function* () {
    const systemPath = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => ""));
    const entries = systemPath.split(process.platform === "win32" ? ";" : ":");
    const binary = process.platform === "win32" ? "gh.exe" : "gh";
    const candidates = [
      ...entries.filter((entry) => entry.length > 0),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
    ].map((dir) => `${dir.replace(/[\\/]+$/, "")}/${binary}`);
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return null;
  });

  /** After a successful run, checks that the environment's services or jobs run its commit. */
  const verifyDeploy = Effect.fn("GcpService.verifyDeploy")(function* (
    deployRun: GcpDeployRun,
    projectId: string,
  ) {
    yield* loadResources(projectId).pipe(Effect.ignore);
    const read = (yield* Ref.get(resources))[projectId];
    if (read === undefined) return null;
    return imagesServeCommit(
      [...read.services.map((service) => service.image), ...read.jobs.map((job) => job.image)],
      deployRun.headSha,
    );
  });

  /**
   * Follows each linked environment's deploy workflow on GitHub. Often while a run is active,
   * rarely otherwise; a run that finishes is queued once for the client to announce.
   */
  const pollDeploys = Effect.fn("GcpService.pollDeploys")(function* (force: boolean) {
    if (!(yield* settings).enabled) return;
    const targets = (yield* Ref.get(store)).links.flatMap((link) =>
      link.environments.flatMap((environment) =>
        environment.deployWorkflow === null
          ? []
          : [
              {
                key: link.key,
                environment: environment.name,
                projectId: environment.projectId,
                runtime: environment.runtime,
                workflow: environment.deployWorkflow,
                root: link.workspaceRoot,
              },
            ],
      ),
    );
    if (targets.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const active = (yield* Ref.get(deploys)).some((entry) => entry.status !== "completed");
    if (!force && !active && now - (yield* Ref.get(lastDeployPoll)) < 120_000) return;
    yield* Ref.set(lastDeployPoll, now);
    const gh = yield* findGh;
    if (gh === null) return;
    const previous = new Map((yield* Ref.get(deploys)).map((entry) => [entry.id, entry]));
    const next: Array<GcpDeployRun> = [];
    const finished: Array<{
      readonly run: GcpDeployRun;
      readonly projectId: string;
      readonly runtime: string;
    }> = [];
    for (const target of targets) {
      const listed = yield* run(
        gh,
        [
          "run",
          "list",
          "--workflow",
          target.workflow.split("/").at(-1) ?? target.workflow,
          "--limit",
          "5",
          "--json",
          "databaseId,number,status,conclusion,url,headSha,createdAt,updatedAt,displayTitle",
        ],
        "30 seconds",
        target.root,
      );
      if (listed.exitCode !== 0) continue;
      const decoded = decodeJson(listed.stdout);
      if (decoded._tag === "None") continue;
      for (const entry of parseWorkflowRuns(decoded.value, target)) {
        const before = previous.get(entry.id);
        let currentJob: string | null = null;
        if (entry.status !== "completed") {
          const viewed = yield* run(
            gh,
            ["run", "view", entry.id, "--json", "jobs"],
            "30 seconds",
            target.root,
          );
          const jobs = viewed.exitCode === 0 ? decodeJson(viewed.stdout) : undefined;
          currentJob = jobs !== undefined && jobs._tag === "Some" ? currentJobOf(jobs.value) : null;
        }
        const merged = { ...entry, currentJob, verified: before?.verified ?? null };
        const justFinished =
          entry.status === "completed" &&
          (before === undefined ? entry.createdAt > startedAt : before.status !== "completed");
        if (justFinished)
          finished.push({ run: merged, projectId: target.projectId, runtime: target.runtime });
        next.push(merged);
      }
    }
    const recent = next.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
    yield* Ref.set(deploys, recent);
    yield* trackDeliveries(gh, next);
    if (finished.length > 0) {
      yield* Ref.update(finishedDeploys, (current) => [
        ...current,
        ...finished.map((entry) => entry.run.id),
      ]);
    }
    yield* PubSub.publish(changes, undefined);
    for (const entry of finished) {
      if (entry.run.conclusion !== "success" || entry.runtime === "gke") continue;
      const verified = yield* verifyDeploy(entry.run, entry.projectId);
      yield* Ref.update(deploys, (current) =>
        current.map((candidate) =>
          candidate.id === entry.run.id ? { ...candidate, verified } : candidate,
        ),
      );
      yield* PubSub.publish(changes, undefined);
    }
  });

  const mergeCommitOf = Effect.fn("GcpService.mergeCommitOf")(function* (
    gh: string,
    repository: string,
    number: number,
  ) {
    const viewed = yield* run(
      gh,
      ["pr", "view", String(number), "--repo", repository, "--json", "mergeCommit"],
      "30 seconds",
    );
    const decoded = viewed.exitCode === 0 ? decodeMergeCommit(viewed.stdout) : undefined;
    return decoded !== undefined && decoded._tag === "Some"
      ? (decoded.value.mergeCommit?.oid ?? null)
      : null;
  });

  /** A run started before the merge can't contain it, so most runs cost no GitHub call. */
  const runContains = Effect.fn("GcpService.runContains")(function* (
    gh: string,
    repository: string,
    delivery: { readonly commit: string; readonly mergedAt: string },
    deployRun: GcpDeployRun,
  ) {
    if (deployRun.headSha === delivery.commit) return true;
    if (Date.parse(deployRun.createdAt) < Date.parse(delivery.mergedAt)) return false;
    const key = `${repository}:${delivery.commit}:${deployRun.headSha}`;
    const known = containsCache.get(key);
    if (known !== undefined) return known;
    const compared = yield* run(
      gh,
      [
        "api",
        `repos/${repository}/compare/${delivery.commit}...${deployRun.headSha}`,
        "--jq",
        ".status",
      ],
      "30 seconds",
    );
    if (compared.exitCode !== 0) return false;
    const status = compared.stdout.trim();
    const contains = status === "ahead" || status === "identical";
    containsCache.set(key, contains);
    return contains;
  });

  /** Rebuilds the waiting list from unsettled chats, so settling a chat is what ends its wait. */
  const trackDeliveries = Effect.fn("GcpService.trackDeliveries")(function* (
    gh: string,
    runs: ReadonlyArray<GcpDeployRun>,
  ) {
    const current = yield* Ref.get(store);
    const saved = current.deliveries ?? [];
    const next: Array<GcpDelivery> = [];
    if ((yield* settings).waitForProd) {
      const threads = yield* projections
        .getThreadsWithPullRequests()
        .pipe(Effect.orElseSucceed(() => null));
      // Keeps the list as it is rather than emptying it on a failed read.
      if (threads === null) return;
      const known = new Map(
        saved.map((entry) => [`${entry.threadId}:${entry.repository}#${entry.number}`, entry]),
      );
      for (const thread of threads) {
        if (thread.settledOverride === "settled" || thread.settledAt !== null) continue;
        if (thread.lineage.parentThreadId !== null) continue;
        const link = current.links.find((entry) => entry.projectIds.includes(thread.projectId));
        const prod = link === undefined ? null : prodEnvironmentOf(link);
        if (link === undefined || prod === null) continue;
        const test = link.environments.find(
          (entry) => entry.deployWorkflow !== null && entry.name !== prod.name,
        );
        const merged = deliverablePullRequests(
          link,
          visibleThreadPullRequests(thread.pullRequests ?? []),
        );
        for (const pullRequest of merged) {
          const snapshot = pullRequest.snapshot;
          if (snapshot === null || snapshot.mergedAt == null) continue;
          const mergedAt = snapshot.mergedAt;
          const { repository, number } = pullRequest;
          const commit =
            known.get(`${thread.id}:${repository}#${number}`)?.commit ??
            (yield* mergeCommitOf(gh, repository, number));
          const containing = (environment: string | undefined) =>
            commit === null || environment === undefined
              ? Effect.succeed<ReadonlyArray<GcpDeployRun>>([])
              : Effect.filter(
                  runs.filter(
                    (entry) => entry.key === link.key && entry.environment === environment,
                  ),
                  (entry) => runContains(gh, repository, { commit, mergedAt }, entry),
                );
          const { stage, run: stageRun } = deliveryStage({
            testRuns: yield* containing(test?.name),
            prodRuns: yield* containing(prod.name),
          });
          next.push({
            threadId: thread.id,
            key: link.key,
            title: snapshot.title,
            repository,
            number,
            url: pullRequest.url,
            mergedAt,
            commit,
            stage,
            testEnvironment: test?.name ?? null,
            prodEnvironment: prod.name,
            run:
              stageRun === null
                ? null
                : {
                    url: stageRun.url,
                    label: `${stageRun.workflow.split("/").at(-1) ?? stageRun.workflow}${stageRun.number === null ? "" : ` #${stageRun.number}`}`,
                    headSha: stageRun.headSha,
                    status: stageRun.status,
                  },
          });
        }
      }
    }
    if (encodeDeliveries(next) === encodeDeliveries(saved)) return;
    yield* updateStore((value) => ({ ...value, deliveries: next }));
  });

  const holdsForProd: GcpService["Service"]["holdsForProd"] = Effect.fn("GcpService.holdsForProd")(
    function* (thread) {
      const { enabled, waitForProd } = yield* settings;
      if (!enabled || !waitForProd) return false;
      const link = (yield* Ref.get(store)).links.find((entry) =>
        entry.projectIds.includes(thread.projectId),
      );
      if (link === undefined) return false;
      return (
        deliverablePullRequests(link, visibleThreadPullRequests(thread.pullRequests ?? [])).length >
        0
      );
    },
  );

  const turnContext = Effect.fn("GcpService.turnContext")(function* (projectId: string) {
    if (!(yield* settings).enabled) return null;
    const link = (yield* Ref.get(store)).links.find((entry) =>
      entry.projectIds.includes(projectId),
    );
    if (link === undefined) return null;
    const current = yield* Ref.get(auth);
    return formatTurnContext({ link, gcloudPath: current.gcloudPath, account: current.account });
  });

  return GcpService.of({ subscribe, command, turnContext, holdsForProd });
});

export const layer = Layer.effect(GcpService, make);

export const layerDeliveryHook = Layer.effect(
  GcpDeliveryHook,
  Effect.gen(function* () {
    const service = yield* GcpService;
    return service.holdsForProd;
  }),
);

export const layerTurnContextHook = Layer.effect(
  GcpTurnContextHook,
  Effect.gen(function* () {
    const service = yield* GcpService;
    return service.turnContext;
  }),
);
