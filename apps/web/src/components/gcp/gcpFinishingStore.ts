import { create } from "zustand";

export interface GcpFinishingChat {
  /** "drafting" while the Jira model writes the cards; "reviewing" once they are out. */
  readonly phase: "drafting" | "reviewing";
  /** How many new Jira cards to wait for, and the ones that existed before. */
  readonly expectedCards: number;
  readonly knownCardIds: ReadonlyArray<string>;
}

/**
 * Chats on their way to settling, by scoped thread key. The chat settles once its Jira cards are
 * applied or dismissed, even if another chat is on screen by then. Lost on reload, which only
 * leaves the chat open.
 */
interface GcpFinishingState {
  finishing: Record<string, GcpFinishingChat>;
  start: (threadKey: string, chat: GcpFinishingChat) => void;
  review: (threadKey: string) => void;
  cancel: (threadKey: string) => void;
}

export const useGcpFinishingStore = create<GcpFinishingState>()((set) => ({
  finishing: {},
  start: (threadKey, chat) =>
    set((state) => ({ finishing: { ...state.finishing, [threadKey]: chat } })),
  review: (threadKey) =>
    set((state) => {
      const chat = state.finishing[threadKey];
      if (chat === undefined) return state;
      return { finishing: { ...state.finishing, [threadKey]: { ...chat, phase: "reviewing" } } };
    }),
  cancel: (threadKey) =>
    set((state) => {
      const { [threadKey]: _removed, ...finishing } = state.finishing;
      return { finishing };
    }),
}));
