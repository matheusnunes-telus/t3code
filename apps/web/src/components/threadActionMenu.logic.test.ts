import { describe, expect, it } from "vite-plus/test";

import type { ProjectId } from "@t3tools/contracts";

import {
  buildMoveToProjectChoices,
  buildThreadActionMenuItems,
  moveToProjectActionId,
  parseMoveToProjectAction,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

const projectId = (id: string) => id as ProjectId;

describe("move to project", () => {
  const thread = { environmentId: "env-a", projectId: projectId("current") };
  const project = (id: string, title: string, extra: object = {}) => ({
    environmentId: "env-a",
    id: projectId(id),
    title,
    ...extra,
  });

  it("lists projects of the thread's environment, sorted, without archived or No project", () => {
    const choices = buildMoveToProjectChoices({
      enabled: true,
      thread,
      projects: [
        project("zed", "Zed"),
        project("current", "Current"),
        project("old", "Old", { archivedAt: "2026-01-01T00:00:00Z" }),
        project("scratch", "No project", { isScratch: true }),
        project("old-scratch", "No project"),
        { ...project("other-env", "Elsewhere"), environmentId: "env-b" },
        project("alpha", "Alpha"),
      ],
    });
    expect(choices.map((choice) => [choice.label, choice.isCurrent])).toEqual([
      ["Alpha", false],
      ["Current", true],
      ["Zed", false],
    ]);
  });

  it("offers nothing when the setting is off", () => {
    expect(
      buildMoveToProjectChoices({
        enabled: false,
        thread,
        projects: [project("alpha", "Alpha")],
      }),
    ).toEqual([]);
  });

  it("shows a submenu that checks the current project and round-trips ids", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      moveToProject: [
        { projectId: projectId("alpha"), label: "Alpha", isCurrent: false },
        { projectId: projectId("current"), label: "Current", isCurrent: true },
      ],
    });
    const menu = items.find((item) => item.id === "move-to-project");
    expect(menu?.children?.map((child) => [child.label, child.checked, child.disabled])).toEqual([
      ["Alpha", false, false],
      ["Current", true, true],
    ]);
    const clicked = menu?.children?.[0]?.id ?? "";
    expect(parseMoveToProjectAction(clicked)).toBe("alpha");
    expect(moveToProjectActionId(projectId("alpha"))).toBe(clicked);
    expect(parseMoveToProjectAction("rename")).toBeNull();
  });

  it("hides the submenu without choices and disables it while the thread runs", () => {
    expect(buildThreadActionMenuItems(baseState).some((i) => i.id === "move-to-project")).toBe(
      false,
    );
    const running = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      moveToProject: [{ projectId: projectId("alpha"), label: "Alpha", isCurrent: false }],
    });
    expect(running.find((item) => item.id === "move-to-project")?.disabled).toBe(true);
  });
});
