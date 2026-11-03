import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows, liveWorkEntryLabel } from "./MessagesTimeline.logic";

describe("long active turns", () => {
  it.each([false, true])(
    "keeps every step in order and only the running one live, opened=%s",
    (opened) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        ...(opened ? { expandedWorkGroupIds: new Set(["work-group:work-entry-999"]) } : {}),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live?.entry.id).toBe("work-999");
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active)).toContain("999");
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(["work-999"]);
      expect(live?.expanded).toBe(opened);
      // Every earlier step is a row of its own, in order, on the turn's rail.
      const steps = rows.filter((row) => row.kind === "work" || row.kind === "work-toggle");
      expect(steps.slice(0, 3).map((row) => row.id)).toEqual([
        "work-entry-0",
        "work-entry-1",
        "work-entry-2",
      ]);
      expect(steps.filter((row) => row.id !== "work-group:work-entry-999:details")).toHaveLength(
        999,
      );
      expect(steps.every((row) => row.onRail === true)).toBe(true);
    },
  );
});
