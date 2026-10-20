import type { ProjectContentMatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compactMatch, groupMatches } from "./FileContentSearchView.logic";

function match(lineContent: string, ranges: Array<[number, number]>): ProjectContentMatch {
  return {
    path: "src/a.ts",
    lineNumber: 1,
    lineContent,
    matchRanges: ranges.map(([start, end]) => ({ start, end })),
  } as ProjectContentMatch;
}

describe("compactMatch", () => {
  it("drops leading indentation and shifts the ranges", () => {
    const result = compactMatch(match("    x = useState();", [[8, 16]]));
    expect(result.clipped).toBe(false);
    expect(result.match.lineContent).toBe("x = useState();");
    expect(result.match.matchRanges).toEqual([{ start: 4, end: 12 }]);
  });

  it("cuts text far ahead of the first match", () => {
    const line = `${"a".repeat(40)}needle`;
    const result = compactMatch(match(line, [[40, 46]]));
    expect(result.clipped).toBe(true);
    expect(result.match.lineContent).toBe(`${"a".repeat(8)}needle`);
    expect(result.match.matchRanges).toEqual([{ start: 8, end: 14 }]);
  });

  it("never cuts into a match inside the indentation", () => {
    const result = compactMatch(match("    x", [[2, 4]]));
    expect(result.match.lineContent).toBe("  x");
    expect(result.match.matchRanges).toEqual([{ start: 0, end: 2 }]);
  });

  it("leaves short unindented lines alone", () => {
    const original = match("useState()", [[0, 8]]);
    expect(compactMatch(original)).toEqual({ match: original, clipped: false });
  });
});

describe("groupMatches", () => {
  it("groups by path in order and keeps each result's index", () => {
    const a = { ...match("x", [[0, 1]]), path: "a.ts" } as ProjectContentMatch;
    const b = { ...match("y", [[0, 1]]), path: "b.ts" } as ProjectContentMatch;
    const groups = groupMatches([a, b, a]);
    expect(groups.map((group) => group.path)).toEqual(["a.ts", "b.ts"]);
    expect(groups[0]?.matches.map((entry) => entry.resultIndex)).toEqual([0, 2]);
  });
});
