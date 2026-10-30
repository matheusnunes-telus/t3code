import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/**
 * Google Cloud is reached through the user's own gcloud CLI, so nothing here names a project:
 * every project, environment and repo comes from what the user links.
 */
export const GcpLoginStatus = Schema.Literals([
  /** Not looked at yet. */
  "unknown",
  "checking",
  "ok",
  /** The login exists but Google wants the browser sign-in again. */
  "expired",
  /** Never signed in, or signed out. */
  "missing",
  /** The check itself failed (offline, gcloud broken); the login may be fine. */
  "error",
]);
export type GcpLoginStatus = typeof GcpLoginStatus.Type;

export const GcpAuthState = Schema.Struct({
  /** The gcloud binary in use, or null when none was found. */
  gcloudPath: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  /** `gcloud auth login`: what gcloud commands use. */
  user: GcpLoginStatus,
  /** Application default credentials: what SDKs, scripts and Terraform use. */
  applicationDefault: GcpLoginStatus,
  checkedAt: Schema.NullOr(IsoDateTime),
  /** True while the browser sign-in runs. */
  signingIn: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type GcpAuthState = typeof GcpAuthState.Type;

export const GcpRuntime = Schema.Literals(["cloud-run", "gke", "other"]);
export type GcpRuntime = typeof GcpRuntime.Type;

/** One place a project runs, named by the user ("NP", "Prod", "Staging"…). */
export const GcpEnvironment = Schema.Struct({
  name: Schema.String,
  /** The Google Cloud project id. */
  projectId: Schema.String,
  region: Schema.NullOr(Schema.String),
  runtime: GcpRuntime,
  /** The GitHub workflow that deploys here, relative to the repo, like `.github/workflows/deploy.yml`. */
  deployWorkflow: Schema.NullOr(Schema.String),
});
export type GcpEnvironment = typeof GcpEnvironment.Type;

/** A T3 project's Google Cloud environments and the Terraform that builds them. */
export const GcpProjectLink = Schema.Struct({
  /** The T3 project group this link belongs to. */
  key: Schema.String,
  title: Schema.String,
  /** Every T3 project id in the group, so a chat in any checkout finds the link. */
  projectIds: Schema.Array(Schema.String),
  workspaceRoot: Schema.String,
  environments: Schema.Array(GcpEnvironment),
  /** Local folders of the Terraform repos for these environments. */
  terraformRepos: Schema.Array(Schema.String),
  /** Whether chats in the project are told about these environments; on unless turned off. */
  agentContext: Schema.optionalKey(Schema.Boolean),
});
export type GcpProjectLink = typeof GcpProjectLink.Type;

export const GcpCloudProject = Schema.Struct({
  projectId: Schema.String,
  name: Schema.String,
});
export type GcpCloudProject = typeof GcpCloudProject.Type;

export const GcpResourceState = Schema.Literals(["ready", "failed", "deploying", "unknown"]);
export type GcpResourceState = typeof GcpResourceState.Type;

export const GcpRunService = Schema.Struct({
  name: Schema.String,
  region: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  state: GcpResourceState,
  revision: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  /** When the serving revision became ready. */
  deployedAt: Schema.NullOr(Schema.String),
  deployedBy: Schema.NullOr(Schema.String),
});
export type GcpRunService = typeof GcpRunService.Type;

export const GcpRunJob = Schema.Struct({
  name: Schema.String,
  region: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastRunState: Schema.Literals(["succeeded", "failed", "running", "none"]),
});
export type GcpRunJob = typeof GcpRunJob.Type;

export const GcpCluster = Schema.Struct({
  name: Schema.String,
  location: Schema.String,
  state: GcpResourceState,
  version: Schema.NullOr(Schema.String),
});
export type GcpCluster = typeof GcpCluster.Type;

/** What runs in one Google Cloud project, read on demand with gcloud. */
export const GcpEnvironmentResources = Schema.Struct({
  projectId: Schema.String,
  fetchedAt: IsoDateTime,
  services: Schema.Array(GcpRunService),
  jobs: Schema.Array(GcpRunJob),
  clusters: Schema.Array(GcpCluster),
  message: Schema.NullOr(Schema.String),
});
export type GcpEnvironmentResources = typeof GcpEnvironmentResources.Type;

/** A GitHub Actions run of an environment's deploy workflow. */
export const GcpDeployRun = Schema.Struct({
  /** The run's id on GitHub. */
  id: Schema.String,
  /** The link and environment it deploys. */
  key: Schema.String,
  environment: Schema.String,
  workflow: Schema.String,
  number: Schema.NullOr(Schema.Number),
  /** "waiting" is a run held for an approval, like a protected environment. */
  status: Schema.Literals(["queued", "waiting", "in_progress", "completed"]),
  conclusion: Schema.NullOr(Schema.String),
  url: Schema.String,
  headSha: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** The job running now, while it runs. */
  currentJob: Schema.NullOr(Schema.String),
  /** After a successful run: whether Google Cloud serves that commit; null when it can't tell. */
  verified: Schema.NullOr(Schema.Boolean),
});
export type GcpDeployRun = typeof GcpDeployRun.Type;

export const GcpSnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  auth: GcpAuthState,
  links: Schema.Array(GcpProjectLink),
  /** The projects the signed-in account can see, read with `gcloud projects list`. */
  cloudProjects: Schema.Array(GcpCloudProject),
  /** Keyed by Google Cloud project id; filled when a project's panel is opened. */
  resources: Schema.Record(Schema.String, GcpEnvironmentResources),
  /** Project ids being read right now. */
  loading: Schema.Array(Schema.String),
  /** Recent deploy runs of the linked environments, newest first. */
  deploys: Schema.Array(GcpDeployRun),
  /** Runs that finished since the client last cleared them, to announce once. */
  finishedDeploys: Schema.Array(Schema.String),
});
export type GcpSnapshot = typeof GcpSnapshot.Type;

export class GcpError extends Schema.TaggedError<GcpError>()("GcpError", {
  message: Schema.String,
}) {}

export const GcpSubscribeInput = Schema.Struct({});

export const GcpCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("checkLogin") }),
  /** Opens gcloud's browser sign-in, which renews both the gcloud and the default credentials. */
  Schema.Struct({ type: Schema.Literal("signIn") }),
  /** Reads the account's projects again. */
  Schema.Struct({ type: Schema.Literal("listProjects") }),
  /** Proposes a link for a T3 project from its name, repo workflows and nearby Terraform; saves nothing. */
  Schema.Struct({
    type: Schema.Literal("suggestLink"),
    key: Schema.String,
    title: Schema.String,
    projectIds: Schema.Array(Schema.String),
    workspaceRoot: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("saveLink"), link: GcpProjectLink }),
  Schema.Struct({ type: Schema.Literal("removeLink"), key: Schema.String }),
  /** Reads what runs in one Google Cloud project: Cloud Run services and jobs, GKE clusters. */
  Schema.Struct({ type: Schema.Literal("loadResources"), projectId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("refreshDeploys") }),
  /** Marks finished runs as announced. */
  Schema.Struct({ type: Schema.Literal("clearFinishedDeploys"), ids: Schema.Array(Schema.String) }),
]);
export type GcpCommand = typeof GcpCommand.Type;

/** `suggestLink` answers with its proposal; the other commands with null. */
export const GcpCommandResult = Schema.NullOr(GcpProjectLink);
export type GcpCommandResult = typeof GcpCommandResult.Type;
