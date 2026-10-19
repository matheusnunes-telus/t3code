import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useChatTabsStore } from "../chatTabsStore";
import { useComposerDraftStore } from "../composerDraftStore";
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
import { useUiStateStore } from "../uiStateStore";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "./Sidebar.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { primaryServerKeybindingsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

function useNavigateToThreadKey() {
  const router = useRouter();
  return (threadKey: string | null) => {
    const ref = threadKey ? parseScopedThreadKey(threadKey) : null;
    if (!ref) return router.navigate({ to: "/" });
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
  const threads = useThreadShells();
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const projects = useProjects();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigateToThreadKey = useNavigateToThreadKey();
  const routeTarget = useThreadRouteTarget();
  const activeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
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

  const handleCloseTab = (threadKey: string) => {
    const next = closeTab(threadKey);
    if (threadKey === activeThreadKey) void navigateToThreadKey(next);
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

  if (tabs.length === 0) return null;

  return (
    <div
      className={cn(
        "flex h-9 min-h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-sidebar/40 px-2 [scrollbar-width:none]",
        isElectron && "drag-region",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-chat-tabs-bar
    >
      {tabs.map((tab) => {
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
        const title = thread?.title ?? "Unavailable thread";
        const project = thread
          ? projectByKey.get(`${thread.environmentId}:${thread.projectId}`)
          : undefined;
        return (
          <div
            key={tab.threadKey}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            aria-label={tab.preview ? `${title} (preview)` : title}
            className={cn(
              "group/chat-tab relative flex h-8 max-w-56 min-w-24 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs select-none [-webkit-app-region:no-drag]",
              isActive
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
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
              <span className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-info" />
            ) : hasUnreadCompletion ? (
              <span
                role="img"
                aria-label="Completed"
                className="size-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-300/90"
              />
            ) : null}
            {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
            <span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>{title}</span>
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
    </div>
  );
}
