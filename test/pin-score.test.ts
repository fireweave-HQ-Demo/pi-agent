import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeGraphScore } from "../src/graph.js";

const no = (reason: string) => ({ state: "no", reason });

test("pin storage graph is 32 Medium", () => {
  const questions = (extra: Record<string, unknown>) => ({
    C1: no("not access control"),
    C2: no("bound parameters"),
    C3: no("not a durable record"),
    C4: no("one deployable"),
    C5: no("not user visible"),
    R1: { state: "none", reason: "no caller" },
    R2: no("one image"),
    K: no("does not feed P1"),
    ...extra,
  });
  const f = Object.fromEntries(
    ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11"].map((id) => [id, no("does not meet")]),
  );
  const analysis = {
    top_n: 6,
    profile: {
      P1: [{ outcome: "the match a player plays" }],
      P2: [],
      P3: { state: "no" },
      P4: { state: "yes" },
      P5: { state: "yes" },
      P6: { state: "no" },
      P7: { where_to_look: ["apps/web"] },
    },
    hunks: [{ id: "H1" }],
    decision_points: [
      { id: "D1", where: "games.ts:276", change: "yes" },
      { id: "D2", where: "history.ts:40", change: "no" },
    ],
    topics: [
      {
        id: "T1",
        description: "A signed-in player can pin up to six known games, and that list is stored and returned",
        where: "apps/api/src/application/games.ts:276",
        kind: "write",
        direction: "neither",
        change_test: "yes",
        change_verified: true,
        interrogated: true,
        consumer: { description: "pinRepo.list", citation: "pin-repo.ts:5" },
        questions: {
          ...questions({
            C3: { state: "yes", citation: "pin-repo.ts:12", verified: true },
            C5: { state: "yes", citation: "Lobby.tsx:199", verified: true },
            R1: { state: "all", citation: "router.ts:181", verified: true },
          }),
          ...f,
        },
        probes: [
          {
            question: "can two pins pass the in-memory cap?",
            answer:
              "pin() lists rows and then inserts, with the cap only in memory. The primary key stops the same game twice. Two overlapping pins of different games can land past six. That does not meet a failure pattern.",
          },
        ],
      },
      {
        id: "T2",
        description: "The lobby shows pin controls only when pin-games is on",
        where: "apps/web/src/Lobby.tsx:108",
        kind: "condition",
        direction: "neither",
        change_test: "yes",
        change_verified: true,
        interrogated: true,
        questions: {
          ...questions({
            C5: { state: "yes", citation: "Lobby.tsx:108", verified: true },
            R1: { state: "flag_or_cohort", citation: "Lobby.tsx:108", verified: true },
          }),
          ...f,
        },
        probes: [],
      },
      {
        id: "T3",
        description: "The metrics catalog now lists the pin counters",
        where: "apps/api/src/infrastructure/observability/metrics-catalog.ts:240",
        kind: "write",
        direction: "neither",
        change_test: "yes",
        change_verified: true,
        interrogated: true,
        questions: {
          ...questions({
            C5: { state: "yes", citation: "metrics-catalog.ts:240", verified: true },
            R1: { state: "all", citation: "router.ts:1", verified: true },
          }),
          ...f,
        },
        probes: [],
      },
      {
        id: "T4",
        description: "API errors now carry a code",
        where: "apps/web/src/api.ts:60",
        kind: "default",
        direction: "neither",
        change_test: "yes",
        change_verified: true,
        interrogated: false,
        questions: questions({}),
        probes: [],
      },
    ],
    containment: {
      B1: { state: "no", reason: "the API is not behind the flag" },
      B2: { state: "no", reason: "pin() emits no server metric" },
      B3: { state: "no", reason: "there is no test" },
    },
  };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-score-"));
  const result = writeGraphScore({ analysis, outDir });
  assert.equal(result.complete, true, JSON.stringify(result.problems));
  assert.equal(result.part_a, 26);
  assert.equal(result.part_b, 6);
  assert.equal(result.score, 32);
  assert.equal(result.band, "Medium");
  const card = fs.readFileSync(path.join(outDir, "card.md"), "utf8");
  assert.match(card, /Look at: pin\(\) lists rows/);
  assert.match(card, /no consequence node yes/);
  assert.match(card, /did not change/);
  assert.match(card, /Part A 26 \+ Part B 6 = 32/);
  const dropped = structuredClone(analysis);
  for (const topic of dropped.topics) {
    const reach = topic.questions.R1 as { verified?: boolean };
    delete reach.verified;
  }
  const droppedScore = writeGraphScore({ analysis: dropped, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "pin-dropped-")) });
  assert.equal(droppedScore.score, 0);
  assert.equal(droppedScore.band, "Low");
});
