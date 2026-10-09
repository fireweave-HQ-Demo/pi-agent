import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Trees } from "./accept.js";
import { envValue, scrub } from "./env.js";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${scrub(r.stderr || r.stdout || "")}`);
  return r.stdout.trim();
}

/**
 * Same fetch-by-SHA and remote scrub as harbor/image/checkout.sh.
 * Writes under runDir instead of /work, /base, and /pr, which that script hardcodes.
 */
export function checkoutLocal(opts: {
  repo: string;
  head: string;
  base: string;
  runDir: string;
  owner?: string;
  repoName?: string;
  number?: number;
}): Trees {
  fs.mkdirSync(opts.runDir, { recursive: true });
  const work = path.join(opts.runDir, "head");
  const base = path.join(opts.runDir, "base");
  const pr = path.join(opts.runDir, "pr");
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(pr, { recursive: true });
  const bare = spawnSync("git", ["rev-parse", "--is-bare-repository"], { cwd: opts.repo, encoding: "utf8" });
  const localGit = fs.existsSync(path.join(opts.repo, ".git")) || bare.stdout.trim() === "true";
  if (localGit) {
    git(opts.repo, ["cat-file", "-e", `${opts.head}^{commit}`]);
    git(opts.repo, ["cat-file", "-e", `${opts.base}^{commit}`]);
    git(opts.repo, ["worktree", "add", "-q", "--detach", work, opts.head]);
    git(opts.repo, ["worktree", "add", "-q", "--detach", base, opts.base]);
  } else {
    git(opts.runDir, ["init", "-q", work]);
    git(work, ["remote", "add", "origin", opts.repo]);
    const fetched = spawnSync("git", ["fetch", "-q", "--no-tags", "origin", opts.head, opts.base], {
      cwd: work,
      encoding: "utf8",
    });
    if (fetched.status !== 0) throw new Error(`fetch failed: ${fetched.stderr}`);
    git(work, ["-c", "advice.detachedHead=false", "checkout", "-q", opts.head]);
    git(work, ["remote", "remove", "origin"]);
    git(work, ["worktree", "add", "-q", "--detach", base, opts.base]);
  }
  const diff = git(work, ["diff", "--find-renames", opts.base, opts.head]);
  fs.writeFileSync(path.join(pr, "diff.patch"), diff.endsWith("\n") ? diff : diff + "\n");
  const meta = {
    owner: opts.owner ?? "",
    repo: opts.repoName ?? path.basename(opts.repo),
    number: opts.number ?? 0,
    base_sha: opts.base,
    head_sha: opts.head,
    head_dir: work,
    base_dir: base,
    diff: path.join(pr, "diff.patch"),
  };
  fs.writeFileSync(path.join(pr, "meta.json"), JSON.stringify(meta, null, 2));
  return {
    runDir: opts.runDir,
    head: work,
    base,
    diffPath: path.join(pr, "diff.patch"),
    meta: {
      owner: meta.owner,
      repo: meta.repo,
      number: meta.number,
      base_sha: opts.base,
      head_sha: opts.head,
      url: opts.owner && opts.number ? `https://github.com/${opts.owner}/${meta.repo}/pull/${opts.number}` : undefined,
    },
  };
}

function authedRepoUrl(owner: string, repo: string): string {
  const token = envValue("GITHUB_TOKEN");
  if (!token) return `https://github.com/${owner}/${repo}.git`;
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

function gitAuth(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  const shown = args.map((arg) => (arg.includes("x-access-token") ? "https://github.com/..." : arg)).join(" ");
  if (r.status !== 0) throw new Error(`git ${shown} failed: ${scrub(r.stderr || r.stdout || "")}`);
  return r.stdout.trim();
}

function pullJson(owner: string, repo: string, number: number): { base: { sha: string; ref: string }; head: { sha: string } } {
  const token = envValue("GITHUB_TOKEN");
  const args = ["-fsS", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: pr-decision-agent"];
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  args.push(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`);
  const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`GitHub pull request lookup failed: ${scrub(r.stderr || "")}`);
  return JSON.parse(r.stdout) as { base: { sha: string; ref: string }; head: { sha: string } };
}

/** Fetch a GitHub pull request into base and head worktrees. Profile is read at the merge base. */
export function checkoutPullRequest(url: string, runDir: string): Trees {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
  if (!match) throw new Error(`not a GitHub pull request URL: ${url}`);
  const owner = match[1];
  const repoName = match[2];
  const number = Number(match[3]);
  const pr = pullJson(owner, repoName, number);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const mirror = path.join(runDir, "mirror.git");
  const clean = `https://github.com/${owner}/${repoName}.git`;
  try {
    gitAuth(runDir, ["clone", "--bare", "--filter=blob:none", "--quiet", authedRepoUrl(owner, repoName), mirror]);
    gitAuth(mirror, ["fetch", "--quiet", "--no-tags", "origin", `pull/${number}/head`]);
    const head = gitAuth(mirror, ["rev-parse", "FETCH_HEAD"]);
    gitAuth(mirror, ["fetch", "--quiet", "--no-tags", "origin", pr.base.ref]);
    const baseTip = gitAuth(mirror, ["rev-parse", "FETCH_HEAD"]);
    const merged = spawnSync("git", ["merge-base", baseTip, head], { cwd: mirror, encoding: "utf8" });
    const base = merged.status === 0 && merged.stdout.trim() ? merged.stdout.trim() : pr.base.sha;
    return checkoutLocal({ repo: mirror, head, base, runDir, owner, repoName, number });
  } finally {
    if (fs.existsSync(mirror)) spawnSync("git", ["remote", "set-url", "origin", clean], { cwd: mirror });
  }
}
