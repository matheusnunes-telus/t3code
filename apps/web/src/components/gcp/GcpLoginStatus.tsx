import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { gcpLoginHealth, type GcpLoginHealth, useGcpCommand, useGcpSnapshot } from "~/state/gcp";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DOT: Record<Exclude<GcpLoginHealth, "hidden">, string> = {
  ok: "bg-success",
  checking: "bg-info",
  "signing-in": "bg-info motion-safe:animate-pulse",
  "app-credentials": "bg-warning",
  error: "bg-warning",
  "signed-out": "bg-destructive",
};

const LINK = "cursor-pointer underline underline-offset-2 hover:text-foreground";

/** "Google Cloud · you@example.com", or why gcloud can't be used right now. */
export function GcpLoginStatus({
  environmentId,
  className,
}: {
  environmentId: EnvironmentId;
  className?: string;
}) {
  const snapshot = useGcpSnapshot(environmentId);
  const command = useGcpCommand(environmentId);
  const health = gcpLoginHealth(snapshot);
  if (snapshot === null || health === "hidden") return null;
  const { auth } = snapshot;
  const signIn = (
    <button type="button" className={LINK} onClick={() => void command({ type: "signIn" })}>
      Sign in
    </button>
  );
  const label =
    health === "ok" || health === "checking" ? (
      <>Google Cloud{auth.account ? ` · ${auth.account}` : ""}</>
    ) : health === "signing-in" ? (
      <>Finish the Google Cloud sign-in in your browser</>
    ) : health === "signed-out" ? (
      <>Google Cloud signed out · {signIn}</>
    ) : health === "app-credentials" ? (
      <>Google Cloud app credentials need sign-in · {signIn}</>
    ) : (
      <>
        Couldn't check Google Cloud ·{" "}
        <button type="button" className={LINK} onClick={() => void command({ type: "checkLogin" })}>
          Retry
        </button>
      </>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
              className,
            )}
            data-gcp-login={health}
          />
        }
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[health])} />
        <span className="min-w-0 truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {health === "app-credentials"
          ? "gcloud works, but SDKs, scripts and Terraform use the application default credentials, which need the browser sign-in again."
          : (auth.message ?? `Checked every 10 minutes with ${auth.gcloudPath}.`)}
      </TooltipPopup>
    </Tooltip>
  );
}
