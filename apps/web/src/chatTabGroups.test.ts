import { describe, expect, it } from "vite-plus/test";

import { groupTabs, moveGroupId, SCRATCH_TAB_GROUP_ID } from "./chatTabGroups";

const tab = (groupId: string, title: string, item: string) => ({ groupId, title, item });

describe("groupTabs", () => {
  const inputs = [
    tab("p:thestral", "thestral", "t1"),
    tab("p:pegasus", "pegasus", "g1"),
    tab(SCRATCH_TAB_GROUP_ID, "No project", "s1"),
    tab("p:thestral", "thestral", "t2"),
  ];

  it("starts with no project, then projects by title, keeping tab order in a group", () => {
    const groups = groupTabs(inputs, []);
    expect(groups.map((group) => group.groupId)).toEqual([
      SCRATCH_TAB_GROUP_ID,
      "p:pegasus",
      "p:thestral",
    ]);
    expect(groups[2]?.items).toEqual(["t1", "t2"]);
  });

  it("follows the saved order and puts unplaced groups after it", () => {
    const groups = groupTabs(inputs, ["p:thestral", "gone", SCRATCH_TAB_GROUP_ID]);
    expect(groups.map((group) => group.groupId)).toEqual([
      "p:thestral",
      SCRATCH_TAB_GROUP_ID,
      "p:pegasus",
    ]);
  });
});

describe("moveGroupId", () => {
  it("takes the target's place", () => {
    expect(moveGroupId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveGroupId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("ignores unknown ids", () => {
    expect(moveGroupId(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });
});
