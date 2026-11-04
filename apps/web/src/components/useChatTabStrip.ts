import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import { groupTabs, SCRATCH_TAB_GROUP_ID } from "../chatTabGroups";
import { useChatTabsStore } from "../chatTabsStore";
import {
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useDraftTabsStore } from "../draftTabsStore";
import { filesTabTitle, useFilesTabsStore } from "../filesTabsStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";

/**
 * What the tab strip shows, in order: the project groups, then the unsent drafts. The top bar
 * and the collapsed sidebar rail both read this, so the two can't drift apart. It only derives
 * values; the effects that open and close tabs stay in ChatTabsBar.
 */
export function useChatTabStrip() {
  const tabs = useChatTabsStore((state) => state.tabs);
  const groupOrder = useChatTabsStore((state) => state.groupOrder);
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const projects = useProjects();
  const routeTarget = useThreadRouteTarget();
  const filesTabsByDraftId = useFilesTabsStore((state) => state.tabsByDraftId);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const routeIsFilesTab =
    routeTarget?.kind === "draft" && filesTabsByDraftId[routeTarget.draftId] !== undefined;
  const threadByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );

  const routeDraftThreadKey = useComposerDraftStore((store) => {
    if (routeTarget?.kind !== "draft") return null;
    const draft = store.getDraftSession(routeTarget.draftId);
    return draft ? scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId)) : null;
  });
  // A new chat that hasn't been sent yet shows as a temporary "New chat" tab at the
  // end of the strip. Sending it turns it into the real chat's tab in the same spot.
  const routeDraftProjectKey = useComposerDraftStore((store) => {
    if (routeTarget?.kind !== "draft") return null;
    const draft = store.getDraftSession(routeTarget.draftId);
    return draft ? (`${draft.environmentId}:${draft.projectId}` as const) : null;
  });
  const showDraftTab = routeDraftProjectKey !== null && !routeIsFilesTab;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  // Unsent chats opened this session keep their tab after you leave them, if something is
  // typed, so the text is one click away. Closing one hides its tab; the draft stays in the sidebar.
  const openedDraftIds = useDraftTabsStore((state) => state.draftIds);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const draftTabs = Object.entries(draftThreadsByThreadKey)
    .filter(([draftId, session]) =>
      draftId === routeDraftId
        ? showDraftTab
        : session.promotedTo == null &&
          filesTabsByDraftId[draftId] === undefined &&
          openedDraftIds.has(draftId) &&
          composerDraftHasUserContent(draftsByThreadKey[draftId]),
    )
    .toSorted(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt))
    .map(([draftId, session]) => ({
      draftId: draftId as DraftId,
      project: projectByKey.get(`${session.environmentId}:${session.projectId}`),
      title: draftsByThreadKey[draftId]?.prompt.trim().split("\n")[0]?.slice(0, 60) || "New chat",
    }));
  // A files tab is a draft, so its route is the draft's.
  const activeThreadKey =
    routeTarget?.kind === "server"
      ? scopedThreadKey(routeTarget.threadRef)
      : routeIsFilesTab
        ? routeDraftThreadKey
        : null;
  const filesTabByThreadKey = new Map(
    Object.entries(filesTabsByDraftId).flatMap(([draftId, filesTab]) => {
      const session = draftThreadsByThreadKey[draftId];
      if (!session) return [];
      const key = scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId));
      return [[key, { draftId: draftId as DraftId, session, filesTab }] as const];
    }),
  );

  // One group per project; chats without a project (the scratch project) are their own group.
  const tabGroups = groupTabs(
    tabs.map((tab, index) => {
      const thread = threadByKey.get(tab.threadKey);
      const files = thread ? undefined : filesTabByThreadKey.get(tab.threadKey);
      const projectRef = thread ?? files?.session;
      const iconProject = projectRef
        ? projectByKey.get(`${projectRef.environmentId}:${projectRef.projectId}`)
        : undefined;
      const scratchRoot = projectRef
        ? (environments.find(
            (environment) => environment.environmentId === projectRef.environmentId,
          )?.serverConfig?.scratchWorkspaceRoot ?? null)
        : null;
      const isScratch = iconProject !== undefined && isScratchProject(iconProject, scratchRoot);
      const groupId =
        isScratch || !iconProject || !projectRef
          ? SCRATCH_TAB_GROUP_ID
          : `${projectRef.environmentId}:${projectRef.projectId}`;
      const activePath = files?.filesTab.relativePath ?? null;
      const title =
        thread?.title ??
        (files
          ? activePath
            ? filesTabTitle(activePath)
            : `${iconProject?.title ?? "Project"} files`
          : "Unavailable thread");
      return {
        groupId,
        title: isScratch || !iconProject ? "No project" : iconProject.title,
        item: {
          tab,
          index,
          thread,
          files,
          title,
          iconProject,
          project: isScratch ? undefined : iconProject,
        },
      };
    }),
    groupOrder,
  );

  return {
    tabGroups,
    draftTabs,
    activeThreadKey,
    routeDraftId,
    routeDraftThreadKey,
    showDraftTab,
    threadByKey,
    projectByKey,
    filesTabByThreadKey,
  };
}
