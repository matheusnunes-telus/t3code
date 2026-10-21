import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { ClockIcon, FolderIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  moveToFront,
  type RecentTabCycle,
  startRecentTabCycle,
  stepRecentTabCycle,
} from "../chatTabCycle";
import { useChatTabsStore } from "../chatTabsStore";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useFileAutoSaveStore } from "../fileAutoSaveStore";
import { closeFilesTab, filesDraftIdForThreadKey } from "../filesTabs";
import { useFilesTabsStore } from "../filesTabsStore";
import { useTheme } from "../hooks/useTheme";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { useStableCallback } from "../hooks/useStableCallback";
import { useProjects, useThreadShells } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  formatPromptCacheRemaining,
  PROMPT_CACHE_WARNING_MS,
  resolvePromptCacheRemainingMs,
} from "./chat/promptCache";
import type { ThreadShell } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "./Sidebar.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { primaryServerKeybindingsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

const CHAT_TAB_DRAG_TYPE = "application/x-t3-chat-tab";

function useNavigateToThreadKey() {
  const router = useRouter();
  return (threadKey: string | null) => {
    const ref = threadKey ? parseScopedThreadKey(threadKey) : null;
    if (!ref) return router.navigate({ to: "/" });
    // A files tab lives on its draft's route.
    const filesDraftId = filesDraftIdForThreadKey(threadKey!);
    if (filesDraftId)
      return router.navigate({ to: "/draft/$draftId", params: { draftId: filesDraftId } });
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ref),
    });
  };
}

/** Opens a sidebar thread as a permanent tab (double-click in the sidebar). */
export function openThreadInPermanentTab(threadRef: ScopedThreadRef) {
  useChatTabsStore.getState().openTab(scopedThreadKey(threadRef), { permanent: true });
}

export function ChatTabsBar() {
  const tabs = useChatTabsStore((state) => state.tabs);
  const openTab = useChatTabsStore((state) => state.openTab);
  const makePermanent = useChatTabsStore((state) => state.makePermanent);
  const closeTab = useChatTabsStore((state) => state.closeTab);
  const popClosedTab = useChatTabsStore((state) => state.popClosedTab);
  const removeTabs = useChatTabsStore((state) => state.removeTabs);
  const moveTab = useChatTabsStore((state) => state.moveTab);
  // Drag a tab sideways to reorder; the drop indicator sits on the hovered tab's near edge.
  const [draggingTabKey, setDraggingTabKey] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ index: number; after: boolean } | null>(
    null,
  );
  const endTabDrag = () => {
    setDraggingTabKey(null);
    setTabDropTarget(null);
  };
  const threads = useThreadShells();
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const projects = useProjects();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigateToThreadKey = useNavigateToThreadKey();
  const routeTarget = useThreadRouteTarget();
  const filesTabsByDraftId = useFilesTabsStore((state) => state.tabsByDraftId);
  const filesDirtyByDraftId = useFilesTabsStore((state) => state.dirtyByDraftId);
  const autoSave = useFileAutoSaveStore((state) => state.autoSave);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const { resolvedTheme } = useTheme();
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

  // Whatever the route shows gets a tab. A draft that just became a real thread
  // (a new chat) opens permanent; anything else reuses the preview tab.
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
  const draftProject = routeDraftProjectKey ? projectByKey.get(routeDraftProjectKey) : undefined;
  const lastDraftThreadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (routeDraftThreadKey) lastDraftThreadKeyRef.current = routeDraftThreadKey;
  }, [routeDraftThreadKey]);
  useEffect(() => {
    if (!activeThreadKey) return;
    const promotedFromDraft = lastDraftThreadKeyRef.current === activeThreadKey;
    if (promotedFromDraft) lastDraftThreadKeyRef.current = null;
    openTab(activeThreadKey, { permanent: promotedFromDraft });
  }, [activeThreadKey, openTab]);

  // Archived threads leave the tab strip.
  const archivedTabKeys = tabs
    .filter((tab) => threadByKey.get(tab.threadKey)?.archivedAt != null)
    .map((tab) => tab.threadKey);
  const archivedTabKeysSignature = archivedTabKeys.join("|");
  useEffect(() => {
    if (archivedTabKeysSignature.length === 0) return;
    removeTabs(new Set(archivedTabKeysSignature.split("|")));
  }, [archivedTabKeysSignature, removeTabs]);

  // Most recently used tab first. Ctrl+Tab walks back through it while Ctrl stays down,
  // and the tab you stop on becomes the most recent one when Ctrl is released.
  const recentTabKeysRef = useRef<string[]>([]);
  const recentCycleRef = useRef<RecentTabCycle | null>(null);
  useEffect(() => {
    if (!activeThreadKey || recentCycleRef.current) return;
    recentTabKeysRef.current = moveToFront(recentTabKeysRef.current, activeThreadKey);
  }, [activeThreadKey]);
  const cycleRecentTab = (direction: 1 | -1) => {
    const started =
      recentCycleRef.current ??
      startRecentTabCycle(
        recentTabKeysRef.current,
        useChatTabsStore.getState().tabs.map((tab) => tab.threadKey),
        activeThreadKey,
      );
    const cycle = stepRecentTabCycle(started, direction);
    recentCycleRef.current = cycle;
    if (cycle !== started) void navigateToThreadKey(cycle.keys[cycle.index] ?? null);
  };
  const finishRecentCycle = useStableCallback(() => {
    const cycle = recentCycleRef.current;
    if (!cycle) return;
    recentCycleRef.current = null;
    const key = cycle.keys[cycle.index];
    if (key) recentTabKeysRef.current = moveToFront(recentTabKeysRef.current, key);
  });
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") finishRecentCycle();
    };
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", finishRecentCycle);
    return () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", finishRecentCycle);
    };
  }, [finishRecentCycle]);

  const handleCloseTab = (threadKey: string) => {
    const files = filesTabByThreadKey.get(threadKey);
    if (files) {
      const index = tabs.findIndex((tab) => tab.threadKey === threadKey);
      const remaining = tabs.filter((tab) => tab.threadKey !== threadKey);
      const next = (remaining[index] ?? remaining[index - 1])?.threadKey ?? null;
      const cwd =
        files.session.worktreePath ??
        projectByKey.get(`${files.session.environmentId}:${files.session.projectId}`)
          ?.workspaceRoot ??
        null;
      void closeFilesTab(files.draftId, cwd).then((closed) => {
        if (closed && threadKey === activeThreadKey) void navigateToThreadKey(next);
      });
      return;
    }
    const next = closeTab(threadKey);
    if (threadKey === activeThreadKey) void navigateToThreadKey(next);
  };
  // Leaves the unsent chat in place (it stays in the sidebar as a draft).
  const handleCloseDraftTab = () => {
    const lastTab = useChatTabsStore.getState().tabs.at(-1);
    if (lastTab) void navigateToThreadKey(lastTab.threadKey);
  };
  const onKeyDown = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen()) return;
    if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]")) {
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        previewFocus: isPreviewFocused(),
        editableFocus: isEditableFocused(event.target),
      },
    });
    if (command === "chatTab.close") {
      if (showDraftTab && useChatTabsStore.getState().tabs.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) handleCloseDraftTab();
        return;
      }
      const current = activeThreadKey;
      // Nothing to close: let the key through (the window menu closes the window).
      if (!current || !useChatTabsStore.getState().tabs.some((tab) => tab.threadKey === current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) handleCloseTab(current);
      return;
    }
    if (command === "chatTab.reopenClosed") {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const reopened = popClosedTab();
      if (reopened) void navigateToThreadKey(reopened);
      return;
    }
    if (command === "chatTab.cycleRecent" || command === "chatTab.cycleRecentReverse") {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) cycleRecentTab(command === "chatTab.cycleRecent" ? 1 : -1);
      return;
    }
    if (command === "chatTab.new") {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void navigateToThreadKey(null);
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onKeyDown]);

  if (tabs.length === 0 && !showDraftTab) return null;

  return (
    <div
      className={cn(
        "flex h-11 min-h-11 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-sidebar/40 px-2 [scrollbar-width:none]",
        isElectron && "drag-region",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-chat-tabs-bar
    >
      {tabs.map((tab, index) => {
        const thread = threadByKey.get(tab.threadKey);
        const isActive = tab.threadKey === activeThreadKey;
        const isRunning = thread ? !threadRuntimeCanArchive(thread.runtime) : false;
        const hasUnreadCompletion =
          thread !== undefined &&
          resolveThreadStatusPill({
            thread: {
              ...thread,
              lastVisitedAt: resolveThreadLastVisitedAt(
                thread.lastVisitedAt,
                threadLastVisitedAtById[tab.threadKey],
              ),
            },
          })?.label === "Completed";
        const files = thread ? undefined : filesTabByThreadKey.get(tab.threadKey);
        const projectKey = thread
          ? (`${thread.environmentId}:${thread.projectId}` as const)
          : files
            ? (`${files.session.environmentId}:${files.session.projectId}` as const)
            : null;
        const project = projectKey ? projectByKey.get(projectKey) : undefined;
        const filePath = files?.filesTab.relativePath ?? null;
        const title =
          thread?.title ??
          (files
            ? filePath
              ? (filePath.split("/").at(-1) ?? filePath)
              : `${project?.title ?? "Project"} files`
            : "Unavailable thread");
        const unsaved =
          files !== undefined && !autoSave && filesDirtyByDraftId[files.draftId] === true;
        return (
          <div
            key={tab.threadKey}
            role="tab"
            tabIndex={0}
            draggable
            aria-selected={isActive}
            aria-label={tab.preview ? `${title} (preview)` : title}
            className={cn(
              "group/chat-tab relative flex h-8 max-w-56 min-w-24 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs select-none [-webkit-app-region:no-drag]",
              isActive
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              draggingTabKey === tab.threadKey && "opacity-50",
              tabDropTarget?.index === index &&
                (tabDropTarget.after
                  ? "shadow-[inset_-2px_0_0_0_var(--color-primary)]"
                  : "shadow-[inset_2px_0_0_0_var(--color-primary)]"),
            )}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(CHAT_TAB_DRAG_TYPE, tab.threadKey);
              setDraggingTabKey(tab.threadKey);
            }}
            onDragOver={(event) => {
              if (!draggingTabKey) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              const after = event.clientX > rect.left + rect.width / 2;
              if (tabDropTarget?.index !== index || tabDropTarget.after !== after) {
                setTabDropTarget({ index, after });
              }
            }}
            onDragLeave={() => setTabDropTarget(null)}
            onDrop={(event) => {
              if (!draggingTabKey) return;
              event.preventDefault();
              const fromIndex = tabs.findIndex(
                (candidate) => candidate.threadKey === draggingTabKey,
              );
              const after = tabDropTarget?.after ?? false;
              let toIndex = index + (after ? 1 : 0);
              if (fromIndex !== -1 && fromIndex < toIndex) toIndex -= 1;
              moveTab(draggingTabKey, toIndex);
              endTabDrag();
            }}
            onDragEnd={endTabDrag}
            onClick={() => {
              if (!isActive) void navigateToThreadKey(tab.threadKey);
            }}
            onDoubleClick={() => makePermanent(tab.threadKey)}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              handleCloseTab(tab.threadKey);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void navigateToThreadKey(tab.threadKey);
              }
            }}
          >
            {isRunning ? (
              <span className="size-1.5 shrink-0 motion-safe:animate-status-pulse rounded-full bg-info" />
            ) : hasUnreadCompletion ? (
              <span
                role="img"
                aria-label="Completed"
                className="size-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-300/90"
              />
            ) : null}
            {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
            {files ? (
              // A folder marks a files tab apart from chats, then the open file's type.
              <>
                <FolderIcon className="size-3 shrink-0 text-muted-foreground" />
                {filePath ? (
                  <PierreEntryIcon
                    pathValue={filePath}
                    kind="file"
                    theme={resolvedTheme}
                    className="size-3.5 shrink-0"
                  />
                ) : null}
              </>
            ) : null}
            <span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>{title}</span>
            {thread ? <ChatTabCacheBadge thread={thread} /> : null}
            {unsaved ? (
              <span
                role="img"
                aria-label="Unsaved changes"
                className="size-1.5 shrink-0 rounded-full bg-foreground/80"
              />
            ) : null}
            <button
              type="button"
              aria-label={`Close ${title}`}
              className={cn(
                "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                isActive ? "opacity-100" : "opacity-0 group-hover/chat-tab:opacity-100",
              )}
              onClick={(event) => {
                event.stopPropagation();
                handleCloseTab(tab.threadKey);
              }}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
      {showDraftTab ? (
        <div
          role="tab"
          aria-selected
          aria-label="New chat"
          className="relative flex h-8 max-w-56 min-w-24 shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 border-border bg-background px-2.5 text-xs text-foreground select-none [-webkit-app-region:no-drag]"
        >
          {draftProject ? (
            <ProjectFavicon project={draftProject} className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate italic">New chat</span>
          {tabs.length > 0 ? (
            <button
              type="button"
              aria-label="Close New chat"
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleCloseDraftTab}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Shows how long a Claude chat's prompt cache has left, once it is close to expiring. */
function ChatTabCacheBadge({ thread }: { thread: ThreadShell }) {
  const nowIso = useNowMinute();
  const driver = useAtomValue(
    serverEnvironment.providersValueAtom(thread.environmentId),
    (providers) =>
      providers?.find((provider) => provider.instanceId === thread.providerInstanceId)?.driver,
  );
  const remainingMs = resolvePromptCacheRemainingMs({ thread, driver, nowIso });
  if (remainingMs === null || remainingMs <= 0 || remainingMs > PROMPT_CACHE_WARNING_MS) {
    return null;
  }
  const label = formatPromptCacheRemaining(remainingMs);
  return (
    <span
      role="img"
      aria-label={`Prompt cache expires in ${label}`}
      title={`Prompt cache expires in ${label}`}
      className="inline-flex shrink-0 items-center gap-0.5 text-3xs tabular-nums text-warning-foreground"
    >
      <ClockIcon className="size-3" />
      {label.replace(" min", "m")}
    </span>
  );
}
