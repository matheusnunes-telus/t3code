import type {
  GcpCloudProject,
  GcpDeployRun,
  GcpCluster,
  GcpDeliveryStage,
  GcpResourceState,
  GcpRunJob,
  GcpRunService,
  GcpEnvironment,
  GcpLoginStatus,
  GcpProjectLink,
  GcpRuntime,
} from "@t3tools/contracts";

/**
 * Where gcloud lives when it isn't on PATH: the official installer's folder, Homebrew's cask,
 * and Linux packages. An explicit path in settings comes first.
 */
export function gcloudCandidates(input: {
  readonly configuredPath: string;
  readonly pathEntries: ReadonlyArray<string>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): ReadonlyArray<string> {
  const binary = input.platform === "win32" ? "gcloud.cmd" : "gcloud";
  const join = (dir: string) => `${dir.replace(/[\\/]+$/, "")}/${binary}`;
  const fromPath = input.pathEntries.filter((entry) => entry.length > 0).map(join);
  const known =
    input.platform === "win32"
      ? [
          `${input.home}/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin`,
          "C:/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin",
        ]
      : [
          `${input.home}/google-cloud-sdk/bin`,
          "/opt/homebrew/share/google-cloud-sdk/bin",
          "/usr/local/share/google-cloud-sdk/bin",
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/lib/google-cloud-sdk/bin",
          "/snap/bin",
        ];
  const all = [
    ...(input.configuredPath.length > 0 ? [input.configuredPath] : []),
    ...fromPath,
    ...known.map(join),
  ];
  return [...new Set(all)];
}

/**
 * Reads a `print-access-token` run. A token means signed in; gcloud's wording tells a login
 * that needs the browser again from one that never existed, and anything else (offline, a broken
 * install) is reported as an error rather than as signed out.
 */
export function classifyLogin(input: {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): { readonly status: GcpLoginStatus; readonly message: string | null } {
  if (input.exitCode === 0 && input.stdout.trim().length > 0) {
    return { status: "ok", message: null };
  }
  const output = `${input.stderr}\n${input.stdout}`.trim();
  const lower = output.toLowerCase();
  const message = lastErrorLine(output);
  if (
    /do not currently have an active account|no credentialed accounts|default credentials were not found|could not automatically determine credentials|file .* was not found/.test(
      lower,
    )
  ) {
    return { status: "missing", message };
  }
  // Offline, gcloud also says it had "a problem refreshing your current auth tokens".
  if (
    /connection|unable to find the server|timed out|name resolution|network is unreachable/.test(
      lower,
    )
  ) {
    return { status: "error", message };
  }
  if (
    /reauth|invalid_grant|invalid_rapt|refresh(ing)? (your )?(current )?(auth )?tokens?|token has been expired|expired or revoked|auth (application-default )?login/.test(
      lower,
    )
  ) {
    return { status: "expired", message };
  }
  return { status: "error", message: message ?? "gcloud could not check the login." };
}

function lastErrorLine(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const error = lines.find((line) => line.startsWith("ERROR:")) ?? lines.at(-1);
  return error === undefined ? null : error.replace(/^ERROR:\s*(\([^)]*\)\s*)?/, "").slice(0, 300);
}

/** Words too common in project and repo names to match on. */
const COMMON_WORDS = new Set([
  "app",
  "apps",
  "api",
  "web",
  "service",
  "services",
  "project",
  "projects",
  "main",
  "repo",
  "infra",
  "terraform",
  "tf",
  "gcp",
  "cloud",
  "prod",
  "dev",
  "test",
  "the",
  "and",
]);

/** The distinctive words of a project's name and folder, like "thestral" from "tf-infra-cio-aia-thestral". */
export function nameTokens(...names: ReadonlyArray<string>): ReadonlyArray<string> {
  const tokens = names
    .flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/))
    .filter((token) => token.length >= 4 && !COMMON_WORDS.has(token) && !/^\d+$/.test(token));
  return [...new Set(tokens)];
}

/** Common environment markers in project ids, in the order environments are listed. */
const ENVIRONMENT_MARKERS: ReadonlyArray<{ readonly pattern: RegExp; readonly name: string }> = [
  { pattern: /^(dev|development|sandbox|sbx)$/, name: "Dev" },
  { pattern: /^(np|nonprod|nprd|preprod)$/, name: "NP" },
  { pattern: /^(qa|test|tst|uat)$/, name: "Test" },
  { pattern: /^(stg|stage|staging)$/, name: "Staging" },
  { pattern: /^(pr|prd|prod|production|live)$/, name: "Prod" },
];

/** "NP" for `acme-billing-np-1a2b3c`; the project id itself when no marker is found. */
export function environmentNameOf(projectId: string): {
  readonly name: string;
  readonly rank: number;
} {
  const segments = projectId.toLowerCase().split(/[^a-z0-9]+/);
  for (const [rank, marker] of ENVIRONMENT_MARKERS.entries()) {
    if (segments.some((segment) => marker.pattern.test(segment)))
      return { name: marker.name, rank };
  }
  return { name: projectId, rank: ENVIRONMENT_MARKERS.length };
}

/** The account's projects whose id or name shares a distinctive word with the T3 project. */
export function matchCloudProjects(
  tokens: ReadonlyArray<string>,
  projects: ReadonlyArray<GcpCloudProject>,
): ReadonlyArray<GcpCloudProject> {
  if (tokens.length === 0) return [];
  return projects
    .filter((project) => {
      const words = new Set(nameTokens(project.projectId, project.name));
      return tokens.some((token) => words.has(token));
    })
    .toSorted(
      (a, b) =>
        environmentNameOf(a.projectId).rank - environmentNameOf(b.projectId).rank ||
        a.projectId.localeCompare(b.projectId),
    );
}

export interface WorkflowFile {
  /** Relative to the repo, like `.github/workflows/deploy-np.yml`. */
  readonly path: string;
  readonly content: string;
}

const REGION_PATTERN =
  /\b((?:northamerica|southamerica|us|europe|asia|australia|me|africa)-[a-z]+\d)\b/;

/** What a deploy workflow says about where it deploys. */
export function readWorkflow(file: WorkflowFile): {
  readonly runtime: GcpRuntime;
  readonly region: string | null;
} {
  const content = file.content;
  const runtime: GcpRuntime = /deploy-cloudrun|gcloud\s+run\s|gcloud run |cloud ?run/i.test(content)
    ? "cloud-run"
    : /gke|kubectl|helm|container clusters|get-gke-credentials/i.test(content)
      ? "gke"
      : "other";
  return { runtime, region: REGION_PATTERN.exec(content)?.[1] ?? null };
}

/**
 * Pairs each matched project with the deploy workflow that names it, or failing that the one whose
 * file name carries the same environment marker.
 */
export function suggestEnvironments(input: {
  readonly projects: ReadonlyArray<GcpCloudProject>;
  readonly workflows: ReadonlyArray<WorkflowFile>;
}): ReadonlyArray<GcpEnvironment> {
  const deploys = input.workflows.filter((file) => /deploy|release|cd\b/i.test(file.path));
  return input.projects.map((project) => {
    const environment = environmentNameOf(project.projectId);
    const byId = deploys.find((file) => file.content.includes(project.projectId));
    const byName =
      byId ??
      deploys.find((file) => {
        const fileName = file.path.split("/").at(-1) ?? file.path;
        return environmentNameOf(fileName).name === environment.name;
      });
    const read = byName === undefined ? null : readWorkflow(byName);
    return {
      name: environment.name,
      projectId: project.projectId,
      region: read?.region ?? null,
      runtime: read?.runtime ?? "other",
      deployWorkflow: byName?.path ?? null,
    };
  });
}

/** A folder looks like a Terraform repo for the project when its name shares a word and it holds `.tf` files. */
export function isTerraformCandidate(input: {
  readonly folderName: string;
  readonly tokens: ReadonlyArray<string>;
  readonly hasTerraformFiles: boolean;
}): boolean {
  if (!input.hasTerraformFiles || input.folderName.endsWith(".worktrees")) return false;
  const words = new Set(nameTokens(input.folderName));
  return input.tokens.some((token) => words.has(token));
}

const RUNTIME_NAMES: Record<GcpRuntime, string> = {
  "cloud-run": "Cloud Run",
  gke: "GKE",
  other: "",
};

/**
 * What a chat's first turn learns about where its project runs. It names the environments the
 * user linked and how to reach them, and says where deploys start so the agent doesn't invent its own.
 */
export function formatTurnContext(input: {
  readonly link: GcpProjectLink;
  readonly gcloudPath: string | null;
  readonly account: string | null;
}): string | null {
  const { link } = input;
  if (link.agentContext === false || link.environments.length === 0) return null;
  const lines = [
    "<google-cloud-context>",
    "This project runs on Google Cloud. The user linked these environments in T3:",
    ...link.environments.map((environment) => {
      const parts = [
        `project ${environment.projectId}`,
        RUNTIME_NAMES[environment.runtime],
        environment.region === null ? "" : `region ${environment.region}`,
        environment.deployWorkflow === null ? "" : `deployed by ${environment.deployWorkflow}`,
      ].filter((part) => part.length > 0);
      return `- ${environment.name}: ${parts.join(", ")}`;
    }),
  ];
  if (link.terraformRepos.length > 0) {
    lines.push(`Terraform for these environments: ${link.terraformRepos.join(", ")}`);
  }
  if (input.gcloudPath !== null) {
    lines.push(
      `gcloud: ${input.gcloudPath}${input.account === null ? "" : `, signed in as ${input.account}`}. Pass --project explicitly.`,
    );
  }
  if (link.environments.some((environment) => environment.deployWorkflow !== null)) {
    lines.push(
      "Deploys start from the GitHub workflows above, not from gcloud, unless the user asks.",
    );
  }
  lines.push("</google-cloud-context>");
  return lines.join("\n");
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const asText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

function readyState(status: Record<string, unknown> | undefined): {
  readonly state: GcpResourceState;
  readonly at: string | null;
} {
  const ready = asArray(status?.conditions)
    .map(asRecord)
    .find((condition) => condition?.type === "Ready");
  const state: GcpResourceState =
    ready?.status === "True"
      ? "ready"
      : ready?.status === "False"
        ? "failed"
        : ready?.status === "Unknown"
          ? "deploying"
          : "unknown";
  return { state, at: asText(ready?.lastTransitionTime) };
}

const firstImage = (template: unknown): string | null =>
  asText(asRecord(asArray(asRecord(template)?.containers)[0])?.image);

/** Reads `gcloud run services list --format=json`. */
export function parseRunServices(json: unknown): ReadonlyArray<GcpRunService> {
  return asArray(json).flatMap((entry) => {
    const service = asRecord(entry);
    const metadata = asRecord(service?.metadata);
    const name = asText(metadata?.name);
    if (service === undefined || name === null) return [];
    const status = asRecord(service.status);
    const ready = readyState(status);
    return [
      {
        name,
        region: asText(asRecord(metadata?.labels)?.["cloud.googleapis.com/location"]),
        url: asText(status?.url),
        state: ready.state,
        revision: asText(status?.latestReadyRevisionName),
        image: firstImage(asRecord(asRecord(service.spec)?.template)?.spec),
        deployedAt: ready.at,
        deployedBy: asText(asRecord(metadata?.annotations)?.["serving.knative.dev/lastModifier"]),
      },
    ];
  });
}

/** Reads `gcloud run jobs list --format=json`. */
export function parseRunJobs(json: unknown): ReadonlyArray<GcpRunJob> {
  return asArray(json).flatMap((entry) => {
    const job = asRecord(entry);
    const metadata = asRecord(job?.metadata);
    const name = asText(metadata?.name);
    if (job === undefined || name === null) return [];
    const execution = asRecord(asRecord(job.status)?.latestCreatedExecution);
    const completion = asText(execution?.completionStatus);
    const template = asRecord(asRecord(asRecord(asRecord(job.spec)?.template)?.spec)?.template);
    return [
      {
        name,
        region: asText(asRecord(metadata?.labels)?.["cloud.googleapis.com/location"]),
        image: firstImage(template?.spec),
        lastRunAt: asText(execution?.creationTimestamp),
        lastRunState:
          execution === undefined
            ? "none"
            : completion === "EXECUTION_SUCCEEDED"
              ? "succeeded"
              : completion === null || completion === "EXECUTION_RUNNING"
                ? "running"
                : "failed",
      },
    ];
  });
}

/** Reads `gcloud container clusters list --format=json`. */
export function parseClusters(json: unknown): ReadonlyArray<GcpCluster> {
  return asArray(json).flatMap((entry) => {
    const cluster = asRecord(entry);
    const name = asText(cluster?.name);
    if (cluster === undefined || name === null) return [];
    const status = asText(cluster.status);
    return [
      {
        name,
        location: asText(cluster.location) ?? "",
        state:
          status === "RUNNING"
            ? "ready"
            : status === "ERROR" || status === "DEGRADED"
              ? "failed"
              : status === "PROVISIONING" || status === "RECONCILING"
                ? "deploying"
                : "unknown",
        version: asText(cluster.currentMasterVersion),
      },
    ];
  });
}

/** Reads `gh run list --json databaseId,number,status,conclusion,url,headSha,createdAt,updatedAt,displayTitle`. */
export function parseWorkflowRuns(
  json: unknown,
  target: { readonly key: string; readonly environment: string; readonly workflow: string },
): ReadonlyArray<GcpDeployRun> {
  return asArray(json).flatMap((entry) => {
    const run = asRecord(entry);
    const id = run?.databaseId;
    const headSha = asText(run?.headSha);
    const url = asText(run?.url);
    if (
      run === undefined ||
      (typeof id !== "number" && typeof id !== "string") ||
      !headSha ||
      !url
    ) {
      return [];
    }
    const status = asText(run.status);
    return [
      {
        id: String(id),
        key: target.key,
        environment: target.environment,
        workflow: target.workflow,
        number: typeof run.number === "number" ? run.number : null,
        status:
          status === "completed"
            ? "completed"
            : status === "waiting"
              ? "waiting"
              : status === "queued" || status === "pending" || status === "requested"
                ? "queued"
                : "in_progress",
        conclusion: asText(run.conclusion),
        url,
        headSha,
        title: asText(run.displayTitle) ?? "",
        createdAt: asText(run.createdAt) ?? "",
        updatedAt: asText(run.updatedAt) ?? "",
        currentJob: null,
        verified: null,
      },
    ];
  });
}

/** The job a run is on: the first one in progress, else the first queued. */
export function currentJobOf(json: unknown): string | null {
  const jobs = asArray(asRecord(json)?.jobs).map(asRecord);
  const running =
    jobs.find((job) => job?.status === "in_progress") ??
    jobs.find((job) => job?.status === "queued");
  return asText(running?.name);
}

/**
 * Whether a deployed image carries the commit: image tags are usually the full or short sha.
 * Null when no image says anything about commits, so the check can't tell.
 */
export function imagesServeCommit(
  images: ReadonlyArray<string | null>,
  sha: string,
): boolean | null {
  const tags = images.flatMap((image) => {
    const tag = image?.split("@")[0]?.split("/").at(-1)?.split(":")[1];
    return tag && /^[0-9a-f]{7,40}$/.test(tag) ? [tag] : [];
  });
  if (tags.length === 0) return null;
  return tags.some((tag) => sha.startsWith(tag) || tag.startsWith(sha.slice(0, 7)));
}

/** "github.com/owner/repo" as "owner/repo", the way pull requests name their repository. */
const linkRepository = (key: string) => key.split("/").slice(-2).join("/").toLowerCase();

/** The environment changes are finally released to: named like production, or the last of several. */
export function prodEnvironmentOf(link: GcpProjectLink): GcpEnvironment | null {
  const deploying = link.environments.filter((environment) => environment.deployWorkflow !== null);
  const named = deploying.find((environment) =>
    /\b(prod|prd|production)\b/i.test(environment.name),
  );
  if (named !== undefined) return named;
  return deploying.length > 1 ? (deploying.at(-1) ?? null) : null;
}

/** The pull requests that still have to reach Prod: merged, in the link's own repo. */
export function deliverablePullRequests<
  T extends {
    readonly repository: string;
    readonly snapshot?: { readonly state: string } | null | undefined;
  },
>(link: GcpProjectLink, pullRequests: ReadonlyArray<T>): ReadonlyArray<T> {
  if (prodEnvironmentOf(link) === null) return [];
  const repository = linkRepository(link.key);
  return pullRequests.filter(
    (pullRequest) =>
      pullRequest.snapshot?.state === "merged" &&
      pullRequest.repository.toLowerCase() === repository,
  );
}

const isRunning = (run: GcpDeployRun) => run.status !== "completed";
const passed = (run: GcpDeployRun) => run.status === "completed" && run.conclusion === "success";
/** A run someone stopped says nothing about the change, so it doesn't count either way. */
const counts = (run: GcpDeployRun) =>
  run.status !== "completed" || (run.conclusion !== "cancelled" && run.conclusion !== "skipped");

/**
 * The stage a merged commit reached, from the runs that contain it, newest first. Once a run
 * passed the commit is out there, so a later failure doesn't take that back.
 */
export function deliveryStage(input: {
  readonly testRuns: ReadonlyArray<GcpDeployRun>;
  readonly prodRuns: ReadonlyArray<GcpDeployRun>;
}): { readonly stage: GcpDeliveryStage; readonly run: GcpDeployRun | null } {
  const prodRuns = input.prodRuns.filter(counts);
  const testRuns = input.testRuns.filter(counts);
  const prodPassed = prodRuns.find(passed);
  if (prodPassed !== undefined) return { stage: "in-prod", run: prodPassed };
  const prodLatest = prodRuns[0];
  if (prodLatest !== undefined) {
    return { stage: isRunning(prodLatest) ? "deploying-prod" : "prod-failed", run: prodLatest };
  }
  const testPassed = testRuns.find(passed);
  if (testPassed !== undefined) return { stage: "on-test", run: testPassed };
  const testLatest = testRuns[0];
  if (testLatest !== undefined) {
    return { stage: isRunning(testLatest) ? "deploying-test" : "test-failed", run: testLatest };
  }
  return { stage: "merged", run: null };
}
