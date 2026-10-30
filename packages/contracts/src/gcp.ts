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

export const GcpSnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  auth: GcpAuthState,
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
]);
export type GcpCommand = typeof GcpCommand.Type;
