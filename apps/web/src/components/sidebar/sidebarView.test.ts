import type { SidebarView } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarView } from "./sidebarView";

const ALL: SidebarView[] = ["plain", "legacy", "projects"];

// [legacySidebarEnabled, boringSidebarEnabled, offered views, expected view]
const CASES: Array<[boolean, boolean, SidebarView[], SidebarView]> = [
  [true, false, ALL, "projects"],
  [true, true, ALL, "projects"],
  [false, true, ALL, "legacy"],
  [false, false, ALL, "plain"],
  // The picked view was turned off in Settings: fall back to the first offered view.
  [false, false, ["projects", "legacy"], "legacy"],
  [true, false, ["plain"], "plain"],
];

describe("resolveSidebarView", () => {
  it("maps the stored flags to a view and falls back to an offered one", () => {
    for (const [legacy, boring, views, expected] of CASES) {
      expect(
        resolveSidebarView({
          sidebarViews: views,
          legacySidebarEnabled: legacy,
          boringSidebarEnabled: boring,
        }),
      ).toBe(expected);
    }
  });
});
