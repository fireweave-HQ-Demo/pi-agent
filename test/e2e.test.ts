import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runIdentityE2E } from "../src/e2e.js";
import { assertBashInside, resolveInside } from "../src/root.js";

test("phase root rejects paths that leave it", () => {
  const root = fs.mkdtempSync(path.join("/tmp", "root-"));
  assert.equal(path.basename(resolveInside(root, "guard.ts")), "guard.ts");
  assert.throws(() => resolveInside(root, "../guard.ts"));
  assert.throws(() => assertBashInside(root, "cd /"));
  assert.throws(() => assertBashInside(root, "cat /etc/passwd"));
});

test("e2e identity guard: checkout, phases, score.py → 75 Critical", async () => {
  const result = await runIdentityE2E();
  assert.equal(result.score.complete, true, JSON.stringify(result.score.problems));
  assert.equal(result.score.score, 75);
  assert.equal(result.score.band, "Critical");
  const phase3 = result.seen.filter((s) => s.phase === 3);
  assert.ok(phase3.length > 0);
  for (const spec of phase3) {
    assert.equal("profile" in spec, false);
    assert.equal(spec.prompt.includes("whether a caller is allowed"), false);
  }
  const phase0 = result.seen.filter((s) => s.phase === 0);
  assert.ok(phase0.every((s) => s.root.endsWith("/base") || s.root.endsWith(`${path.sep}base`)));
  assert.ok(fs.existsSync(path.join(result.outDir, "card.md")));
  assert.ok(fs.existsSync(path.join(result.outDir, "analysis.json")));
});
