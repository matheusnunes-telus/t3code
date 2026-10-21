import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * A files tab is a new-chat draft turned into a file viewer: it keeps the draft's
 * project and checkout (worktree or branch), shows one file at a time in the main
 * area and browses the project in the right panel. Keyed by draft id.
 */
export interface FilesTabState {
  relativePath: string | null;
  revealLine: number | null;
  revealRequestId: number;
}

interface FilesTabsStoreState {
  tabsByDraftId: Record<string, FilesTabState>;
  /** The open file has edits that aren't saved yet. Not persisted. */
  dirtyByDraftId: Record<string, boolean>;
  enable: (draftId: string) => void;
  openFile: (draftId: string, relativePath: string, line?: number) => void;
  remove: (draftId: string) => void;
  setDirty: (draftId: string, dirty: boolean) => void;
}

const EMPTY_FILES_TAB: FilesTabState = { relativePath: null, revealLine: null, revealRequestId: 0 };

export const useFilesTabsStore = create<FilesTabsStoreState>()(
  persist(
    (set) => ({
      tabsByDraftId: {},
      dirtyByDraftId: {},
      enable: (draftId) =>
        set((state) =>
          state.tabsByDraftId[draftId]
            ? state
            : { tabsByDraftId: { ...state.tabsByDraftId, [draftId]: EMPTY_FILES_TAB } },
        ),
      openFile: (draftId, relativePath, line) =>
        set((state) => {
          const current = state.tabsByDraftId[draftId];
          if (!current) return state;
          return {
            tabsByDraftId: {
              ...state.tabsByDraftId,
              [draftId]: {
                relativePath,
                revealLine: line ?? null,
                revealRequestId: current.revealRequestId + 1,
              },
            },
          };
        }),
      remove: (draftId) =>
        set((state) => {
          if (!state.tabsByDraftId[draftId]) return state;
          const { [draftId]: _removed, ...tabsByDraftId } = state.tabsByDraftId;
          const { [draftId]: _dirty, ...dirtyByDraftId } = state.dirtyByDraftId;
          return { tabsByDraftId, dirtyByDraftId };
        }),
      setDirty: (draftId, dirty) =>
        set((state) =>
          (state.dirtyByDraftId[draftId] ?? false) === dirty
            ? state
            : { dirtyByDraftId: { ...state.dirtyByDraftId, [draftId]: dirty } },
        ),
    }),
    {
      name: "t3code:files-tabs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ tabsByDraftId }) => ({ tabsByDraftId }),
    },
  ),
);

export function isFilesDraft(draftId: string): boolean {
  return useFilesTabsStore.getState().tabsByDraftId[draftId] !== undefined;
}
