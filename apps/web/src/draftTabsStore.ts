import { create } from "zustand";

/**
 * Drafts opened since the app started. Only these get a tab once you leave them, so drafts
 * abandoned in earlier sessions stay in the sidebar instead of filling the tab bar.
 * Closing a draft tab drops it here; opening the draft again brings the tab back.
 */
interface DraftTabsStoreState {
  draftIds: ReadonlySet<string>;
  add: (draftId: string) => void;
  remove: (draftId: string) => void;
}

export const useDraftTabsStore = create<DraftTabsStoreState>()((set) => ({
  draftIds: new Set(),
  add: (draftId) =>
    set((state) =>
      state.draftIds.has(draftId) ? state : { draftIds: new Set(state.draftIds).add(draftId) },
    ),
  remove: (draftId) =>
    set((state) => {
      if (!state.draftIds.has(draftId)) return state;
      const draftIds = new Set(state.draftIds);
      draftIds.delete(draftId);
      return { draftIds };
    }),
}));
