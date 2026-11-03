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

/** The local calendar day, like "2026-11-03". The daily tab sweep runs when it changes. */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

interface ChatTabsStoreState {
  tabs: ChatTab[];
  closedThreadKeys: string[];
  /** The day the tabs were last cleared; null until the first run. */
  lastSweptDay: string | null;
  /** Left-to-right order of the project groups in the tab strip. */
  groupOrder: string[];
  setGroupOrder: (groupOrder: string[]) => void;
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
  /**
   * Arc-style end-of-day clean-up. When `day` is newer than the last sweep, drops the tabs
   * `shouldSweep` accepts and returns their keys so the caller can settle those chats.
   * The first run only records the day.
   */
  sweepTabs: (day: string, shouldSweep: (threadKey: string) => boolean) => string[];
}

export const useChatTabsStore = create<ChatTabsStoreState>()(
  persist(
    (set, get) => ({
      tabs: [],
      closedThreadKeys: [],
      lastSweptDay: null,
      groupOrder: [],
      setGroupOrder: (groupOrder) => set({ groupOrder }),
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
      sweepTabs: (day, shouldSweep) => {
        const { lastSweptDay, tabs } = get();
        if (lastSweptDay === day) return [];
        if (lastSweptDay === null) {
          set({ lastSweptDay: day });
          return [];
        }
        const swept = tabs.filter((tab) => shouldSweep(tab.threadKey)).map((tab) => tab.threadKey);
        const sweptKeys = new Set(swept);
        set({
          lastSweptDay: day,
          tabs: tabs.filter((tab) => !sweptKeys.has(tab.threadKey)),
          closedThreadKeys: [],
        });
        return swept;
      },
    }),
    {
      name: "t3code:chat-tabs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ tabs, closedThreadKeys, lastSweptDay, groupOrder }) => ({
        tabs,
        closedThreadKeys,
        lastSweptDay,
        groupOrder,
      }),
    },
  ),
);
