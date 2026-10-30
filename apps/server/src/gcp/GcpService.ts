import {
  type GcpAuthState,
  GcpCloudProject,
  type GcpCommand,
  type GcpCommandResult,
  type GcpEnvironmentResources,
  GcpError,
  GcpProjectLink,
  type GcpSnapshot,
} from "@t3tools/contracts";
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
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  classifyLogin,
  parseClusters,
  parseRunJobs,
  parseRunServices,
  formatTurnContext,
  gcloudCandidates,
  isTerraformCandidate,
  matchCloudProjects,
  nameTokens,
  suggestEnvironments,
  type WorkflowFile,
} from "./gcpModel.ts";

/** Google's login lasts hours, so a check every few minutes notices expiry soon enough. */
const CHECK_INTERVAL = Duration.minutes(10);

/** Lets turn start ask for a project's Google Cloud context without depending on this service. */
export class GcpTurnContextHook extends Context.Reference<
  ((projectId: string) => Effect.Effect<string | null>) | undefined
>("t3/gcp/GcpTurnContextHook", { defaultValue: () => undefined }) {}

export class GcpService extends Context.Service<
  GcpService,
  {
    readonly subscribe: () => Stream.Stream<GcpSnapshot>;
    readonly command: (input: GcpCommand) => Effect.Effect<GcpCommandResult, GcpError>;
    readonly turnContext: (projectId: string) => Effect.Effect<string | null>;
  }
>()("t3/gcp/GcpService") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  links: Schema.Array(GcpProjectLink),
  cloudProjects: Schema.Array(GcpCloudProject),
});
type StoreFile = typeof StoreFile.Type;
const EMPTY_STORE: StoreFile = { version: 1, links: [], cloudProjects: [] };
const decodeStore = Schema.decodeUnknownOption(Schema.fromJsonString(StoreFile));
const encodeStore = Schema.encodeSync(Schema.fromJsonString(StoreFile));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeProjects = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ projectId: Schema.String, name: Schema.optional(Schema.String) })),
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
  const changes = yield* PubSub.sliding<void>(1);
  const checkLock = yield* Semaphore.make(1);
  const signInLock = yield* Semaphore.make(1);

  const settings = serverSettings.getSettings.pipe(
    Effect.map((value) => ({ enabled: value.googleCloudEnabled, gcloudPath: value.gcloudPath })),
    Effect.orElseSucceed(() => ({ enabled: true, gcloudPath: "" })),
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
    const candidates = gcloudCandidates({
      configuredPath: gcloudPath,
      pathEntries: (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"),
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

  const run = (gcloud: string, args: ReadonlyArray<string>, timeout: Duration.Input) =>
    runner.run({ command: gcloud, args, timeout }).pipe(
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
    const { enabled } = yield* settings;
    const current = yield* Ref.get(store);
    return {
      enabled,
      auth: yield* Ref.get(auth),
      links: current.links,
      cloudProjects: current.cloudProjects,
      resources: yield* Ref.get(resources),
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
        previous = { enabled: next.googleCloudEnabled, gcloudPath: next.gcloudPath };
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

  const turnContext = Effect.fn("GcpService.turnContext")(function* (projectId: string) {
    if (!(yield* settings).enabled) return null;
    const link = (yield* Ref.get(store)).links.find((entry) =>
      entry.projectIds.includes(projectId),
    );
    if (link === undefined) return null;
    const current = yield* Ref.get(auth);
    return formatTurnContext({ link, gcloudPath: current.gcloudPath, account: current.account });
  });

  return GcpService.of({ subscribe, command, turnContext });
});

export const layer = Layer.effect(GcpService, make);

export const layerTurnContextHook = Layer.effect(
  GcpTurnContextHook,
  Effect.gen(function* () {
    const service = yield* GcpService;
    return service.turnContext;
  }),
);
