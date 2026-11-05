import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon } from "lucide-react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  gcpLinkForProject,
  gcpLoginHealth,
  type GcpLoginHealth,
  useGcpCommand,
  useGcpSnapshot,
} from "~/state/gcp";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
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

const APP_CREDENTIALS_HINT =
  "gcloud works, but SDKs, scripts and Terraform use the application default credentials, which need the browser sign-in again.";

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
          ? APP_CREDENTIALS_HINT
          : (auth.message ?? `Checked every 10 minutes with ${auth.gcloudPath}.`)}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The login as a footer icon. The text row's Sign in and Retry links become the icon's click. */
export function GcpLoginSidebarItem({
  environmentId,
  onOpen,
}: {
  environmentId: EnvironmentId;
  onOpen: () => void;
}) {
  const snapshot = useGcpSnapshot(environmentId);
  const command = useGcpCommand(environmentId);
  const { routeThreadRef, activeThread } = useHandleNewThread();
  const health = gcpLoginHealth(snapshot);
  if (snapshot === null || health === "hidden") return null;
  const { auth } = snapshot;
  const needsSignIn = health === "signed-out" || health === "app-credentials";
  const cloudAvailable =
    routeThreadRef !== null && gcpLinkForProject(snapshot, activeThread?.projectId) !== null;
  const disabled = !needsSignIn && health !== "error" && !cloudAvailable;

  const label =
    health === "signing-in"
      ? "Finish the Google Cloud sign-in in your browser"
      : health === "signed-out"
        ? "Google Cloud signed out: click to sign in"
        : health === "app-credentials"
          ? "Google Cloud app credentials need sign-in: click to sign in"
          : health === "error"
            ? "Couldn't check Google Cloud: click to retry"
            : `Google Cloud${auth.account ? ` · ${auth.account}` : ""}`;
  const detail =
    health === "app-credentials"
      ? APP_CREDENTIALS_HINT
      : (auth.message ?? `Checked every 10 minutes with ${auth.gcloudPath}.`);
  const panelHint = !disabled
    ? null
    : routeThreadRef === null
      ? "Open a chat to see the Cloud panel."
      : "Link this project in its settings to see the Cloud panel.";

  const handleClick = () => {
    if (needsSignIn) {
      void command({ type: "signIn" });
    } else if (health === "error") {
      void command({ type: "checkLogin" });
    } else if (routeThreadRef !== null) {
      onOpen();
      useRightPanelStore.getState().open(routeThreadRef, "cloud");
    }
  };

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        {/* A span triggers the tooltip, so a disabled button still explains itself on hover. */}
        <TooltipTrigger render={<span className="inline-flex" data-gcp-login={health} />}>
          <SidebarMenuButton
            aria-label={label}
            aria-disabled={disabled || undefined}
            className="relative"
            onClick={disabled ? undefined : handleClick}
            size="icon"
            type="button"
          >
            <CloudIcon />
            {health === "ok" || health === "checking" ? null : (
              <span
                aria-hidden
                className={cn(
                  "absolute top-1 right-1 size-2 rounded-full ring-2 ring-sidebar",
                  DOT[health],
                )}
              />
            )}
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72">
          <div className="font-medium">{label}</div>
          <div className="text-muted-foreground">{detail}</div>
          {panelHint ? <div className="text-muted-foreground">{panelHint}</div> : null}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
