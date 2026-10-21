import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { FolderGit2Icon, FolderIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useFileAutoSaveStore } from "~/fileAutoSaveStore";
import { useFilesTabsStore } from "~/filesTabsStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useRightPanelStore } from "~/rightPanelStore";

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
  const dirty = useFilesTabsStore((state) => state.dirtyByDraftId[draftId] === true);
  const autoSave = useFileAutoSaveStore((state) => state.autoSave);
  const setAutoSave = useFileAutoSaveStore((state) => state.setAutoSave);
  const worktreePath = useComposerDraftStore(
    (store) => store.getDraftSession(draftId)?.worktreePath ?? null,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  // The save session restarts when this changes identity, so it must stay stable.
  const handlePendingChange = useStableCallback((_path: string, pending: boolean) =>
    setDirty(draftId, pending),
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
      {tab?.relativePath ? (
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${props.environmentId}:${props.cwd}`}
            environmentId={props.environmentId}
            cwd={props.cwd}
            projectName={props.projectName}
            relativePath={tab.relativePath}
            threadRef={threadRef}
            composerDraftTarget={draftId}
            keybindings={props.keybindings}
            availableEditors={props.availableEditors}
            openInShortcutEnabled
            revealLine={tab.revealLine}
            revealRequestId={tab.revealRequestId}
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
          <p>Pick a file from the Files panel to open it here.</p>
          <Button type="button" variant="outline" size="sm" onClick={showProjectFiles}>
            Show files
          </Button>
        </div>
      )}
    </div>
  );
}
