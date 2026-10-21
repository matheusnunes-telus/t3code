import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * Whether file editors save on their own shortly after each edit (the default),
 * or only when asked with mod+S.
 */
interface FileAutoSaveState {
  autoSave: boolean;
  setAutoSave: (autoSave: boolean) => void;
}

export const useFileAutoSaveStore = create<FileAutoSaveState>()(
  persist(
    (set) => ({
      autoSave: true,
      setAutoSave: (autoSave) => set({ autoSave }),
    }),
    {
      name: "t3code:file-auto-save:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ autoSave }) => ({ autoSave }),
    },
  ),
);
