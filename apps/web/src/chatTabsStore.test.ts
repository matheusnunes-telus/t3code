import { beforeEach, describe, expect, it } from "vite-plus/test";

import { localDayKey, useChatTabsStore } from "./chatTabsStore";

beforeEach(() => {
  useChatTabsStore.setState({ tabs: [], closedThreadKeys: [], lastSweptDay: null });
});

const keys = () => useChatTabsStore.getState().tabs.map((tab) => `${tab.threadKey}:${tab.preview}`);

describe("chatTabsStore", () => {
  it("reuses the preview tab in place and keeps permanent tabs", () => {
    const store = useChatTabsStore.getState();
    store.openTab("a", { permanent: true });
    store.openTab("b");
    store.openTab("c");
    expect(keys()).toEqual(["a:false", "c:true"]);
    store.makePermanent("c");
    store.openTab("d");
    expect(keys()).toEqual(["a:false", "c:false", "d:true"]);
  });

  it("closes to the neighbor and reopens closed tabs newest first", () => {
    const store = useChatTabsStore.getState();
    store.openTab("a", { permanent: true });
    store.openTab("b", { permanent: true });
    store.openTab("c", { permanent: true });
    expect(store.closeTab("b")).toBe("c");
    expect(store.closeTab("c")).toBe("a");
    expect(store.popClosedTab()).toBe("c");
    expect(store.popClosedTab()).toBe("b");
    expect(store.popClosedTab()).toBeNull();
    expect(keys()).toEqual(["a:false", "c:false", "b:false"]);
  });

  it("removes an archived thread's tab without offering it to reopen", () => {
    const store = useChatTabsStore.getState();
    store.openTab("a", { permanent: true });
    store.openTab("b", { permanent: true });
    expect(store.removeTab("b")).toBe("a");
    expect(store.removeTab("missing")).toBeNull();
    expect(keys()).toEqual(["a:false"]);
    expect(store.popClosedTab()).toBeNull();
  });

  it("clears swept tabs once per day and returns them to settle", () => {
    const store = useChatTabsStore.getState();
    store.openTab("a", { permanent: true });
    store.openTab("pinned", { permanent: true });
    store.openTab("b");
    const sweepable = (key: string) => key !== "pinned";
    // First run only records the day.
    expect(store.sweepTabs("2026-11-03", sweepable)).toEqual([]);
    expect(keys()).toEqual(["a:false", "pinned:false", "b:true"]);
    // Same day: nothing happens.
    expect(store.sweepTabs("2026-11-03", sweepable)).toEqual([]);
    // Next day: swept tabs go, others stay, and closed tabs can't be reopened.
    expect(store.sweepTabs("2026-11-04", sweepable)).toEqual(["a", "b"]);
    expect(keys()).toEqual(["pinned:false"]);
    expect(useChatTabsStore.getState().closedThreadKeys).toEqual([]);
    expect(store.sweepTabs("2026-11-04", sweepable)).toEqual([]);
  });

  it("formats the local day", () => {
    expect(localDayKey(new Date(2026, 10, 3, 23, 59))).toBe("2026-11-03");
  });
});
