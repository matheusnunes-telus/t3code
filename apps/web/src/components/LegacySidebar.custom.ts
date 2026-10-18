import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { sortThreads } from "../lib/threadSort";
import type { SidebarThreadSummary } from "../types";

export function isThreadSettled(thread: SidebarThreadSummary): boolean {
  return thread.settledOverride === "settled";
}

export function isThreadPinned(thread: SidebarThreadSummary): boolean {
  return thread.pinnedAt != null;
}

/** Pinned threads first (in their pin order), then the rest in the chosen sort. */
export function orderProjectThreads(
  threads: readonly SidebarThreadSummary[],
  sortOrder: SidebarThreadSortOrder,
): SidebarThreadSummary[] {
  const visible = threads.filter((thread) => thread.archivedAt === null);
  const pinned = visible.filter(isThreadPinned);
  const unpinned = visible.filter((thread) => !isThreadPinned(thread));
  return [...sortPinnedThreadsByOrderKey(pinned), ...sortThreads(unpinned, sortOrder)];
}

function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+$/, "");
}

function isInsideFolder(child: string, parent: string): boolean {
  const normalizedChild = normalizeRoot(child);
  const normalizedParent = normalizeRoot(parent);
  return (
    normalizedChild !== normalizedParent &&
    (normalizedChild.startsWith(`${normalizedParent}/`) ||
      normalizedChild.startsWith(`${normalizedParent}\\`))
  );
}

/**
 * Folder sub-projects: a project whose folder sits inside another project's folder
 * renders under that project (its closest ancestor). Order is kept from the input.
 */
export function nestProjectsByFolder<T extends { projectKey: string; workspaceRoot: string }>(
  projects: readonly T[],
  detachedProjectKeys: Readonly<Record<string, true>>,
): { topLevelProjects: T[]; childProjectsByKey: ReadonlyMap<string, T[]> } {
  const parentKeyByKey = new Map<string, string>();
  for (const project of projects) {
    if (detachedProjectKeys[project.projectKey]) continue;
    let parent: T | null = null;
    for (const candidate of projects) {
      if (!isInsideFolder(project.workspaceRoot, candidate.workspaceRoot)) continue;
      if (!parent || candidate.workspaceRoot.length > parent.workspaceRoot.length) {
        parent = candidate;
      }
    }
    if (parent) parentKeyByKey.set(project.projectKey, parent.projectKey);
  }
  const childProjectsByKey = new Map<string, T[]>();
  const topLevelProjects: T[] = [];
  for (const project of projects) {
    const parentKey = parentKeyByKey.get(project.projectKey);
    if (parentKey === undefined) {
      topLevelProjects.push(project);
      continue;
    }
    const siblings = childProjectsByKey.get(parentKey);
    if (siblings) siblings.push(project);
    else childProjectsByKey.set(parentKey, [project]);
  }
  return { topLevelProjects, childProjectsByKey };
}

/** Pinned threads never hide behind "Show more"; only unpinned ones count toward the limit. */
export function selectPreviewThreads(
  orderedThreads: readonly SidebarThreadSummary[],
  previewCount: number,
  showAll: boolean,
): { previewThreads: SidebarThreadSummary[]; hasOverflowingThreads: boolean } {
  const pinned = orderedThreads.filter(isThreadPinned);
  const unpinned = orderedThreads.filter((thread) => !isThreadPinned(thread));
  const hasOverflowingThreads = unpinned.length > previewCount;
  return {
    previewThreads:
      showAll || !hasOverflowingThreads
        ? [...orderedThreads]
        : [...pinned, ...unpinned.slice(0, previewCount)],
    hasOverflowingThreads,
  };
}
