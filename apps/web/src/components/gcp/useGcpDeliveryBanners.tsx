import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CircleCheckIcon, CircleXIcon, LoaderIcon } from "lucide-react";

import { useGcpSnapshot } from "~/state/gcp";
import { issueByKey, threadTicketKeys, useJiraCommand, useJiraSnapshot } from "~/state/jira";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { chatDelivery } from "./gcpDelivery.logic";
import { useGcpFinishingStore } from "./gcpFinishingStore";
import { useGcpFollowedDeploysStore } from "./gcpFollowedDeploysStore";

/** Where this chat's merged pull requests are on the way to Prod, above its composer. */
export function useGcpDeliveryBanners(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  threadKey: string | null,
): ComposerBannerStackItem[] {
  const snapshot = useGcpSnapshot(environmentId);
  const jiraSnapshot = useJiraSnapshot(environmentId);
  const jiraCommand = useJiraCommand(environmentId);
  const finishing = useGcpFinishingStore((state) =>
    threadKey === null ? undefined : state.finishing[threadKey],
  );
  const startFinishing = useGcpFinishingStore((state) => state.start);
  const reviewFinishing = useGcpFinishingStore((state) => state.review);
  const cancelFinishing = useGcpFinishingStore((state) => state.cancel);
  const dismissed = useGcpFollowedDeploysStore((state) => state.dismissedDeliveries);
  const dismissDelivery = useGcpFollowedDeploysStore((state) => state.dismissDelivery);
  if (snapshot === null || threadId === null || threadKey === null) return [];
  const summary = chatDelivery(snapshot.deliveries, threadId);
  if (summary === null) return [];
  const id = `gcp-delivery:${threadId}`;

  if (finishing !== undefined) {
    return [
      finishing.phase === "drafting"
        ? {
            id,
            variant: "default",
            icon: <Spinner className="size-4" />,
            title: "Drafting the Jira update…",
          }
        : {
            id,
            variant: "default",
            icon: <CircleCheckIcon />,
            title: "Finishing this chat",
            description: "It settles once the Jira card is applied or dismissed.",
            dismissLabel: "Keep open",
            onDismiss: () => cancelFinishing(threadKey),
          },
    ];
  }

  const finish = async (reason: string) => {
    const tickets =
      jiraSnapshot?.enabled === true
        ? threadTicketKeys(jiraSnapshot, threadId).filter(
            (key) => issueByKey(jiraSnapshot, key)?.statusCategory !== "done",
          )
        : [];
    startFinishing(threadKey, {
      phase: "drafting",
      expectedCards: tickets.length,
      knownCardIds: (jiraSnapshot?.changeSets ?? []).map((set) => set.id),
    });
    const results = await Promise.all(
      tickets.map((key) =>
        jiraCommand({ type: "proposeChanges", threadId, key, reason, merged: true }),
      ),
    );
    // The failure was already reported; the chat stays open so nothing is lost.
    if (results.some((result) => result !== null && result._tag === "Failure")) {
      cancelFinishing(threadKey);
      return;
    }
    reviewFinishing(threadKey);
  };

  const [first] = summary.deliveries;
  if (first === undefined) return [];
  const { run, prodEnvironment: prod, testEnvironment } = first;
  const test = testEnvironment ?? "the first environment";
  const { label, stage } = summary;
  const openRun =
    run === null ? null : (
      <Button
        size="xs"
        variant="outline"
        render={<a href={run.url} target="_blank" rel="noreferrer" />}
      >
        Open run
      </Button>
    );
  const prodNotNeeded = (
    <Button
      size="xs"
      variant="outline"
      onClick={() => void finish(`Merged; ${prod} isn't needed for this change`)}
    >
      {prod} not needed
    </Button>
  );
  switch (stage) {
    case "merged":
      return [
        {
          id,
          variant: "info",
          icon: <PullRequestGlyph.merged />,
          title: `${label} merged`,
          description: `No ${test} deploy has this commit yet.`,
          actions: prodNotNeeded,
        },
      ];
    case "deploying-test":
      return [
        {
          id,
          variant: "info",
          icon: <LoaderIcon className="animate-spin" />,
          title: `${label} merged, deploying to ${test}`,
          description: run?.label,
          actions: openRun,
        },
      ];
    case "test-failed":
    case "prod-failed": {
      const environment = stage === "test-failed" ? test : prod;
      return [
        {
          id,
          variant: "error",
          icon: <CircleXIcon />,
          title: `${environment} deploy failed for ${label}`,
          description: run?.label,
          actions: (
            <>
              {openRun}
              {prodNotNeeded}
            </>
          ),
        },
      ];
    }
    case "on-test":
      return [
        {
          id,
          variant: "warning",
          icon: <PullRequestGlyph.merged />,
          title: `${label} is on ${test}, not in ${prod}`,
          description: `Ask this chat to deploy when you're ready, or say ${prod} isn't needed.`,
          actions: prodNotNeeded,
        },
      ];
    case "deploying-prod":
      return [
        {
          id,
          variant: "info",
          // Nothing runs while a run waits for approval, so no spinner.
          icon:
            run?.status === "waiting" ? (
              <PullRequestGlyph.merged />
            ) : (
              <LoaderIcon className="animate-spin" />
            ),
          title: `Deploying ${label} to ${prod}`,
          description: `${run?.label ?? ""}${run?.status === "waiting" ? " · waiting for approval" : ""}`,
          actions: openRun,
        },
      ];
    case "in-prod": {
      const dismissKey = `${threadKey}:${run?.url ?? ""}`;
      if (dismissed.includes(dismissKey)) return [];
      return [
        {
          id,
          variant: "success",
          icon: <CircleCheckIcon />,
          title: `${label} looks live in ${prod}`,
          description: `${run?.label ?? ""} passed with ${run?.headSha.slice(0, 7) ?? ""}`,
          actions: (
            <>
              <Button size="xs" onClick={() => void finish(`${label} is live in ${prod}`)}>
                Finish chat
              </Button>
              <Button size="xs" variant="ghost" onClick={() => dismissDelivery(dismissKey)}>
                Not yet
              </Button>
            </>
          ),
        },
      ];
    }
  }
}
