import type {
  EnvironmentId,
  JiraCommand,
  JiraIssue,
  JiraSnapshot,
  ThreadId,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/** After this long without a sync, statuses may be out of date. */
export const JIRA_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function useJiraSnapshot(environmentId: EnvironmentId | null): JiraSnapshot | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.jiraLive({ environmentId, input: {} }),
  );
  return query.data ?? null;
}

export function useJiraCommand(environmentId: EnvironmentId | null) {
  const run = useAtomCommand(serverEnvironment.jiraCommand, { label: "Jira" });
  return (input: JiraCommand) =>
    environmentId === null ? Promise.resolve(null) : run({ environmentId, input });
}

export function issueByKey(snapshot: JiraSnapshot | null, key: string): JiraIssue | undefined {
  return snapshot?.issues.find((issue) => issue.key === key);
}

/** The ticket's parents, top level first. */
export function issuePath(snapshot: JiraSnapshot | null, key: string): JiraIssue[] {
  const path: JiraIssue[] = [];
  let current = issueByKey(snapshot, key)?.parentKey ?? null;
  for (let depth = 0; current !== null && depth < 6; depth += 1) {
    const parent = issueByKey(snapshot, current);
    if (parent === undefined) break;
    path.unshift(parent);
    current = parent.parentKey;
  }
  return path;
}

export function threadTicketKeys(snapshot: JiraSnapshot | null, threadId: ThreadId): string[] {
  return (snapshot?.links ?? [])
    .filter((link) => link.threadId === threadId)
    .map((link) => link.key);
}

export function ticketThreadIds(snapshot: JiraSnapshot | null, key: string): ThreadId[] {
  return (snapshot?.links ?? []).filter((link) => link.key === key).map((link) => link.threadId);
}

export function levelLabel(level: number): string {
  if (level >= 2) return "Initiative";
  if (level === 1) return "Epic";
  if (level === 0) return "Task";
  return "Sub-task";
}

export type JiraSyncHealth = "ok" | "stale" | "syncing" | "signed-out" | "problem" | "off";

export function jiraSyncHealth(snapshot: JiraSnapshot | null, now: number): JiraSyncHealth {
  if (snapshot === null || !snapshot.enabled) return "off";
  switch (snapshot.sync.status) {
    case "syncing":
      return "syncing";
    case "signed-out":
      return "signed-out";
    case "failed":
    case "unavailable":
      return "problem";
    case "off":
      return "off";
    case "never":
      return "stale";
    case "ok": {
      const at = snapshot.sync.lastSyncedAt === null ? 0 : Date.parse(snapshot.sync.lastSyncedAt);
      return now - at > JIRA_STALE_AFTER_MS ? "stale" : "ok";
    }
  }
}

export function relativeAge(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
