import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

/**
 * Arbitrary sub-projects: named groups of threads inside one sidebar project.
 * Client-only state, kept in this browser profile's local storage.
 */
export interface SubProject {
  id: string;
  name: string;
}

interface SubProjectStoreState {
  subProjectsByProjectKey: Record<string, SubProject[]>;
  subProjectIdByThreadKey: Record<string, string>;
  collapsedSubProjectIds: Record<string, true>;
  /** Projects kept at the top level even though their folder sits inside another project. */
  detachedProjectKeys: Record<string, true>;
  setProjectDetached: (projectKey: string, detached: boolean) => void;
  createSubProject: (projectKey: string, name: string) => string;
  renameSubProject: (projectKey: string, subProjectId: string, name: string) => void;
  deleteSubProject: (projectKey: string, subProjectId: string) => void;
  moveSubProject: (projectKey: string, subProjectId: string, toIndex: number) => void;
  assignThread: (threadKey: string, subProjectId: string | null) => void;
  toggleSubProjectCollapsed: (subProjectId: string) => void;
}

const EMPTY_SUB_PROJECTS: SubProject[] = [];

export const useSubProjectStore = create<SubProjectStoreState>()(
  persist(
    (set) => ({
      subProjectsByProjectKey: {},
      subProjectIdByThreadKey: {},
      collapsedSubProjectIds: {},
      detachedProjectKeys: {},
      setProjectDetached: (projectKey, detached) =>
        set((state) => {
          const { [projectKey]: _removed, ...detachedProjectKeys } = state.detachedProjectKeys;
          return {
            detachedProjectKeys: detached
              ? { ...detachedProjectKeys, [projectKey]: true }
              : detachedProjectKeys,
          };
        }),
      createSubProject: (projectKey, name) => {
        const id = randomUUID();
        set((state) => ({
          subProjectsByProjectKey: {
            ...state.subProjectsByProjectKey,
            [projectKey]: [...(state.subProjectsByProjectKey[projectKey] ?? []), { id, name }],
          },
        }));
        return id;
      },
      renameSubProject: (projectKey, subProjectId, name) =>
        set((state) => ({
          subProjectsByProjectKey: {
            ...state.subProjectsByProjectKey,
            [projectKey]: (state.subProjectsByProjectKey[projectKey] ?? []).map((subProject) =>
              subProject.id === subProjectId ? { ...subProject, name } : subProject,
            ),
          },
        })),
      deleteSubProject: (projectKey, subProjectId) =>
        set((state) => {
          const { [subProjectId]: _collapsed, ...collapsedSubProjectIds } =
            state.collapsedSubProjectIds;
          return {
            subProjectsByProjectKey: {
              ...state.subProjectsByProjectKey,
              [projectKey]: (state.subProjectsByProjectKey[projectKey] ?? []).filter(
                (subProject) => subProject.id !== subProjectId,
              ),
            },
            // Threads fall back to the project's own list.
            subProjectIdByThreadKey: Object.fromEntries(
              Object.entries(state.subProjectIdByThreadKey).filter(([, id]) => id !== subProjectId),
            ),
            collapsedSubProjectIds,
          };
        }),
      moveSubProject: (projectKey, subProjectId, toIndex) =>
        set((state) => {
          const subProjects = state.subProjectsByProjectKey[projectKey] ?? [];
          const moving = subProjects.find((subProject) => subProject.id === subProjectId);
          if (!moving) return state;
          const rest = subProjects.filter((subProject) => subProject.id !== subProjectId);
          rest.splice(Math.max(0, Math.min(toIndex, rest.length)), 0, moving);
          return {
            subProjectsByProjectKey: { ...state.subProjectsByProjectKey, [projectKey]: rest },
          };
        }),
      assignThread: (threadKey, subProjectId) =>
        set((state) => {
          if (subProjectId === null) {
            const { [threadKey]: _removed, ...subProjectIdByThreadKey } =
              state.subProjectIdByThreadKey;
            return { subProjectIdByThreadKey };
          }
          return {
            subProjectIdByThreadKey: {
              ...state.subProjectIdByThreadKey,
              [threadKey]: subProjectId,
            },
          };
        }),
      toggleSubProjectCollapsed: (subProjectId) =>
        set((state) => {
          if (state.collapsedSubProjectIds[subProjectId]) {
            const { [subProjectId]: _removed, ...collapsedSubProjectIds } =
              state.collapsedSubProjectIds;
            return { collapsedSubProjectIds };
          }
          return {
            collapsedSubProjectIds: { ...state.collapsedSubProjectIds, [subProjectId]: true },
          };
        }),
    }),
    {
      name: "t3code:sub-projects:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({
        subProjectsByProjectKey,
        subProjectIdByThreadKey,
        collapsedSubProjectIds,
        detachedProjectKeys,
      }) => ({
        subProjectsByProjectKey,
        subProjectIdByThreadKey,
        collapsedSubProjectIds,
        detachedProjectKeys,
      }),
    },
  ),
);

export function selectSubProjects(
  state: Pick<SubProjectStoreState, "subProjectsByProjectKey">,
  projectKey: string,
): SubProject[] {
  return state.subProjectsByProjectKey[projectKey] ?? EMPTY_SUB_PROJECTS;
}
