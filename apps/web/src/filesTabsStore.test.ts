import { beforeEach, describe, expect, it } from "vite-plus/test";

import { filesTabTitle, useFilesTabsStore } from "./filesTabsStore";

const tab = () => useFilesTabsStore.getState().tabsByDraftId.d!;

describe("filesTabsStore", () => {
  beforeEach(() => {
    useFilesTabsStore.setState({ tabsByDraftId: {}, scratchByKey: {}, dirtyByDraftId: {} });
    useFilesTabsStore.getState().enable("d");
  });

  it("starts a new files tab on a blank scratchpad", () => {
    expect(tab().openPaths).toEqual(["untitled:1"]);
    expect(tab().relativePath).toBe("untitled:1");
    expect(filesTabTitle("untitled:1")).toBe("Untitled-1");
  });

  it("replaces the preview tab, and keeps it once edited or pinned", () => {
    const store = useFilesTabsStore.getState();
    store.openFile("d", "a.ts");
    store.openFile("d", "b.ts");
    expect(tab().openPaths).toEqual(["untitled:1", "b.ts"]);
    expect(tab().previewPath).toBe("b.ts");
    store.setDirty("d", "b.ts", true);
    store.openFile("d", "c.ts");
    expect(tab().openPaths).toEqual(["untitled:1", "b.ts", "c.ts"]);
    store.pin("d", "c.ts");
    store.openFile("d", "e.ts", undefined, { pin: true });
    expect(tab().openPaths).toEqual(["untitled:1", "b.ts", "c.ts", "e.ts"]);
    expect(tab().previewPath).toBeNull();
  });

  it("activates the right neighbor when the active tab closes", () => {
    const store = useFilesTabsStore.getState();
    store.openFile("d", "a.ts", undefined, { pin: true });
    store.openFile("d", "b.ts", undefined, { pin: true });
    store.openFile("d", "a.ts");
    store.closeFile("d", "a.ts");
    expect(tab().openPaths).toEqual(["untitled:1", "b.ts"]);
    expect(tab().relativePath).toBe("b.ts");
  });

  it("numbers new scratchpads and drops their text when closed", () => {
    const store = useFilesTabsStore.getState();
    store.newScratch("d");
    expect(tab().relativePath).toBe("untitled:2");
    store.setScratch("d", "untitled:2", "notes");
    store.closeFile("d", "untitled:2");
    expect(Object.keys(useFilesTabsStore.getState().scratchByKey)).toEqual([]);
  });
});
