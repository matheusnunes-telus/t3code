import { useEffect, useRef } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useJiraCommand, useJiraSnapshot } from "~/state/jira";
import { toastManager } from "../ui/toast";

/** Shows each Jira notice once, as a toast, then clears it on the server. */
export function JiraNoticeCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useJiraSnapshot(environmentId);
  const command = useJiraCommand(environmentId);
  const shown = useRef(new Set<string>());
  const notices = snapshot?.enabled === true ? snapshot.notices : [];

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

  return null;
}
