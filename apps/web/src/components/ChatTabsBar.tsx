import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { ClockIcon, FolderIcon, MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  moveToFront,
  type RecentTabCycle,
  startRecentTabCycle,
  stepRecentTabCycle,
} from "../chatTabCycle";
import { moveGroupId } from "../chatTabGroups";
import { localDayKey, useChatTabsStore } from "../chatTabsStore";
import { deriveProjectIdentity } from "../projectIdentity";
import { projectIconColorClassName } from "../projectIconColors";
import { useThreadActions } from "../hooks/useThreadActions";
import type { DraftId } from "../composerDraftStore";
import { useFileAutoSaveStore } from "../fileAutoSaveStore";
import { closeFileInFilesTab, closeFilesTab, filesDraftIdForThreadKey } from "../filesTabs";
import { isScratchPath, useFilesTabsStore } from "../filesTabsStore";
import { useTheme } from "../hooks/useTheme";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { useStableCallback } from "../hooks/useStableCallback";
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
import { useDraftTabsStore } from "../draftTabsStore";
import { useChatTabStrip } from "./useChatTabStrip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

const CHAT_TAB_DRAG_TYPE = "application/x-t3-chat-tab";

/**
 * Keeps a dragged group on the x axis and inside the tab strip. Unlike dnd-kit's
 * restrictToFirstScrollableAncestor, a group that is partly scrolled out doesn't jump to the edge.
 */
const restrictTabGroupToStrip: Modifier = ({
  transform,
  draggingNodeRect,
  scrollableAncestorRects,
}) => {
  const strip = scrollableAncestorRects[0];
  if (!draggingNodeRect || !strip) return { ...transform, y: 0 };
  const minX = Math.min(0, strip.left - draggingNodeRect.left);
  const maxX = Math.max(0, strip.right - draggingNodeRect.right);
  return { ...transform, x: Math.min(Math.max(transform.x, minX), maxX), y: 0 };
};
const TAB_GROUP_DRAG_MODIFIERS = [restrictTabGroupToStrip];

/**
 * Lets a plain (vertical) wheel or trackpad swipe scroll overflowing tabs sideways,
 * without holding Shift. Used as a ref callback; React 19 runs the returned cleanup.
 */
function scrollTabsWithWheel(element: HTMLDivElement | null) {
  if (!element) return;
  const onWheel = (event: WheelEvent) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (element.scrollWidth <= element.clientWidth) return;
    event.preventDefault();
    element.scrollLeft += event.deltaY;
  };
  // Not passive, so the wheel doesn't also scroll anything behind the strip.
  element.addEventListener("wheel", onWheel, { passive: false });
  return () => element.removeEventListener("wheel", onWheel);
}

export function useNavigateToThreadKey() {
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

/** A project's tabs, and the colored line under them that slides the whole group sideways. */
function SortableTabGroup(props: {
  groupId: string;
  title: string;
  lineColor: string;
  children: ReactNode;
}) {
  const { listeners, node, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.groupId });
  // dnd-kit drops the group into its slot at once, so slide it there from where it was let go.
  const [isSettling, setIsSettling] = useState(false);
  const lastDragLeft = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the group's DOM node in step with the drag; it must measure before the drop paints
  useLayoutEffect(() => {
    const element = node.current;
    if (!element || (!isDragging && lastDragLeft.current === null)) return;
    const left = element.getBoundingClientRect().left;
    if (isDragging) {
      lastDragLeft.current = left;
      return;
    }
    const distance = (lastDragLeft.current ?? left) - left;
    lastDragLeft.current = null;
    if (distance === 0) return;
    setIsSettling(true);
    const slide = element.animate(
      [{ transform: `translateX(${distance}px)` }, { transform: "translateX(0)" }],
      { duration: 200, easing: "ease" },
    );
    const settle = () => setIsSettling(false);
    slide.onfinish = settle;
    slide.oncancel = settle;
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative flex shrink-0 flex-col rounded-t-md",
        // Tabs are see-through, so the moving group needs a solid back to pass over the others.
        (isDragging || isSettling) && "z-10 bg-sidebar",
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="flex items-end gap-0.5">{props.children}</div>
      <div
        ref={setActivatorNodeRef}
        role="presentation"
        aria-label={`Move the ${props.title} tabs`}
        className="group/tab-group-line flex h-1.5 cursor-grab items-center active:cursor-grabbing [-webkit-app-region:no-drag]"
        {...listeners}
      >
        <span
          aria-hidden
          className={cn(
            "h-0.5 w-full rounded-full bg-current transition-[height] duration-150 group-hover/tab-group-line:h-1",
            props.lineColor,
            isDragging && "h-1",
          )}
        />
      </div>
    </div>
  );
}

export function ChatTabsBar() {
  const tabs = useChatTabsStore((state) => state.tabs);
  const openTab = useChatTabsStore((state) => state.openTab);
  const makePermanent = useChatTabsStore((state) => state.makePermanent);
  const closeTab = useChatTabsStore((state) => state.closeTab);
  const popClosedTab = useChatTabsStore((state) => state.popClosedTab);
  const removeTabs = useChatTabsStore((state) => state.removeTabs);
  const sweepTabs = useChatTabsStore((state) => state.sweepTabs);
  const { settleThread, unsettleThread } = useThreadActions();
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
  const setGroupOrder = useChatTabsStore((state) => state.setGroupOrder);
  // Drag a group's colored line to slide the project groups into a new order.
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const groupDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigateToThreadKey = useNavigateToThreadKey();
  const router = useRouter();
  const filesDirtyByDraftId = useFilesTabsStore((state) => state.dirtyByDraftId);
  const autoSave = useFileAutoSaveStore((state) => state.autoSave);
  const { resolvedTheme } = useTheme();
  const {
    tabGroups,
    draftTabs,
    activeThreadKey,
    routeDraftId,
    routeDraftThreadKey,
    showDraftTab,
    threadByKey,
    projectByKey,
    filesTabByThreadKey,
  } = useChatTabStrip();

  useEffect(() => {
    if (showDraftTab && routeDraftId !== null) useDraftTabsStore.getState().add(routeDraftId);
  }, [showDraftTab, routeDraftId]);
  const filesTabCwd = (files: NonNullable<ReturnType<typeof filesTabByThreadKey.get>>) =>
    files.session.worktreePath ??
    projectByKey.get(`${files.session.environmentId}:${files.session.projectId}`)?.workspaceRoot ??
    null;
  // Whatever the route shows gets a tab. A draft that just became a real thread
  // (a new chat) opens permanent; anything else reuses the preview tab.
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

  // An open tab means an unsettled chat: closing the tab settles it, and reopening it undoes that.
  const settleTabThread = (threadKey: string) => {
    const ref = parseScopedThreadKey(threadKey);
    if (!ref || !threadByKey.has(threadKey)) return;
    void settleThread(ref);
  };

  // End of the day (local time) settles the open tabs and clears the strip, like Arc. A window
  // that was closed over midnight does it on startup. Pinned and running chats keep their tab.
  const sweepTabsOfTheDay = useStableCallback(() => {
    const swept = sweepTabs(localDayKey(new Date()), (key) => {
      const thread = threadByKey.get(key);
      return (
        thread !== undefined && thread.pinnedAt == null && threadRuntimeCanArchive(thread.runtime)
      );
    });
    for (const key of swept) settleTabThread(key);
    if (activeThreadKey && swept.includes(activeThreadKey)) void navigateToThreadKey(null);
  });
  const threadsLoaded = threadByKey.size > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer to the next local midnight is outside React; threads must be loaded first so the sweep can tell running and pinned chats apart.
  useEffect(() => {
    if (!threadsLoaded) return;
    sweepTabsOfTheDay();
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = window.setTimeout(
      sweepTabsOfTheDay,
      nextMidnight.getTime() - now.getTime() + 1000,
    );
    return () => window.clearTimeout(timer);
  }, [threadsLoaded, sweepTabsOfTheDay]);

  const handleCloseTab = (threadKey: string) => {
    const files = filesTabByThreadKey.get(threadKey);
    if (files) {
      const index = tabs.findIndex((tab) => tab.threadKey === threadKey);
      const remaining = tabs.filter((tab) => tab.threadKey !== threadKey);
      const next = (remaining[index] ?? remaining[index - 1])?.threadKey ?? null;
      void closeFilesTab(files.draftId, filesTabCwd(files)).then((closed) => {
        if (closed && threadKey === activeThreadKey) void navigateToThreadKey(next);
      });
      return;
    }
    const next = closeTab(threadKey);
    settleTabThread(threadKey);
    if (threadKey === activeThreadKey) void navigateToThreadKey(next);
  };
  // Leaves the unsent chat in place (it stays in the sidebar as a draft).
  const handleCloseDraftTab = (draftId: DraftId) => {
    useDraftTabsStore.getState().remove(draftId);
    if (draftId !== routeDraftId) return;
    const lastTab = useChatTabsStore.getState().tabs.at(-1);
    if (lastTab) {
      void navigateToThreadKey(lastTab.threadKey);
      return;
    }
    const otherDraft = draftTabs.find((draft) => draft.draftId !== draftId);
    if (otherDraft) {
      void router.navigate({ to: "/draft/$draftId", params: { draftId: otherDraft.draftId } });
    }
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
      if (showDraftTab && routeDraftId !== null && (tabs.length > 0 || draftTabs.length > 1)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) handleCloseDraftTab(routeDraftId);
        return;
      }
      const current = activeThreadKey;
      // Nothing to close: let the key through (the window menu closes the window).
      if (!current || !useChatTabsStore.getState().tabs.some((tab) => tab.threadKey === current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      // In a files tab, mod+W closes the open file first, like an editor tab in VS Code.
      const files = filesTabByThreadKey.get(current);
      const activePath = files?.filesTab.relativePath ?? null;
      if (files && activePath !== null) {
        void closeFileInFilesTab(files.draftId, activePath, filesTabCwd(files));
        return;
      }
      handleCloseTab(current);
      return;
    }
    if (command === "chatTab.reopenClosed") {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const reopened = popClosedTab();
      const reopenedRef = reopened ? parseScopedThreadKey(reopened) : null;
      if (reopenedRef && threadByKey.has(reopened!)) void unsettleThread(reopenedRef);
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

  const tabGroupIds = tabGroups.map((group) => group.groupId);
  const handleGroupDragStart = ({ active }: DragStartEvent) =>
    setDraggingGroupId(String(active.id));
  const handleGroupDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingGroupId(null);
    if (!over || active.id === over.id) return;
    setGroupOrder(moveGroupId(tabGroupIds, String(active.id), String(over.id)));
  };

  if (tabs.length === 0 && draftTabs.length === 0) return null;

  return (
    // The inset that clears the window buttons and sidebar toggle stays on this outer bar,
    // so tabs scrolled to the left end at its edge instead of sliding under them.
    <div
      className={cn(
        "flex h-11 min-h-11 shrink-0 border-b border-border bg-sidebar/40 px-2",
        isElectron && "drag-region",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-chat-tabs-bar
    >
      <div
        ref={scrollTabsWithWheel}
        className={cn(
          "flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]",
          // Tabs ignore the pointer mid-drag, so they don't light up or open tooltips in passing.
          draggingGroupId !== null && "cursor-grabbing **:pointer-events-none",
        )}
      >
        <DndContext
          sensors={groupDragSensors}
          collisionDetection={closestCenter}
          modifiers={TAB_GROUP_DRAG_MODIFIERS}
          onDragStart={handleGroupDragStart}
          onDragEnd={handleGroupDragEnd}
          onDragCancel={() => setDraggingGroupId(null)}
        >
          <SortableContext items={tabGroupIds} strategy={horizontalListSortingStrategy}>
            {tabGroups.map((group) => {
              const groupProject = group.items[0]?.project;
              const lineColor = groupProject
                ? projectIconColorClassName(
                    groupProject.projectIcon && "color" in groupProject.projectIcon
                      ? groupProject.projectIcon.color
                      : deriveProjectIdentity(groupProject.title).color,
                  )
                : "text-muted-foreground/50";
              return (
                <SortableTabGroup
                  key={group.groupId}
                  groupId={group.groupId}
                  title={group.title}
                  lineColor={lineColor}
                >
                  {group.items.map(({ tab, index, thread, files, title, iconProject: project }) => {
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
                    const activePath = files?.filesTab.relativePath ?? null;
                    const filePath = activePath && !isScratchPath(activePath) ? activePath : null;
                    const unsaved =
                      files !== undefined &&
                      !autoSave &&
                      Object.keys(filesDirtyByDraftId[files.draftId] ?? {}).length > 0;
                    const tabElement = (
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
                        {isActive ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-primary"
                          />
                        ) : null}
                        {tabDropTarget?.index === index ? (
                          <span
                            aria-hidden
                            className={cn(
                              "pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary",
                              tabDropTarget.after ? "-right-px" : "-left-px",
                            )}
                          />
                        ) : null}
                        {/* One status slot: a dot on the project icon, the same signal the sidebar rail uses. */}
                        <span className="relative flex shrink-0">
                          {project ? (
                            <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                          ) : isRunning || hasUnreadCompletion ? (
                            <MessageSquareIcon
                              aria-hidden
                              className="size-3.5 text-muted-foreground"
                            />
                          ) : null}
                          {isRunning ? (
                            <span
                              role="img"
                              aria-label="Working"
                              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-info ring-2 ring-background motion-safe:animate-status-pulse"
                            />
                          ) : hasUnreadCompletion ? (
                            <span
                              role="img"
                              aria-label="Completed"
                              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-success ring-2 ring-background"
                            />
                          ) : null}
                        </span>
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
                        <span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>
                          {title}
                        </span>
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
                    if (!thread) return tabElement;
                    // Keep the wrapper while dragging: swapping it out remounts the tab and cancels the drag.
                    return (
                      <Tooltip key={tab.threadKey} disabled={draggingTabKey !== null}>
                        <TooltipTrigger delay={600} render={tabElement} />
                        <TooltipPopup side="bottom" align="start" className="max-w-72">
                          <ChatTabHoverCard
                            thread={thread}
                            title={title}
                            projectTitle={project?.title ?? null}
                            status={
                              isRunning
                                ? "Working"
                                : hasUnreadCompletion
                                  ? "Finished, not read yet"
                                  : null
                            }
                          />
                        </TooltipPopup>
                      </Tooltip>
                    );
                  })}
                </SortableTabGroup>
              );
            })}
          </SortableContext>
        </DndContext>
        {draftTabs.map((draft) => {
          const isActive = draft.draftId === routeDraftId;
          return (
            <div
              key={draft.draftId}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              aria-label={`${draft.title} (unsent)`}
              className={cn(
                "group/chat-tab relative flex h-8 max-w-56 min-w-24 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs select-none [-webkit-app-region:no-drag]",
                isActive
                  ? "border-border bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onClick={() => {
                if (!isActive) {
                  void router.navigate({
                    to: "/draft/$draftId",
                    params: { draftId: draft.draftId },
                  });
                }
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                handleCloseDraftTab(draft.draftId);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void router.navigate({
                    to: "/draft/$draftId",
                    params: { draftId: draft.draftId },
                  });
                }
              }}
            >
              {draft.project ? (
                <ProjectFavicon project={draft.project} className="size-3.5 shrink-0" />
              ) : null}
              <span className="min-w-0 flex-1 truncate italic">{draft.title}</span>
              {tabs.length > 0 || draftTabs.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Close ${draft.title}`}
                  className={cn(
                    "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    isActive ? "opacity-100" : "opacity-0 group-hover/chat-tab:opacity-100",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCloseDraftTab(draft.draftId);
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New tab"
                className="mb-1 ms-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
                onClick={() => void navigateToThreadKey(null)}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>New tab</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function usePromptCacheWarning(thread: ThreadShell): string | null {
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
  return formatPromptCacheRemaining(remainingMs);
}

/** A clock on a Claude chat's tab once its prompt cache is close to expiring; the time is in the hover card. */
function ChatTabCacheBadge({ thread }: { thread: ThreadShell }) {
  const label = usePromptCacheWarning(thread);
  if (label === null) return null;
  return (
    <ClockIcon
      role="img"
      aria-label={`Prompt cache expires in ${label}`}
      className="size-3 shrink-0 text-warning"
    />
  );
}

function ChatTabHoverCard({
  thread,
  title,
  projectTitle,
  status,
}: {
  thread: ThreadShell;
  title: string;
  projectTitle: string | null;
  status: string | null;
}) {
  const cacheLabel = usePromptCacheWarning(thread);
  return (
    <span className="flex flex-col gap-0.5 py-0.5">
      <span className="font-medium">{title}</span>
      {projectTitle ? <span className="text-muted-foreground">{projectTitle}</span> : null}
      {status ? <span>{status}</span> : null}
      {cacheLabel ? (
        <span className="text-warning">Prompt cache expires in {cacheLabel}</span>
      ) : null}
    </span>
  );
}
