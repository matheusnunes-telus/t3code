import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useChatTabsStore } from "./chatTabsStore";
import {
  type DraftId,
  setComposerDraftSessionKeeper,
  useComposerDraftStore,
} from "./composerDraftStore";
import { useFileAutoSaveStore } from "./fileAutoSaveStore";
import {
  filesTabPathUnsaved,
  filesTabTitle,
  isFilesDraft,
  isScratchPath,
  useFilesTabsStore,
} from "./filesTabsStore";
import { clearProjectFileQueryData } from "./components/files/projectFilesQueryState";
import { readLocalApi } from "./localApi";
import { setRightPanelFileOpenInterceptor, useRightPanelStore } from "./rightPanelStore";

// Actions for files tabs (see filesTabsStore). Importing this module also hooks
// files tabs into the draft store and the right panel.

export function filesDraftIdForRef(ref: ScopedThreadRef): DraftId | null {
  const draftId = useComposerDraftStore.getState().getDraftIdByRef(ref);
  return draftId && isFilesDraft(draftId) ? draftId : null;
}

export function filesDraftIdForThreadKey(threadKey: string): DraftId | null {
  const ref = parseScopedThreadKey(threadKey);
  return ref ? filesDraftIdForRef(ref) : null;
}

// Files tabs have no message or project mapping, so the draft store would otherwise
// drop their sessions on restart.
setComposerDraftSessionKeeper(isFilesDraft);

// A file opened from a files tab's right panel (tree, search, file picker) shows in
// the main area instead, as a preview tab; "." still opens the explorer itself.
setRightPanelFileOpenInterceptor((ref, relativePath, line) => {
  if (relativePath === ".") return false;
  const draftId = filesDraftIdForRef(ref);
  if (!draftId) return false;
  useFilesTabsStore.getState().openFile(draftId, relativePath, line);
  return true;
});

/** Turns the new chat on screen into a files tab and opens the project's files beside it. */
export function convertDraftToFilesTab(draftId: DraftId) {
  const draftStore = useComposerDraftStore.getState();
  const session = draftStore.getDraftSession(draftId);
  if (!session) return;
  useFilesTabsStore.getState().enable(draftId);
  // Unlink it from its project, so the next new chat there starts a fresh draft.
  useComposerDraftStore.setState((state) => {
    const entries = Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey);
    if (!entries.some(([, key]) => key === draftId)) return state;
    return {
      logicalProjectDraftThreadKeyByLogicalProjectKey: Object.fromEntries(
        entries.filter(([, key]) => key !== draftId),
      ),
    };
  });
  // A worktree that would only be created on send can't hold files yet.
  if (session.envMode === "worktree" && session.worktreePath === null) {
    draftStore.setDraftThreadContext(draftId, { envMode: "local" });
  }
  const threadRef = scopeThreadRef(session.environmentId, session.threadId);
  useChatTabsStore.getState().openTab(scopedThreadKey(threadRef), { permanent: true });
  useRightPanelStore.getState().openFile(threadRef, ".");
}

const unsavedMessage = (names: readonly string[]) =>
  names.length === 1
    ? `${names[0]} has unsaved changes. Close it without saving?`
    : `${names.length} files have unsaved changes. Close them without saving?`;

/**
 * Closes one editor tab of a files tab. Without auto-save, unsaved edits ask first, as does
 * a scratchpad with text. Returns false when the user keeps it.
 */
export async function closeFileInFilesTab(
  draftId: DraftId,
  path: string,
  cwd: string | null,
): Promise<boolean> {
  const autoSave = useFileAutoSaveStore.getState().autoSave;
  if (filesTabPathUnsaved(draftId, path, autoSave)) {
    const confirmed =
      (await readLocalApi()?.dialogs.confirm(unsavedMessage([filesTabTitle(path)]), {
        variant: "destructive",
      })) ?? true;
    if (!confirmed) return false;
    const session = useComposerDraftStore.getState().getDraftSession(draftId);
    if (session && cwd && !isScratchPath(path)) {
      clearProjectFileQueryData(session.environmentId, cwd, path);
    }
  }
  useFilesTabsStore.getState().closeFile(draftId, path);
  return true;
}

/**
 * Closes a files tab and deletes its draft. Without auto-save, unsaved edits ask first,
 * and closing anyway drops them; so does scratchpad text. Returns false when the user keeps the tab.
 */
export async function closeFilesTab(draftId: DraftId, cwd: string | null): Promise<boolean> {
  const draftStore = useComposerDraftStore.getState();
  const session = draftStore.getDraftSession(draftId);
  const tab = useFilesTabsStore.getState().tabsByDraftId[draftId];
  const autoSave = useFileAutoSaveStore.getState().autoSave;
  const unsaved = (tab?.openPaths ?? []).filter((path) =>
    filesTabPathUnsaved(draftId, path, autoSave),
  );
  if (unsaved.length > 0) {
    const confirmed =
      (await readLocalApi()?.dialogs.confirm(unsavedMessage(unsaved.map(filesTabTitle)), {
        variant: "destructive",
      })) ?? true;
    if (!confirmed) return false;
    for (const path of unsaved) {
      if (session && cwd && !isScratchPath(path)) {
        clearProjectFileQueryData(session.environmentId, cwd, path);
      }
    }
  }
  if (session) {
    const threadKey = scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId));
    useChatTabsStore.getState().closeTab(threadKey);
    // Reopening a closed tab can't bring back a deleted draft.
    useChatTabsStore.setState((state) => ({
      closedThreadKeys: state.closedThreadKeys.filter((key) => key !== threadKey),
    }));
  }
  useFilesTabsStore.getState().remove(draftId);
  draftStore.clearDraftThread(draftId);
  return true;
}
