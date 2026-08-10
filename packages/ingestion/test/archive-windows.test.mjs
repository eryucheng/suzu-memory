import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationArchiveWindows,
  groupConversationEventsByArchiveWindow,
  logicalArchiveEventId,
  packConversationArchiveWindows,
  toProcessingArchiveWindows,
} from "../src/index.mjs";

function event({
  id,
  unitId,
  windowId = "conversation-a",
  text = id,
  occurredAt,
  status = "pending",
  fragment = null,
} = {}) {
  return {
    id: `input-${id}`,
    external_id: fragment ? `${id}:fragment:${fragment.index}` : id,
    status,
    occurred_at: occurredAt || `2026-08-08T00:00:${String(Number(id.replace(/\D/g, "") || 0)).padStart(2, "0")}.000Z`,
    content: { text },
    metadata: {
      memoryWindow: { id: windowId, unitId },
      ...(fragment ? { suzuMemoryFragment: fragment } : {}),
    },
  };
}

test("conversation archive windows use disjoint cores and read-only boundary context", () => {
  const events = [
    event({ id: "u1", unitId: "turn-1", text: "第一轮用户" }),
    event({ id: "a1", unitId: "turn-1", text: "第一轮助手" }),
    event({ id: "u2", unitId: "turn-2", text: "第二轮用户" }),
    event({ id: "a2", unitId: "turn-2", text: "第二轮助手" }),
    event({ id: "u3", unitId: "turn-3", text: "第三轮用户" }),
    event({ id: "a3", unitId: "turn-3", text: "第三轮助手" }),
  ];
  const windows = createConversationArchiveWindows({ memoryWindowId: "conversation-a", events }, {
    maximumEvents: 2,
    maximumContentCharacters: 10_000,
    maximumPreviousContextMessages: 2,
    maximumPreviousContextCharacters: 10_000,
    maximumContinuationGuidanceMessages: 2,
    maximumContinuationGuidanceCharacters: 10_000,
  });

  assert.equal(windows.length, 3);
  assert.deepEqual(windows.map((window) => window.coreEvents.map(logicalArchiveEventId)), [
    ["u1", "a1"], ["u2", "a2"], ["u3", "a3"],
  ]);
  assert.deepEqual(windows[1].previousContextEvents.map(logicalArchiveEventId), ["u1", "a1"]);
  assert.deepEqual(windows[1].continuationGuidanceEvents.map(logicalArchiveEventId), ["u3", "a3"]);
  const coreIds = windows.flatMap((window) => window.coreEvents.map(logicalArchiveEventId));
  assert.equal(new Set(coreIds).size, coreIds.length);

  const processing = toProcessingArchiveWindows(windows);
  assert.deepEqual(processing[1].coreEventIds, ["u2", "a2"]);
  assert.deepEqual(
    processing[1].previousContextEvents.map(logicalArchiveEventId),
    ["u1", "a1"],
  );
});

test("archive planner keeps fragmented long messages as one logical core event", () => {
  const fragments = [
    event({
      id: "long-message",
      unitId: "turn-1",
      text: "第一段",
      fragment: {
        parentEventId: "long-message", index: 1, count: 2,
        originalCharacters: 6, startCharacter: 0, endCharacter: 3,
      },
    }),
    event({
      id: "long-message",
      unitId: "turn-1",
      text: "第二段",
      fragment: {
        parentEventId: "long-message", index: 2, count: 2,
        originalCharacters: 6, startCharacter: 3, endCharacter: 6,
      },
    }),
    event({ id: "reply", unitId: "turn-1", text: "同一轮回复" }),
  ];
  const windows = createConversationArchiveWindows({ memoryWindowId: "conversation-a", events: fragments }, {
    maximumEvents: 2,
    maximumContentCharacters: 10_000,
  });
  assert.equal(windows.length, 1);
  assert.deepEqual(
    toProcessingArchiveWindows(windows)[0].coreEventIds,
    ["long-message", "reply"],
  );
});

test("plans stay isolated by their host conversation identity and pack without core overlap", () => {
  const first = event({ id: "first", unitId: "turn-1", windowId: "conversation-a" });
  const second = event({ id: "second", unitId: "turn-1", windowId: "conversation-b" });
  const plans = groupConversationEventsByArchiveWindow([first, second]);
  assert.deepEqual(plans.map((plan) => plan.memoryWindowId), ["conversation-a", "conversation-b"]);

  const windows = plans.flatMap((plan) => createConversationArchiveWindows(plan, {
    maximumEvents: 1,
    maximumContentCharacters: 10_000,
  }));
  const packs = packConversationArchiveWindows(windows, {
    maximumEvents: 2,
    maximumContentCharacters: 10_000,
  });
  assert.equal(packs.length, 1);
  assert.deepEqual(
    packs[0].windows.flatMap((window) => window.coreEvents.map(logicalArchiveEventId)),
    ["first", "second"],
  );
});
