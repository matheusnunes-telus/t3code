import type { EnvironmentId, JiraSnapshot, JiraSyncStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useJiraCommand, useJiraSnapshot } from "~/state/jira";
import { toastManager } from "../ui/toast";
import { openExternalUrl } from "./JiraSyncStatus";

/**
 * Raises one lasting toast when Jira loses its Atlassian login. Its button runs the browser
 * login for the Atlassian MCP server (or the CLI, when MCP cannot run), and the server syncs once
 * it works. If the login prints its page, the toast offers to open it, in case no tab opened.
 * The toast closes once a call works.
 */
function JiraSignInToast({
  environmentId,
  status,
  signIn,
  signInUrl,
}: {
  environmentId: EnvironmentId;
  status: JiraSyncStatus | null;
  signIn: JiraSnapshot["signIn"];
  signInUrl: string | null;
}) {
  const command = useJiraCommand(environmentId);
  const toastId = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const reconnecting = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the toast lives outside React and follows the server's sync status, which no handler here sets.
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
    const options = {
      type: "warning" as const,
      title: "Jira signed you out",
      description:
        signIn === "none"
          ? "Add the Atlassian MCP server with claude mcp add, or install the Atlassian CLI."
          : signInUrl !== null
            ? "Finish signing in to Atlassian in the browser. T3 syncs as soon as it works."
            : "Sign in to Atlassian in the browser. T3 syncs as soon as it works.",
      timeout: 0,
      ...(signIn === "none"
        ? {}
        : {
            actionProps:
              signInUrl !== null
                ? { children: "Open sign-in page", onClick: () => openExternalUrl(signInUrl) }
                : {
                    children: "Sign in",
                    onClick: () => {
                      reconnecting.current = true;
                      void command({ type: "signIn" });
                    },
                  },
          }),
    };
    // Shown once per sign-out; a dismissed toast stays dismissed until the login comes back.
    if (toastId.current === null) toastId.current = toastManager.add(options);
    else toastManager.update(toastId.current, options);
  }, [status, signIn, signInUrl, command]);

  return null;
}

/** Shows each Jira notice once, as a toast, then clears it on the server. */
export function JiraNoticeCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useJiraSnapshot(environmentId);
  const command = useJiraCommand(environmentId);
  const navigate = useNavigate();
  const shown = useRef(new Set<string>());
  const notices = snapshot?.enabled === true ? snapshot.notices : [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- notices arrive from the server's sync and become toasts outside React.
  useEffect(() => {
    for (const notice of notices) {
      const id = `${notice.key}:${notice.at}`;
      if (shown.current.has(id)) continue;
      shown.current.add(id);
      const { threadId } = notice;
      toastManager.add({
        type: "info",
        title: "Jira",
        description: notice.summary,
        ...(threadId !== undefined && environmentId !== null
          ? {
              actionProps: {
                children: "Open chat",
                onClick: () =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId },
                  }),
              },
            }
          : {}),
      });
      void command({ type: "clearNotice", key: notice.key });
    }
    // The set of shown notices makes extra runs harmless.
  }, [notices, command, environmentId, navigate]);

  if (environmentId === null) return null;
  return (
    <JiraSignInToast
      environmentId={environmentId}
      status={snapshot?.enabled === true ? snapshot.sync.status : null}
      signIn={snapshot?.signIn ?? "none"}
      signInUrl={snapshot?.signInUrl ?? null}
    />
  );
}
