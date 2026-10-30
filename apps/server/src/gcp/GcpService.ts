import { type GcpAuthState, type GcpCommand, GcpError, type GcpSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { classifyLogin, gcloudCandidates } from "./gcpModel.ts";

/** Google's login lasts hours, so a check every few minutes notices expiry soon enough. */
const CHECK_INTERVAL = Duration.minutes(10);

export class GcpService extends Context.Service<
  GcpService,
  {
    readonly subscribe: () => Stream.Stream<GcpSnapshot>;
    readonly command: (input: GcpCommand) => Effect.Effect<void, GcpError>;
  }
>()("t3/gcp/GcpService") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const scope = yield* Effect.scope;

  const auth = yield* Ref.make<GcpAuthState>(INITIAL_AUTH);
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

  const currentSnapshot = Effect.gen(function* () {
    const { enabled } = yield* settings;
    return { enabled, auth: yield* Ref.get(auth) } satisfies GcpSnapshot;
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
        return checkLogin;
      case "signIn":
        return signIn;
    }
  };

  return GcpService.of({ subscribe, command });
});

export const layer = Layer.effect(GcpService, make);
