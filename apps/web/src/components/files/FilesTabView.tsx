import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  FilePlusIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  NotebookPenIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useFileAutoSaveStore } from "~/fileAutoSaveStore";
import { closeFileInFilesTab } from "~/filesTabs";
import {
  type FilesTabState,
  filesTabTitle,
  isScratchPath,
  scratchKey,
  useFilesTabsStore,
} from "~/filesTabsStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { FileScratchpad } from "./FileScratchpad";

import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FilePreviewPanel = lazy(() => import("./FilePreviewPanel"));

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? path
  );
}

const FILES_EDITOR_TAB_DRAG_TYPE = "application/x-t3-files-editor-tab";

/** Lets a plain wheel scroll overflowing editor tabs sideways, as in the chat tab bar. */
function scrollTabsWithWheel(element: HTMLDivElement | null) {
  if (!element) return;
  const onWheel = (event: WheelEvent) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (element.scrollWidth <= element.clientWidth) return;
    event.preventDefault();
    element.scrollLeft += event.deltaY;
  };
  element.addEventListener("wheel", onWheel, { passive: false });
  return () => element.removeEventListener("wheel", onWheel);
}

/** VS Code style editor tabs: italic preview tab, a dot for unsaved work that turns into ×. */
function FilesEditorTabs({
  draftId,
  cwd,
  tab,
}: {
  draftId: DraftId;
  cwd: string;
  tab: FilesTabState;
}) {
  const openFile = useFilesTabsStore((state) => state.openFile);
  const pin = useFilesTabsStore((state) => state.pin);
  const moveFile = useFilesTabsStore((state) => state.moveFile);
  const newScratch = useFilesTabsStore((state) => state.newScratch);
  const dirty = useFilesTabsStore((state) => state.dirtyByDraftId[draftId]);
  const scratchByKey = useFilesTabsStore((state) => state.scratchByKey);
  const autoSave = useFileAutoSaveStore((state) => state.autoSave);
  const { resolvedTheme } = useTheme();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; after: boolean } | null>(null);
  const close = (path: string) => void closeFileInFilesTab(draftId, path, cwd);

  return (
    <div className="flex h-9 min-h-9 shrink-0 items-end border-b border-border/60 bg-sidebar/30 px-1.5">
      <div
        ref={scrollTabsWithWheel}
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        {tab.openPaths.map((path, index) => {
          const active = path === tab.relativePath;
          const scratch = isScratchPath(path);
          const unsaved = scratch
            ? (scratchByKey[scratchKey(draftId, path)] ?? "") !== ""
            : !autoSave && dirty?.[path] === true;
          const title = filesTabTitle(path);
          return (
            <Tooltip key={path}>
              <TooltipTrigger
                delay={600}
                render={
                  <div
                    role="tab"
                    tabIndex={0}
                    draggable
                    aria-selected={active}
                    aria-label={tab.previewPath === path ? `${title} (preview)` : title}
                    className={cn(
                      "group/editor-tab relative flex h-7.5 max-w-52 min-w-20 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 ps-2 pe-1 text-xs select-none",
                      active
                        ? "-mb-px h-8 border-border/60 bg-background text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      dragging === path && "opacity-50",
                    )}
                    onClick={() => {
                      if (!active) openFile(draftId, path);
                    }}
                    onDoubleClick={() => pin(draftId, path)}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      close(path);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openFile(draftId, path);
                      }
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(FILES_EDITOR_TAB_DRAG_TYPE, path);
                      setDragging(path);
                    }}
                    onDragOver={(event) => {
                      if (dragging === null) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const after = event.clientX > rect.left + rect.width / 2;
                      if (dropTarget?.index !== index || dropTarget.after !== after) {
                        setDropTarget({ index, after });
                      }
                    }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(event) => {
                      if (dragging === null) return;
                      event.preventDefault();
                      const from = tab.openPaths.indexOf(dragging);
                      let to = index + (dropTarget?.after ? 1 : 0);
                      if (from !== -1 && from < to) to -= 1;
                      moveFile(draftId, dragging, to);
                      setDragging(null);
                      setDropTarget(null);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  />
                }
              >
                {active ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-primary"
                  />
                ) : null}
                {dropTarget?.index === index ? (
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary",
                      dropTarget.after ? "-right-px" : "-left-px",
                    )}
                  />
                ) : null}
                {scratch ? (
                  <NotebookPenIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <PierreEntryIcon
                    pathValue={path}
                    kind="file"
                    theme={resolvedTheme}
                    className="size-3.5 shrink-0"
                  />
                )}
                <span
                  className={cn("min-w-0 flex-1 truncate", tab.previewPath === path && "italic")}
                >
                  {title}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  className={cn(
                    "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    !active && !unsaved && "opacity-0 group-hover/editor-tab:opacity-100",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    close(path);
                  }}
                >
                  {unsaved ? (
                    <span
                      aria-hidden
                      className="size-2 rounded-full bg-foreground/70 group-hover/editor-tab:hidden"
                    />
                  ) : null}
                  <XIcon
                    aria-hidden
                    className={cn("size-3", unsaved && "hidden group-hover/editor-tab:block")}
                  />
                </button>
              </TooltipTrigger>
              <TooltipPopup side="bottom" align="start">
                {scratch ? `${title}, not saved to disk` : path}
                {tab.previewPath === path ? " · preview, double-click to keep" : ""}
              </TooltipPopup>
            </Tooltip>
          );
        })}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="New file"
                className="mb-0.5 ms-1"
                onClick={() => newScratch(draftId)}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup>New file (a scratchpad)</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The main area of a files tab: which checkout it reads (worktree and branch),
 * the auto-save switch, and the open file, full size and editable.
 */
export function FilesTabView(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  draftId: DraftId;
  /** The folder files are read from: the draft's worktree, or the project folder. */
  cwd: string;
  projectName: string;
  isGitRepo: boolean;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  workspaceMutationId: string | null;
}) {
  const { draftId, threadRef } = props;
  const tab = useFilesTabsStore((state) => state.tabsByDraftId[draftId]);
  const setDirty = useFilesTabsStore((state) => state.setDirty);
  const openFile = useFilesTabsStore((state) => state.openFile);
  const newScratch = useFilesTabsStore((state) => state.newScratch);
  const activePath = tab?.relativePath ?? null;
  const dirty = useFilesTabsStore(
    (state) => activePath !== null && state.dirtyByDraftId[draftId]?.[activePath] === true,
  );
  const autoSave = useFileAutoSaveStore((state) => state.autoSave);
  const setAutoSave = useFileAutoSaveStore((state) => state.setAutoSave);
  const worktreePath = useComposerDraftStore(
    (store) => store.getDraftSession(draftId)?.worktreePath ?? null,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  // The save session restarts when this changes identity, so it must stay stable.
  const handlePendingChange = useStableCallback((path: string, pending: boolean) =>
    setDirty(draftId, path, pending),
  );
  const showProjectFiles = () => useRightPanelStore.getState().openFile(threadRef, ".");

  return (
    // The end padding of the bar clears the thread details button floating over this corner.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-files-tab>
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 ps-3 pe-14 text-xs text-muted-foreground">
        {worktreePath ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 py-0.5 ps-2 pe-0.5 text-foreground">
            <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{folderName(worktreePath)}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Use the project folder"
                    onClick={() =>
                      setDraftThreadContext(draftId, { worktreePath: null, envMode: "local" })
                    }
                  />
                }
              >
                <XIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup>Use the project folder</TooltipPopup>
            </Tooltip>
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <FolderIcon className="size-3.5" />
            Project folder
          </span>
        )}
        {props.isGitRepo ? (
          <BranchToolbarBranchSelector
            className="min-w-0 flex-initial"
            environmentId={props.environmentId}
            threadId={threadRef.threadId}
            draftId={draftId}
            envLocked={false}
            effectiveEnvModeOverride="local"
            startFromOrigin={false}
            onStartFromOriginChange={() => {}}
          />
        ) : null}
        <label className="ms-auto flex shrink-0 cursor-pointer items-center gap-2">
          Auto-save
          <Switch size="sm" checked={autoSave} onCheckedChange={setAutoSave} />
        </label>
      </div>
      {tab && tab.openPaths.length > 0 ? (
        <FilesEditorTabs draftId={draftId} cwd={props.cwd} tab={tab} />
      ) : null}
      {activePath !== null && isScratchPath(activePath) ? (
        <FileScratchpad key={activePath} draftId={draftId} path={activePath} />
      ) : activePath !== null ? (
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${props.environmentId}:${props.cwd}`}
            environmentId={props.environmentId}
            cwd={props.cwd}
            projectName={props.projectName}
            relativePath={activePath}
            threadRef={threadRef}
            composerDraftTarget={draftId}
            keybindings={props.keybindings}
            availableEditors={props.availableEditors}
            openInShortcutEnabled
            revealLine={tab?.revealLine ?? null}
            revealRequestId={tab?.revealRequestId ?? 0}
            onOpenFile={(relativePath) => openFile(draftId, relativePath)}
            onNavigateFolder={showProjectFiles}
            folderTrail={undefined}
            onPendingChange={handlePendingChange}
            selectedFilePending={dirty}
            workspaceMutationId={props.workspaceMutationId}
            hideExplorer
          />
        </Suspense>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
          <FolderOpenIcon className="size-8 text-muted-foreground/60" />
          <p>No open files. Start a scratchpad, or pick a file from the Files panel.</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => newScratch(draftId)}>
              <FilePlusIcon />
              New file
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={showProjectFiles}>
              Show files
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
