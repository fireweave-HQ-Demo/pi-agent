import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AskSpec } from "./accept.js";
import { checkoutLocal } from "./checkout.js";
import { cursorAsker } from "./cursor.js";
import { identityAsker } from "./identity.js";
import { analyze } from "./machine.js";
import { writeAndScore, type ScoreResult } from "./score.js";

function commit(repo: string, message: string): string {
  const r = spawnSync(
    "git",
    ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-q", "-m", message],
    { cwd: repo, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

function writeRepo(repo: string): { base: string; head: string } {
  fs.mkdirSync(path.join(repo, "db/migrations"), { recursive: true });
  const guard = (check: string) =>
    [
      "export function requireRole(role: string): boolean {",
      "  if (!role) return false;",
      "  return false;",
      "}",
      "",
      "export function act(role: string) {",
      "  return role;",
      "}",
      "",
      "export function requireRoleUnit(role: string): boolean {",
      "  const roleOk = true;",
      `  ${check}`,
      "  if (!roleOk) return false;",
      "  const next = true;",
      "  return act(role);",
      "}",
      "",
    ].join("\n");
  fs.writeFileSync(path.join(repo, "routes.ts"), "export const ui = true;\nexport const services = true;\n");
  fs.writeFileSync(
    path.join(repo, "accounts.ts"),
    "export const owner = 'acme';\nexport const repo = 'accounts';\nexport function act(role: string) { return role; }\n",
  );
  fs.writeFileSync(path.join(repo, "db/migrations/001.sql"), "create table accounts(id int);\n");
  fs.writeFileSync(path.join(repo, "guard.ts"), guard("return role === 'admin';"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["add", "."], { cwd: repo });
  const base = commit(repo, "base");
  fs.writeFileSync(path.join(repo, "guard.ts"), guard("return role === 'admin' || role === 'moderator';"));
  spawnSync("git", ["add", "guard.ts"], { cwd: repo });
  const head = commit(repo, "head");
  return { base, head };
}

export interface E2EResult {
  score: ScoreResult;
  seen: AskSpec[];
  outDir: string;
  headSha: string;
  baseSha: string;
}

/** Local git checkout → phase machine → score.py. No model and no network. */
function prepare(): { trees: ReturnType<typeof checkoutLocal>; diffText: string; root: string; headSha: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-decision-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  const shas = writeRepo(origin);
  const trees = checkoutLocal({
    repo: origin,
    head: shas.head,
    base: shas.base,
    runDir: path.join(root, "run"),
    owner: "acme",
    repoName: "accounts",
    number: 1,
  });
  return {
    trees,
    diffText: fs.readFileSync(trees.diffPath, "utf8"),
    root,
    headSha: shas.head,
    baseSha: shas.base,
  };
}

async function finish(prep: ReturnType<typeof prepare>, asker: ReturnType<typeof identityAsker>): Promise<E2EResult> {
  const analysis = await analyze(
    { trees: prep.trees, diffText: prep.diffText, cacheDir: path.join(prep.root, "cache") },
    asker,
  );
  const score = writeAndScore({
    analysis,
    outDir: path.join(prep.root, "out"),
    head: prep.trees.head,
    base: prep.trees.base,
  });
  return { score, seen: [], outDir: path.join(prep.root, "out"), headSha: prep.headSha, baseSha: prep.baseSha };
}

/** Canned answers. Used by the unit test so it does not call Cursor. */
export async function runIdentityE2E(): Promise<E2EResult> {
  const prep = prepare();
  const seen: AskSpec[] = [];
  const result = await finish(prep, identityAsker(seen));
  result.seen = seen;
  return result;
}

/** Same fixture repo, every question answered by Cursor using CURSOR_API_KEY. */
export async function runCursorE2E(): Promise<E2EResult> {
  const prep = prepare();
  const seen: AskSpec[] = [];
  const asker = cursorAsker();
  const wrapped = {
    ask: async (spec: AskSpec) => {
      seen.push(spec);
      return asker.ask(spec);
    },
  };
  const result = await finish(prep, wrapped);
  result.seen = seen;
  return result;
}
