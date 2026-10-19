import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps runs in the order their items were created", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:queued-run-order");
    const item = (name: string, run: number, runBucket?: number) =>
      positions.allocate({
        threadId,
        turnItemId: TurnItemId.make(name),
        runId: RunId.make(`run:${run}`),
        runOrdinal: run,
        ...(runBucket === undefined ? {} : { runBucket }),
      });

    // Runs in the order they started: positions follow the run number.
    assert.equal(yield* item("a1", 1), 1_000_001);
    assert.equal(yield* item("a2", 1), 1_000_002);
    assert.equal(yield* item("b1", 2), 2_000_001);

    // Run 3 was queued first but starts after run 4 (queued later, sent right away).
    assert.equal(yield* item("d1", 4), 4_000_001);
    const queuedFirst = yield* item("c1", 3);
    assert.equal(queuedFirst, 4_000_002);
    // Its later items stay with it, even after run 5 has started.
    assert.equal(yield* item("e1", 5), 5_000_001);
    assert.equal(yield* item("c2", 3, Math.floor(queuedFirst / 1_000_000)), 4_000_003);
  }).pipe(Effect.provide(layerTest)),
);
