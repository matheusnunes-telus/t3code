import type { EnvironmentId, GcpCommand, GcpSnapshot } from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export function useGcpSnapshot(environmentId: EnvironmentId | null): GcpSnapshot | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.gcpLive({ environmentId, input: {} }),
  );
  return query.data ?? null;
}

export function useGcpCommand(environmentId: EnvironmentId | null) {
  const run = useAtomCommand(serverEnvironment.gcpCommand, { label: "Google Cloud" });
  return (input: GcpCommand) =>
    environmentId === null ? Promise.resolve(null) : run({ environmentId, input });
}

/**
 * One word for the login, worst first. "hidden" covers Google Cloud being off or gcloud not
 * installed, so people who don't use Google Cloud never see it.
 */
export type GcpLoginHealth =
  | "hidden"
  | "signing-in"
  | "signed-out"
  | "app-credentials"
  | "error"
  | "checking"
  | "ok";

export function gcpLoginHealth(snapshot: GcpSnapshot | null): GcpLoginHealth {
  if (snapshot === null || !snapshot.enabled) return "hidden";
  const { auth } = snapshot;
  if (auth.checkedAt === null && (auth.user === "unknown" || auth.user === "checking")) {
    return "hidden";
  }
  if (auth.gcloudPath === null && auth.checkedAt !== null) return "hidden";
  if (auth.signingIn) return "signing-in";
  if (auth.user === "expired" || auth.user === "missing") return "signed-out";
  if (auth.applicationDefault === "expired" || auth.applicationDefault === "missing") {
    return "app-credentials";
  }
  if (auth.user === "error" || auth.applicationDefault === "error") return "error";
  if (auth.user === "checking") return "checking";
  return "ok";
}
