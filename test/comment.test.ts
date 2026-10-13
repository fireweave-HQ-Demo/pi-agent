import assert from "node:assert/strict";
import { test } from "node:test";
import { renderComment } from "../src/comment.js";
import { publicReview, type ScoreResult } from "../src/graph.js";

test("review comment is the auditable card", () => {
  const analysis = {
    pr: { owner: "acme", repo: "app", head_sha: "abc123" },
    hunks: [{ file: "apps/api/src/application/games.ts" }, { file: "apps/web/src/Lobby.tsx" }],
    decision_points: [{ id: "D1" }, { id: "D2" }, { id: "D3" }],
    topics: [
      {
        id: "T1",
        description: "A signed-in player can pin up to six known games",
        where: "apps/api/src/application/games.ts:276",
        direction: "neither",
        change_test: "yes",
        change_verified: true,
        interrogated: true,
        questions: {
          C3: { state: "yes", citation: "pin-repo.ts:12", reason: "The pin list is stored and read on a later request.", verified: true },
          R1: { state: "all", citation: "router.ts:181", reason: "Any signed-in caller can pin.", verified: true },
          K: { state: "no", reason: "not on the core path" },
        },
        probes: [{ answer: "Two overlapping pins can land past six. That does not meet a failure pattern, so it adds nothing." }],
      },
      {
        id: "T2",
        description: "API errors now carry a code",
        where: "api.ts:60",
        direction: "neither",
        change_test: "yes",
        change_verified: true,
        interrogated: true,
        questions: { C3: { state: "no" }, R1: { state: "none" } },
      },
      {
        id: "T3",
        description: "The metrics catalog lists pin counters",
        where: "metrics-catalog.ts:240",
        direction: "neither",
        change_test: "yes",
        change_verified: true,
        interrogated: true,
        questions: {
          C5: { state: "yes", citation: "metrics-catalog.ts:240", reason: "names are listed", verified: true },
          R1: { state: "all", verified: false },
          K: { state: "no" },
        },
      },
    ],
    containment: {
      B1: { state: "no", reason: "The API route is not behind the flag." },
      B2: { state: "yes", reason: "a metric exists" },
      B3: { state: "no", reason: "No test covers the six-pin cap." },
    },
  };
  const score: ScoreResult = { score: 24, band: "Medium", complete: true, problems: [], part_a: 20, part_b: 4, rung: 2 };
  const body = renderComment(publicReview(analysis, score));
  assert.match(body, /## Summary by Fireweave/);
  assert.match(body, /\*\*Medium · 24\.\*\*/);
  assert.match(body, /### What changed/);
  assert.match(body, /The pin list is stored and read on a later request/);
  assert.equal(body.includes("Does an error, timeout"), false);
  assert.match(body, /20 \+ 4 = 24/);
  assert.match(body, /### Worth a look/);
  assert.match(body, /This did not raise the score/);
  assert.match(body, /Two overlapping pins can land past six/);
  assert.equal(body.includes("so it adds nothing"), false);
  assert.equal(body.includes("failure-pattern"), false);
  assert.equal(body.includes("Part A"), false);
  assert.match(body, /Also reviewed/);
  assert.match(body, /API errors now carry a code/);
  assert.match(body, /Who can reach this was not confirmed/);
  assert.equal(body.includes("null produced"), false);
  assert.match(body, /\*\*Flag\.\*\* The API route is not behind the flag/);
  assert.equal(body.includes("A metric exists"), false);
  assert.match(body, /https:\/\/github.com\/acme\/app\/blob\/abc123\/pin-repo.ts#L12/);
  assert.match(body, /https:\/\/fireweave.ai/);
  assert.equal(body.includes("half weight"), false);
});
