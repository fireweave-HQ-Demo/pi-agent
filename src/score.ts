import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeGraphScore, type ScoreResult } from "./graph.js";

export type { ScoreResult };

export function scorePyPath(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "harbor", "lib", "score.py");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

export function writeAndScore(opts: {
  analysis: unknown;
  outDir: string;
  head: string;
  base: string;
}): ScoreResult {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const analysisPath = path.join(opts.outDir, "analysis.json");
  fs.writeFileSync(analysisPath, JSON.stringify(opts.analysis, null, 2));
  const py = scorePyPath();
  if (py) {
    const scorePath = path.join(opts.outDir, "score.json");
    const cardPath = path.join(opts.outDir, "card.md");
    const run = spawnSync(
      "python3",
      [py, analysisPath, "--repo", opts.head, "--base", opts.base, "--out", scorePath, "--card", cardPath],
      { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`score.py failed: ${run.stderr || run.stdout}`);
    return JSON.parse(fs.readFileSync(scorePath, "utf8")) as ScoreResult;
  }
  return writeGraphScore({ analysis: opts.analysis as Record<string, unknown>, outDir: opts.outDir });
}
