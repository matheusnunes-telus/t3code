import { describe, expect, it } from "vite-plus/test";

import { moveToFront, startRecentTabCycle, stepRecentTabCycle } from "./chatTabCycle";

describe("recent tab cycling", () => {
  const tabs = ["a", "b", "c", "d"];

  it("starts at the active tab with the most recently used ones next", () => {
    const cycle = startRecentTabCycle(["c", "a", "gone"], tabs, "c");
    expect(cycle.keys).toEqual(["c", "a", "b", "d"]);
    expect(cycle.index).toBe(0);
  });

  it("goes back to the last used tab, and further back on each press", () => {
    let cycle = startRecentTabCycle(["c", "a", "b", "d"], tabs, "c");
    cycle = stepRecentTabCycle(cycle, 1);
    expect(cycle.keys[cycle.index]).toBe("a");
    cycle = stepRecentTabCycle(cycle, 1);
    expect(cycle.keys[cycle.index]).toBe("b");
  });

  it("goes forward the other way and wraps around", () => {
    let cycle = startRecentTabCycle(["c", "a", "b", "d"], tabs, "c");
    cycle = stepRecentTabCycle(cycle, -1);
    expect(cycle.keys[cycle.index]).toBe("d");
    cycle = stepRecentTabCycle(cycle, 1);
    cycle = stepRecentTabCycle(cycle, 1);
    expect(cycle.keys[cycle.index]).toBe("a");
  });

  it("never lands on the draft placeholder", () => {
    let cycle = startRecentTabCycle([], ["a", "b"], null);
    expect(cycle.keys).toEqual([null, "a", "b"]);
    cycle = stepRecentTabCycle(cycle, 1);
    expect(cycle.keys[cycle.index]).toBe("a");
    cycle = stepRecentTabCycle(cycle, 1);
    cycle = stepRecentTabCycle(cycle, 1);
    expect(cycle.keys[cycle.index]).toBe("a");
  });

  it("stays put with a single tab", () => {
    const cycle = startRecentTabCycle(["a"], ["a"], "a");
    expect(stepRecentTabCycle(cycle, 1)).toBe(cycle);
  });

  it("moves a key to the front", () => {
    expect(moveToFront(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });
});
