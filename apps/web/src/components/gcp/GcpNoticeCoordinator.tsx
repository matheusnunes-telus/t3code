import { useEffect, useRef } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { gcpLoginHealth, useGcpCommand, useGcpSnapshot } from "~/state/gcp";
import { toastManager } from "../ui/toast";

/** A returning window checks the login again, but not more often than this. */
const RECHECK_GAP_MS = 30_000;

const lostLogin = (health: ReturnType<typeof gcpLoginHealth>) =>
  health === "signed-out" || health === "app-credentials";

/**
 * Raises one lasting toast when the Google Cloud login expires, plus a desktop notification
 * when T3 isn't in front. Its button opens gcloud's browser sign-in; the toast closes once the
 * login works again.
 */
export function GcpNoticeCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useGcpSnapshot(environmentId);
  const command = useGcpCommand(environmentId);
  const health = gcpLoginHealth(snapshot);
  const toastId = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const signingIn = useRef(false);
  const lastCheck = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the toast and the desktop notification live outside React and follow the server's login checks.
  useEffect(() => {
    if (health === "checking" || health === "signing-in" || health === "hidden") return;
    if (!lostLogin(health)) {
      if (toastId.current === null) return;
      toastManager.close(toastId.current);
      toastId.current = null;
      if (signingIn.current) {
        toastManager.add({ type: "success", title: "Google Cloud is signed in again" });
      }
      signingIn.current = false;
      return;
    }
    // Shown once per expiry; a dismissed toast stays dismissed until the login comes back.
    if (toastId.current !== null) return;
    const title =
      health === "signed-out"
        ? "Google Cloud signed you out"
        : "Google Cloud app credentials expired";
    const description =
      health === "signed-out"
        ? "gcloud commands in your chats will fail until you sign in again in the browser."
        : "SDKs, scripts and Terraform will fail until you sign in again in the browser.";
    toastId.current = toastManager.add({
      type: "warning",
      title,
      description,
      timeout: 0,
      actionProps: {
        children: "Sign in",
        onClick: () => {
          signingIn.current = true;
          void command({ type: "signIn" });
        },
      },
    });
    if (
      !document.hasFocus() &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      const notification = new Notification(title, { body: description });
      notification.addEventListener("click", () => window.focus());
    }
  }, [health, command]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- returning to the window is when a login fixed in a terminal shows up; it rechecks only while signed out.
  useEffect(() => {
    if (!lostLogin(health)) return;
    const recheck = () => {
      if (Date.now() - lastCheck.current < RECHECK_GAP_MS) return;
      lastCheck.current = Date.now();
      void command({ type: "checkLogin" });
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [health, command]);

  // Finished deploys no longer raise toasts: on a shared project a deploy is always running.
  // They are still cleared from the server's list so it doesn't grow, and the Cloud panel shows them.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finished deploys arrive from the server's polling and are cleared outside React.
  useEffect(() => {
    if (snapshot === null || snapshot.finishedDeploys.length === 0) return;
    void command({ type: "clearFinishedDeploys", ids: [...snapshot.finishedDeploys] });
  }, [snapshot, command]);

  return null;
}
