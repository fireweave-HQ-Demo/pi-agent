import fs from "node:fs";
import path from "node:path";
import type { Asker, Trees } from "./accept.js";
import { checkoutPullRequest } from "./checkout.js";
import { cursorAsker } from "./cursor.js";
import { loadEnv } from "./env.js";
import { localAsker } from "./local-asker.js";
import { analyze, readDiff } from "./machine.js";
import { writeAndScore, type ScoreResult } from "./score.js";

export interface UrlRun {
  score: ScoreResult;
  outDir: string;
}

function treesFromRun(runDir: string): Trees | null {
  const metaPath = path.join(runDir, "pr", "meta.json");
  const diffPath = path.join(runDir, "pr", "diff.patch");
  const head = path.join(runDir, "head");
  const base = path.join(runDir, "base");
  if (!fs.existsSync(metaPath) || !fs.existsSync(diffPath) || !fs.existsSync(head) || !fs.existsSync(base)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Trees["meta"] & { owner: string; repo: string; number: number };
  return { runDir, head, base, diffPath, meta };
}

export async function analyzeUrl(url: string, cwd = process.cwd(), asker?: Asker): Promise<UrlRun> {
  loadEnv();
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
  if (!match) throw new Error(`not a GitHub pull request URL: ${url}`);
  const slug = `${match[1]}__${match[2]}__${match[3]}`;
  const root = fs.existsSync(path.join(cwd, "pi-agent", "package.json")) ? path.join(cwd, "pi-agent") : cwd;
  const runDir = path.join(root, "runs", slug);
  const existing = treesFromRun(runDir);
  const trees = existing ?? (() => {
    process.stderr.write(`checkout ${url}\n`);
    return checkoutPullRequest(url, runDir);
  })();
  if (existing) process.stderr.write(`reuse checkout ${url}\n`);
  const outDir = path.join(runDir, "out");
  const analysis = await analyze(
    { trees, diffText: readDiff(trees), cacheDir: path.join(root, "runs", "cache") },
    asker ?? (process.argv.includes("--local") ? localAsker() : cursorAsker()),
  );
  const score = writeAndScore({ analysis, outDir, head: trees.head, base: trees.base });
  const summary = `${score.score} ${score.band} complete=${score.complete}\n${path.join(outDir, "card.md")}`;
  process.stderr.write(`${summary}\n`);
  fs.writeFileSync(path.join(outDir, "summary.txt"), summary);
  if (!score.complete) throw new Error(`incomplete: ${score.problems.join("; ")}`);
  return { score, outDir };
}
