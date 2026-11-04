import type { EnvironmentId, GcpDeployRun } from "@t3tools/contracts";
import { CircleCheckIcon, CircleXIcon, LoaderIcon } from "lucide-react";
import { useState } from "react";

import { gcpLinkForProject, useGcpSnapshot } from "~/state/gcp";
import { relativeAge } from "~/state/jira";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { useGcpFollowedDeploysStore } from "./gcpFollowedDeploysStore";
import { useMinuteClock } from "./useMinuteClock";

/** A finished deploy stays above the composer this long, unless dismissed. */
const FINISHED_VISIBLE_MS = 15 * 60 * 1000;

const runLabel = (run: GcpDeployRun) =>
  `${run.workflow.split("/").at(-1) ?? run.workflow}${run.number === null ? "" : ` #${run.number}`}`;

const openRun = (run: GcpDeployRun) => (
  <Button
    size="xs"
    variant="outline"
    render={<a href={run.url} target="_blank" rel="noreferrer" />}
  >
    Open run
  </Button>
);

/**
 * Deploys of the chat's project, above its composer: the ones running now, and for a while the
 * ones that just finished, with whether Google Cloud runs the deployed commit. With
 * `onlyFollowed`, a deploy shows only after the chat followed it from the Cloud panel.
 */
export function useGcpDeployBanners(
  environmentId: EnvironmentId | null,
  projectId: string | null | undefined,
  threadKey: string | null,
  onlyFollowed: boolean,
): ComposerBannerStackItem[] {
  const snapshot = useGcpSnapshot(environmentId);
  const now = useMinuteClock();
  const followed = useGcpFollowedDeploysStore((state) =>
    threadKey === null ? undefined : state.followedByThreadKey[threadKey],
  );
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const link = gcpLinkForProject(snapshot, projectId);
  if (snapshot === null || link === null) return [];
  const runs = snapshot.deploys.filter((run) => run.key === link.key);
  // The newest run per environment is the one that matters.
  const latest = new Map<string, GcpDeployRun>();
  for (const run of runs) if (!latest.has(run.environment)) latest.set(run.environment, run);
  return [...latest.values()].flatMap((run): ComposerBannerStackItem[] => {
    // A failure has its own key, so closing a running deploy doesn't hide that it later failed.
    if (onlyFollowed && !followed?.includes(run.id)) return [];
    const failed = run.status === "completed" && run.conclusion !== "success";
    const dismissKey = failed ? `${run.id}:failed` : run.id;
    if (dismissed.has(dismissKey)) return [];
    const dismiss = () => setDismissed((current) => new Set(current).add(dismissKey));
    const commit = run.headSha.slice(0, 7);
    if (run.status !== "completed") {
      return [
        {
          id: `gcp-deploy:${run.id}`,
          variant: "info",
          icon: <LoaderIcon className="animate-spin" />,
          title: `Deploying ${commit} to ${run.environment}`,
          description: `${runLabel(run)} · ${run.status === "waiting" ? "waiting for approval" : (run.currentJob ?? (run.status === "queued" ? "queued" : "running"))} · started ${relativeAge(run.createdAt, now)}`,
          actions: openRun(run),
          dismissLabel: "Dismiss",
          onDismiss: dismiss,
        },
      ];
    }
    if (now - Date.parse(run.updatedAt) > FINISHED_VISIBLE_MS) return [];
    if (failed) {
      return [
        {
          id: `gcp-deploy:${run.id}`,
          variant: "error",
          icon: <CircleXIcon />,
          title: `${run.environment} deploy ${run.conclusion === "cancelled" ? "was cancelled" : "failed"}`,
          description: `${runLabel(run)} · ${commit} · ${run.title}`,
          actions: openRun(run),
          dismissLabel: "Dismiss",
          onDismiss: dismiss,
        },
      ];
    }
    return [
      {
        id: `gcp-deploy:${run.id}`,
        variant: run.verified === false ? "warning" : "success",
        icon: <CircleCheckIcon />,
        title:
          run.verified === true
            ? `${run.environment} runs ${commit}`
            : run.verified === false
              ? `${run.environment} deploy finished, but Google Cloud doesn't run ${commit} yet`
              : `${run.environment} deploy finished`,
        description: `${runLabel(run)} · ${run.title}`,
        actions: openRun(run),
        dismissLabel: "Dismiss",
        onDismiss: dismiss,
      },
    ];
  });
}
