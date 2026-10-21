import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * VS Code-style chat tabs. A preview tab (italic) is reused by the next thread
 * opened with a single click; double-clicking makes a tab permanent.
 * Keys are scoped thread keys.
 */
export interface ChatTab {
  threadKey: string;
  preview: boolean;
}

const MAX_CLOSED_TABS = 25;

interface ChatTabsStoreState {
  tabs: ChatTab[];
  closedThreadKeys: string[];
  openTab: (threadKey: string, options?: { permanent?: boolean }) => void;
  makePermanent: (threadKey: string) => void;
  /** Closes the tab and returns the tab to show next, if the closed one was showing. */
  closeTab: (threadKey: string) => string | null;
  popClosedTab: () => string | null;
  moveTab: (threadKey: string, toIndex: number) => void;
  /**
   * Drops the tab of a thread that went away (archived or deleted), without offering it
   * to reopen. Returns the neighbouring tab, like closeTab.
   */
  removeTab: (threadKey: string) => string | null;
  removeTabs: (threadKeys: ReadonlySet<string>) => void;
}

export const useChatTabsStore = create<ChatTabsStoreState>()(
  persist(
    (set, get) => ({
      tabs: [],
      closedThreadKeys: [],
      openTab: (threadKey, options) =>
        set((state) => {
          const permanent = options?.permanent === true;
          const existing = state.tabs.find((tab) => tab.threadKey === threadKey);
          if (existing) {
            if (!permanent || !existing.preview) return state;
            return {
              tabs: state.tabs.map((tab) =>
                tab.threadKey === threadKey ? { ...tab, preview: false } : tab,
              ),
            };
          }
          const nextTab: ChatTab = { threadKey, preview: !permanent };
          const previewIndex = state.tabs.findIndex((tab) => tab.preview);
          // New permanent tabs (a sent new chat, a side chat) land at the end, where the
          // temporary "New chat" tab sat, and leave the preview tab alone.
          if (permanent || previewIndex === -1) return { tabs: [...state.tabs, nextTab] };
          // The preview tab is replaced in place, like VS Code.
          const tabs = [...state.tabs];
          tabs[previewIndex] = nextTab;
          return { tabs };
        }),
      makePermanent: (threadKey) => get().openTab(threadKey, { permanent: true }),
      closeTab: (threadKey) => {
        const { tabs } = get();
        const index = tabs.findIndex((tab) => tab.threadKey === threadKey);
        if (index === -1) return null;
        const remaining = tabs.filter((tab) => tab.threadKey !== threadKey);
        set((state) => ({
          tabs: remaining,
          closedThreadKeys: [
            threadKey,
            ...state.closedThreadKeys.filter((key) => key !== threadKey),
          ].slice(0, MAX_CLOSED_TABS),
        }));
        return (remaining[index] ?? remaining[index - 1])?.threadKey ?? null;
      },
      popClosedTab: () => {
        const openKeys = new Set(get().tabs.map((tab) => tab.threadKey));
        const [next, ...rest] = get().closedThreadKeys.filter((key) => !openKeys.has(key));
        if (!next) return null;
        set({ closedThreadKeys: rest });
        get().openTab(next, { permanent: true });
        return next;
      },
      moveTab: (threadKey, toIndex) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.threadKey === threadKey);
          if (!tab) return state;
          const tabs = state.tabs.filter((candidate) => candidate.threadKey !== threadKey);
          tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
          return { tabs };
        }),
      removeTab: (threadKey) => {
        const { tabs } = get();
        const index = tabs.findIndex((tab) => tab.threadKey === threadKey);
        if (index === -1) return null;
        const remaining = tabs.filter((tab) => tab.threadKey !== threadKey);
        set({ tabs: remaining });
        return (remaining[index] ?? remaining[index - 1])?.threadKey ?? null;
      },
      removeTabs: (threadKeys) =>
        set((state) => {
          if (!state.tabs.some((tab) => threadKeys.has(tab.threadKey))) return state;
          return { tabs: state.tabs.filter((tab) => !threadKeys.has(tab.threadKey)) };
        }),
    }),
    {
      name: "t3code:chat-tabs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ tabs, closedThreadKeys }) => ({ tabs, closedThreadKeys }),
    },
  ),
);
