import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

/** Per chat, only this many followed deploys are remembered. Older ones are long finished. */
const MAX_FOLLOWED_PER_THREAD = 20;

/**
 * The deploys each chat follows, by scoped thread key. A deploy only shows as a banner above the
 * composer once someone follows it from the Cloud panel (unless the setting shows all of them).
 */
interface GcpFollowedDeploysState {
  followedByThreadKey: Record<string, ReadonlyArray<string>>;
  follow: (threadKey: string, runId: string) => void;
  unfollow: (threadKey: string, runId: string) => void;
}

export const useGcpFollowedDeploysStore = create<GcpFollowedDeploysState>()(
  persist(
    (set) => ({
      followedByThreadKey: {},
      follow: (threadKey, runId) =>
        set((state) => {
          const current = state.followedByThreadKey[threadKey] ?? [];
          if (current.includes(runId)) return state;
          return {
            followedByThreadKey: {
              ...state.followedByThreadKey,
              [threadKey]: [...current, runId].slice(-MAX_FOLLOWED_PER_THREAD),
            },
          };
        }),
      unfollow: (threadKey, runId) =>
        set((state) => {
          const current = state.followedByThreadKey[threadKey] ?? [];
          if (!current.includes(runId)) return state;
          return {
            followedByThreadKey: {
              ...state.followedByThreadKey,
              [threadKey]: current.filter((id) => id !== runId),
            },
          };
        }),
    }),
    {
      name: "t3code:gcp-followed-deploys:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ followedByThreadKey }) => ({ followedByThreadKey }),
    },
  ),
);
