import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { hasDismissedResumeCompaction } from "@t3tools/client-runtime/state/context-window";
import {
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("GPT-5.6 Sol");
  });
});

describe("hasDismissedResumeCompaction", () => {
  it("recognizes the native resume dialog's permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 2h 0m old and uses 250,000 tokens. Compact it before continuing?":
                "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores unrelated questions that end with Claude's compaction prompt", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "The build cache is large. Compact it before continuing?": "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });
});
