import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * A files tab is a new-chat draft turned into a file viewer: it keeps the draft's
 * project and checkout (worktree or branch), shows its open files as editor tabs in
 * the main area and browses the project in the right panel. Keyed by draft id.
 */
export interface FilesTabState {
  /** Editor tabs in order: project-relative paths, or `untitled:N` scratchpads. */
  openPaths: string[];
  /** The italic tab a single click replaces; editing or double-clicking keeps it. */
  previewPath: string | null;
  /** The active editor tab. */
  relativePath: string | null;
  revealLine: number | null;
  revealRequestId: number;
}

interface FilesTabsStoreState {
  tabsByDraftId: Record<string, FilesTabState>;
  /** Scratchpad text by `scratchKey`, kept across restarts like VS Code's untitled files. */
  scratchByKey: Record<string, string>;
  /** Open files with edits that aren't saved yet, by draft. Not persisted. */
  dirtyByDraftId: Record<string, Record<string, true>>;
  enable: (draftId: string) => void;
  openFile: (
    draftId: string,
    relativePath: string,
    line?: number,
    options?: { pin?: boolean },
  ) => void;
  pin: (draftId: string, relativePath: string) => void;
  closeFile: (draftId: string, relativePath: string) => void;
  moveFile: (draftId: string, relativePath: string, toIndex: number) => void;
  newScratch: (draftId: string) => void;
  setScratch: (draftId: string, path: string, contents: string) => void;
  remove: (draftId: string) => void;
  setDirty: (draftId: string, relativePath: string, dirty: boolean) => void;
}

const SCRATCH_PREFIX = "untitled:";

export const isScratchPath = (path: string) => path.startsWith(SCRATCH_PREFIX);

/** `untitled:2` → `Untitled-2`. */
export const scratchTitle = (path: string) => `Untitled-${path.slice(SCRATCH_PREFIX.length)}`;

export const scratchKey = (draftId: string, path: string) => `${draftId}\u0000${path}`;

/** The tab label: a file's name, or a scratchpad's `Untitled-N`. */
export const filesTabTitle = (path: string) =>
  isScratchPath(path) ? scratchTitle(path) : (path.split("/").at(-1) ?? path);

const nextScratchPath = (openPaths: readonly string[]) => {
  const used = openPaths
    .filter(isScratchPath)
    .map((path) => Number(path.slice(SCRATCH_PREFIX.length)) || 0);
  return `${SCRATCH_PREFIX}${Math.max(0, ...used) + 1}`;
};

const withTab = (
  state: FilesTabsStoreState,
  draftId: string,
  update: (tab: FilesTabState) => FilesTabState,
) => {
  const current = state.tabsByDraftId[draftId];
  if (!current) return state;
  return { tabsByDraftId: { ...state.tabsByDraftId, [draftId]: update(current) } };
};

export const useFilesTabsStore = create<FilesTabsStoreState>()(
  persist(
    (set) => ({
      tabsByDraftId: {},
      scratchByKey: {},
      dirtyByDraftId: {},
      enable: (draftId) =>
        set((state) =>
          state.tabsByDraftId[draftId]
            ? state
            : {
                // A new files tab starts on a blank scratchpad.
                tabsByDraftId: {
                  ...state.tabsByDraftId,
                  [draftId]: {
                    openPaths: [`${SCRATCH_PREFIX}1`],
                    previewPath: null,
                    relativePath: `${SCRATCH_PREFIX}1`,
                    revealLine: null,
                    revealRequestId: 0,
                  },
                },
              },
        ),
      openFile: (draftId, relativePath, line, options) =>
        set((state) =>
          withTab(state, draftId, (tab) => {
            const pin = options?.pin === true;
            const reveal = {
              relativePath,
              revealLine: line ?? null,
              revealRequestId: tab.revealRequestId + 1,
            };
            if (tab.openPaths.includes(relativePath)) {
              return {
                ...tab,
                ...reveal,
                previewPath: pin && tab.previewPath === relativePath ? null : tab.previewPath,
              };
            }
            const dirty = state.dirtyByDraftId[draftId] ?? {};
            const previewIndex =
              tab.previewPath !== null && !dirty[tab.previewPath]
                ? tab.openPaths.indexOf(tab.previewPath)
                : -1;
            const openPaths = [...tab.openPaths];
            if (previewIndex >= 0) {
              // A new preview replaces the old one in place.
              openPaths.splice(previewIndex, 1, relativePath);
            } else {
              const activeIndex =
                tab.relativePath === null ? -1 : openPaths.indexOf(tab.relativePath);
              openPaths.splice(activeIndex + 1 || openPaths.length, 0, relativePath);
            }
            return { ...tab, ...reveal, openPaths, previewPath: pin ? null : relativePath };
          }),
        ),
      pin: (draftId, relativePath) =>
        set((state) =>
          withTab(state, draftId, (tab) =>
            tab.previewPath === relativePath ? { ...tab, previewPath: null } : tab,
          ),
        ),
      closeFile: (draftId, relativePath) =>
        set((state) => {
          const next = withTab(state, draftId, (tab) => {
            const index = tab.openPaths.indexOf(relativePath);
            if (index < 0) return tab;
            const openPaths = tab.openPaths.filter((path) => path !== relativePath);
            const active =
              tab.relativePath === relativePath
                ? (openPaths[index] ?? openPaths[index - 1] ?? null)
                : tab.relativePath;
            return {
              ...tab,
              openPaths,
              relativePath: active,
              previewPath: tab.previewPath === relativePath ? null : tab.previewPath,
              revealLine: null,
              revealRequestId: tab.revealRequestId + 1,
            };
          });
          const { [scratchKey(draftId, relativePath)]: _closed, ...scratchByKey } =
            state.scratchByKey;
          const { [relativePath]: _dirty, ...dirty } = state.dirtyByDraftId[draftId] ?? {};
          return {
            ...next,
            scratchByKey,
            dirtyByDraftId: { ...state.dirtyByDraftId, [draftId]: dirty },
          };
        }),
      moveFile: (draftId, relativePath, toIndex) =>
        set((state) =>
          withTab(state, draftId, (tab) => {
            const openPaths = tab.openPaths.filter((path) => path !== relativePath);
            if (openPaths.length === tab.openPaths.length) return tab;
            openPaths.splice(Math.max(0, Math.min(toIndex, openPaths.length)), 0, relativePath);
            return { ...tab, openPaths };
          }),
        ),
      newScratch: (draftId) =>
        set((state) =>
          withTab(state, draftId, (tab) => {
            const path = nextScratchPath(tab.openPaths);
            return {
              ...tab,
              openPaths: [...tab.openPaths, path],
              relativePath: path,
              revealLine: null,
              revealRequestId: tab.revealRequestId + 1,
            };
          }),
        ),
      setScratch: (draftId, path, contents) =>
        set((state) => ({
          scratchByKey: { ...state.scratchByKey, [scratchKey(draftId, path)]: contents },
          ...withTab(state, draftId, (tab) =>
            tab.previewPath === path ? { ...tab, previewPath: null } : tab,
          ),
        })),
      remove: (draftId) =>
        set((state) => {
          if (!state.tabsByDraftId[draftId]) return state;
          const { [draftId]: _removed, ...tabsByDraftId } = state.tabsByDraftId;
          const { [draftId]: _dirty, ...dirtyByDraftId } = state.dirtyByDraftId;
          const scratchByKey = Object.fromEntries(
            Object.entries(state.scratchByKey).filter(
              ([key]) => !key.startsWith(`${draftId}\u0000`),
            ),
          );
          return { tabsByDraftId, dirtyByDraftId, scratchByKey };
        }),
      setDirty: (draftId, relativePath, dirty) =>
        set((state) => {
          const current = state.dirtyByDraftId[draftId] ?? {};
          if ((current[relativePath] === true) === dirty) return state;
          const { [relativePath]: _previous, ...rest } = current;
          return {
            dirtyByDraftId: {
              ...state.dirtyByDraftId,
              [draftId]: dirty ? { ...rest, [relativePath]: true } : rest,
            },
            // Editing a preview tab keeps it, as in VS Code.
            ...(dirty
              ? withTab(state, draftId, (tab) =>
                  tab.previewPath === relativePath ? { ...tab, previewPath: null } : tab,
                )
              : {}),
          };
        }),
    }),
    {
      name: "t3code:files-tabs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 2,
      partialize: ({ tabsByDraftId, scratchByKey }) => ({ tabsByDraftId, scratchByKey }),
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as {
          tabsByDraftId?: Record<string, Partial<FilesTabState>>;
          scratchByKey?: Record<string, string>;
        };
        if (version >= 2) return state as Pick<FilesTabsStoreState, "tabsByDraftId">;
        // v1 held one file per files tab.
        return {
          scratchByKey: {},
          tabsByDraftId: Object.fromEntries(
            Object.entries(state.tabsByDraftId ?? {}).map(([draftId, tab]) => [
              draftId,
              {
                openPaths: tab.relativePath ? [tab.relativePath] : [],
                previewPath: null,
                relativePath: tab.relativePath ?? null,
                revealLine: tab.revealLine ?? null,
                revealRequestId: tab.revealRequestId ?? 0,
              },
            ]),
          ),
        };
      },
    },
  ),
);

export function isFilesDraft(draftId: string): boolean {
  return useFilesTabsStore.getState().tabsByDraftId[draftId] !== undefined;
}

/** Whether a files tab has unsaved work in one tab: file edits without auto-save, or scratch text. */
export function filesTabPathUnsaved(draftId: string, path: string, autoSave: boolean): boolean {
  const state = useFilesTabsStore.getState();
  if (isScratchPath(path)) return (state.scratchByKey[scratchKey(draftId, path)] ?? "") !== "";
  return !autoSave && state.dirtyByDraftId[draftId]?.[path] === true;
}
