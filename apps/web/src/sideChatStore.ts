import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * Threads started by /btw. They live in their main chat's right panel, so the
 * sidebar, chat tabs and command palette leave them out. Keys are thread ids.
 */
interface SideChatStoreState {
  threadIds: string[];
  add: (threadId: string) => void;
  /** Turns a side chat into a normal chat. */
  remove: (threadId: string) => void;
}

export const useSideChatStore = create<SideChatStoreState>()(
  persist(
    (set) => ({
      threadIds: [],
      add: (threadId) =>
        set((state) =>
          state.threadIds.includes(threadId)
            ? state
            : { threadIds: [...state.threadIds, threadId] },
        ),
      remove: (threadId) =>
        set((state) =>
          state.threadIds.includes(threadId)
            ? { threadIds: state.threadIds.filter((id) => id !== threadId) }
            : state,
        ),
    }),
    {
      name: "t3code:side-chats:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ threadIds }) => ({ threadIds }),
    },
  ),
);
