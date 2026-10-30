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
});
export type GcpProjectLink = typeof GcpProjectLink.Type;

export const GcpCloudProject = Schema.Struct({
  projectId: Schema.String,
  name: Schema.String,
});
export type GcpCloudProject = typeof GcpCloudProject.Type;

export const GcpSnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  auth: GcpAuthState,
  links: Schema.Array(GcpProjectLink),
  /** The projects the signed-in account can see, read with `gcloud projects list`. */
  cloudProjects: Schema.Array(GcpCloudProject),
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
]);
export type GcpCommand = typeof GcpCommand.Type;

/** `suggestLink` answers with its proposal; the other commands with null. */
export const GcpCommandResult = Schema.NullOr(GcpProjectLink);
export type GcpCommandResult = typeof GcpCommandResult.Type;
