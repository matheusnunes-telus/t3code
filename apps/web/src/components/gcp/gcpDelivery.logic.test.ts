import type { GcpDelivery } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardsResolved, chatDelivery } from "./gcpDelivery.logic";

const delivery = (number: number, stage: GcpDelivery["stage"], threadId = "chat"): GcpDelivery => ({
  threadId,
  key: "github.com/acme/app",
  title: "Change",
  repository: "acme/app",
  number,
  url: `https://example.test/pull/${number}`,
  mergedAt: "2026-11-06T00:00:00.000Z",
  commit: "abc",
  stage,
  testEnvironment: "NP",
  prodEnvironment: "Prod",
  run: null,
});

describe("chatDelivery", () => {
  it("is in prod only when every pull request of the chat is", () => {
    const summary = chatDelivery([delivery(1, "in-prod"), delivery(2, "on-test")], "chat");
    expect(summary?.stage).toBe("on-test");
    expect(summary?.label).toBe("#2");
  });

  it("puts a failure first and names every pull request at that stage", () => {
    const summary = chatDelivery(
      [delivery(1, "test-failed"), delivery(2, "test-failed"), delivery(3, "in-prod")],
      "chat",
    );
    expect(summary?.stage).toBe("test-failed");
    expect(summary?.label).toBe("#1, #2");
  });

  it("ignores other chats", () => {
    expect(chatDelivery([delivery(1, "merged", "other")], "chat")).toBeNull();
  });
});

describe("cardsResolved", () => {
  const card = (
    id: string,
    state: "pending" | "applying" | "applied" | "failed" | "dismissed",
  ) => ({
    id,
    threadId: "chat",
    state,
  });
  const chat = { expectedCards: 1, knownCardIds: ["old"] };

  it("settles a chat with no tickets right away", () => {
    expect(cardsResolved({ expectedCards: 0, knownCardIds: [] }, [], "chat")).toBe(true);
  });

  it("waits for the new card to arrive, not just for the list to be empty", () => {
    expect(cardsResolved(chat, [], "chat")).toBe(false);
    expect(cardsResolved(chat, [card("old", "dismissed")], "chat")).toBe(false);
  });

  it.each(["pending", "applying", "failed"] as const)("waits on a %s card", (state) => {
    expect(cardsResolved(chat, [card("new", state)], "chat")).toBe(false);
  });

  it.each(["applied", "dismissed"] as const)("settles once the card is %s", (state) => {
    expect(cardsResolved(chat, [card("new", state)], "chat")).toBe(true);
  });
});
