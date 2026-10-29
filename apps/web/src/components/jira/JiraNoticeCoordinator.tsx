import type { EnvironmentId, JiraSnapshot, JiraSyncStatus } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { readLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useJiraCommand, useJiraSnapshot } from "~/state/jira";
import { toastManager } from "../ui/toast";
import { CLAUDE_CONNECTOR_SETTINGS_URL } from "./JiraSyncStatus";

/** A returning window checks the login again, but not more often than this. */
const RECHECK_GAP_MS = 30_000;

const openConnectorSettings = () => {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(CLAUDE_CONNECTOR_SETTINGS_URL);
  else window.open(CLAUDE_CONNECTOR_SETTINGS_URL, "_blank", "noreferrer");
};

/**
 * Raises one lasting toast when Jira loses its Atlassian login. With the Atlassian CLI, its
 * button opens the CLI's browser login and the server syncs once it works. With the claude.ai
 * connector it links to the connector settings, and coming back to the window checks again.
 * The toast closes once a call works.
 */
function JiraSignInToast({
  environmentId,
  status,
  signIn,
}: {
  environmentId: EnvironmentId;
  status: JiraSyncStatus | null;
  signIn: JiraSnapshot["signIn"];
}) {
  const command = useJiraCommand(environmentId);
  const toastId = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const reconnecting = useRef(false);
  const lastCheck = useRef(0);
  const signedOut = status === "signed-out";

  // oxlint-disable-next-line t3code/react-effect-budget -- the toast lives outside React and follows the server's sync status, which no handler here sets.
  useEffect(() => {
    // A sync in flight says nothing yet about the login.
    if (status === "syncing") return;
    if (status !== "signed-out") {
      if (toastId.current === null) return;
      toastManager.close(toastId.current);
      toastId.current = null;
      if (reconnecting.current) {
        toastManager.add({ type: "success", title: "Jira is connected again" });
      }
      reconnecting.current = false;
      return;
    }
    // Shown once per sign-out; a dismissed toast stays dismissed until the login comes back.
    if (toastId.current !== null) return;
    toastId.current = toastManager.add({
      type: "warning",
      title: "Jira signed you out",
      description:
        signIn === "cli"
          ? "Sign in to Atlassian in the browser. T3 syncs as soon as it works."
          : "Reconnect Atlassian in your claude.ai connector settings. T3 checks again when you come back.",
      timeout: 0,
      actionProps: {
        children: signIn === "cli" ? "Sign in" : "Reconnect",
        onClick: () => {
          reconnecting.current = true;
          if (signIn === "cli") void command({ type: "signIn" });
          else openConnectorSettings();
        },
      },
    });
  }, [status, signIn, command]);

  // oxlint-disable-next-line t3code/react-effect-budget -- returning from the browser is a window event; it rechecks the login only after Reconnect was used.
  useEffect(() => {
    if (!signedOut || signIn === "cli") return;
    const recheck = () => {
      if (!reconnecting.current || Date.now() - lastCheck.current < RECHECK_GAP_MS) return;
      lastCheck.current = Date.now();
      void command({ type: "sync" });
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [signedOut, signIn, command]);

  return null;
}

/** Shows each Jira notice once, as a toast, then clears it on the server. */
export function JiraNoticeCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useJiraSnapshot(environmentId);
  const command = useJiraCommand(environmentId);
  const shown = useRef(new Set<string>());
  const notices = snapshot?.enabled === true ? snapshot.notices : [];

  // oxlint-disable-next-line t3code/react-effect-budget -- notices arrive from the server's sync and become toasts outside React.
  useEffect(() => {
    for (const notice of notices) {
      const id = `${notice.key}:${notice.at}`;
      if (shown.current.has(id)) continue;
      shown.current.add(id);
      toastManager.add({ type: "info", title: "Jira", description: notice.summary });
      void command({ type: "clearNotice", key: notice.key });
    }
    // The set of shown notices makes extra runs harmless.
  }, [notices, command]);

  if (environmentId === null) return null;
  return (
    <JiraSignInToast
      environmentId={environmentId}
      status={snapshot?.enabled === true ? snapshot.sync.status : null}
      signIn={snapshot?.signIn ?? "connector"}
    />
  );
}
