import { describe, expect, it } from "vite-plus/test";

import { nestProjectsByFolder, selectPreviewThreads } from "./LegacySidebar.custom";
import type { SidebarThreadSummary } from "../types";

const project = (projectKey: string, workspaceRoot: string) => ({ projectKey, workspaceRoot });

describe("nestProjectsByFolder", () => {
  const projects = [
    project("repos", "/u/repos"),
    project("pegasus", "/u/repos/pegasus"),
    project("translations", "/u/repos/pegasus/usecases/translations"),
    project("repos2", "/u/repos2"),
  ];

  it("nests each project under its closest ancestor folder", () => {
    const { topLevelProjects, childProjectsByKey } = nestProjectsByFolder(projects, {});
    expect(topLevelProjects.map((p) => p.projectKey)).toEqual(["repos", "repos2"]);
    expect(childProjectsByKey.get("repos")?.map((p) => p.projectKey)).toEqual(["pegasus"]);
    expect(childProjectsByKey.get("pegasus")?.map((p) => p.projectKey)).toEqual(["translations"]);
  });

  it("keeps detached projects at the top level", () => {
    const { topLevelProjects } = nestProjectsByFolder(projects, { pegasus: true });
    expect(topLevelProjects.map((p) => p.projectKey)).toEqual(["repos", "pegasus", "repos2"]);
  });
});

describe("selectPreviewThreads", () => {
  const thread = (id: string, pinned: boolean) =>
    ({
      id,
      pinnedAt: pinned ? "2026-01-01T00:00:00.000Z" : null,
    }) as unknown as SidebarThreadSummary;

  it("never hides pinned threads behind Show more", () => {
    const ordered = [
      thread("p1", true),
      thread("p2", true),
      thread("a", false),
      thread("b", false),
    ];
    const { previewThreads, hasOverflowingThreads } = selectPreviewThreads(ordered, 1, false);
    expect(previewThreads.map((t) => t.id)).toEqual(["p1", "p2", "a"]);
    expect(hasOverflowingThreads).toBe(true);
  });
});
