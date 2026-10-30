import type {
  GcpCloudProject,
  GcpEnvironment,
  GcpLoginStatus,
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
