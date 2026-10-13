import fs from "node:fs";
import path from "node:path";
import { envValue, loadEnv, scrub } from "./env.js";
import { publicReview, type Asked, type Cited, type PublicReview, type ScoreResult } from "./graph.js";

const MARKER = "<!-- fireweave-review -->";

function reviewerText(text: string): string {
  return text
    .replace(/\ba P[1-7] outcome\b/g, "a core outcome")
    .replace(/\bP[1-7]\b\s*/g, "")
    .replace(/\s*That does not meet a failure pattern, so it adds nothing\.?/gi, "")
    .replace(/\s*It does not meet a failure pattern\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sentence(text: string): string {
  const clean = reviewerText(text).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const first = clean.split(/\s/)[0] ?? "";
  const leave = /[A-Z_]/.test(first) || /\(\)$/.test(first);
  const cased = leave ? clean : clean.charAt(0).toUpperCase() + clean.slice(1);
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
}

function lineOf(where: string): { path: string; line: number } | null {
  const match = /^(.+):(\d+)$/.exec(where.trim());
  if (!match) return null;
  return { path: match[1], line: Number(match[2]) };
}

function fileLink(review: PublicReview, where: string): string {
  const at = lineOf(where);
  if (!at) return where ? `\`${where}\`` : "";
  const { owner, repo, sha } = review.source;
  const name = at.path.split("/").pop();
  const label = `\`${name}:${at.line}\``;
  if (!owner || !repo || !sha) return label;
  return `[${label}](https://github.com/${owner}/${repo}/blob/${sha}/${at.path}#L${at.line})`;
}

export function reviewNotes(review: PublicReview): Cited[] {
  const seen = new Set<string>();
  return review.notes.filter((note) => {
    const at = lineOf(note.where);
    if (!at) return false;
    const key = `${at.path}:${at.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relevantAsk(ask: Asked, scored: boolean): boolean {
  if (ask.state === "Not asked" || ask.id === "R2" || ask.note.startsWith("Adds nothing")) return false;
  if (!scored) return /not verified|drops out|dropped out|Unknown|No existing caller|direction does not hold/.test(ask.note);
  return ask.state !== "No" || ask.id === "K";
}

function firstSentence(text: string): string {
  const clean = sentence(text);
  return clean.split(/(?<=[.!?])\s/)[0] ?? clean;
}

function phrase(text: string): string {
  const clean = sentence(text).replace(/\.$/, "");
  return /^[A-Z][a-z]/.test(clean) ? clean.charAt(0).toLowerCase() + clean.slice(1) : clean;
}

function lead(text: string): string {
  return phrase(firstSentence(text));
}

export function renderComment(review: PublicReview): string {
  const gaps = review.checks.filter((check) => check.state === "no");
  const shares = review.topics.map((topic) => topic.weighted);
  if (review.partB > 0) shares.push(review.partB);
  const shareLine = shares.length
    ? `${shares.join(" + ")} = ${review.score}.`
    : `${review.score}.`;
  const fromTopics = review.topics
    .map((topic) => `${topic.weighted} from ${lead(topic.title)}`)
    .join(". ");
  const fromGaps = review.partB > 0 ? ` Another ${review.partB} covers the rollout gaps below.` : "";
  const lines = [
    MARKER,
    "## Summary by Fireweave",
    "",
    `**${review.band} · ${review.score}.** ${sentence(review.verdict)}`,
    "",
    review.topics.length
      ? `${sentence(fromTopics)}${fromGaps} ${shareLine}`
      : `Nothing in this diff earned a score. ${shareLine}`,
    "",
    "### What changed",
    "",
    "| | |",
    "| --- | --- |",
  ];
  if (review.topics.length === 0) lines.push("| | Nothing in this diff changed a scored decision. |");
  for (const topic of review.topics) {
    const where = fileLink(review, topic.baseWhere || topic.where);
    const read = topic.consumer && !/read/i.test(topic.title) ? ` Read later by ${topic.consumer.text.replace(/\.$/, "")}.` : "";
    lines.push(`| ${where} | ${sentence(topic.title)}${read} |`);
  }
  const issues = review.topics.flatMap((topic) => topic.lookAt.map((probe) => ({ ...probe, where: probe.where || topic.where })));
  if (issues.length) {
    lines.push("", "### Worth a look");
    for (const probe of issues) {
      const text = sentence(probe.text);
      const parts = text.split(/(?<=[.!?])\s/);
      const head = parts[0] ?? text;
      const rest = parts.slice(1).join(" ");
      const extra = probe.inBank ? "" : "This did not raise the score.";
      const body = [rest, extra].filter(Boolean).join(" ");
      lines.push("", `**${head}** ${fileLink(review, probe.where)}`);
      if (body) lines.push("", body);
    }
  }
  if (gaps.length) {
    lines.push("", "### Before this is safe to roll out");
    for (const check of gaps) {
      const link = fileLink(review, check.where);
      lines.push(`- **${check.label}.** ${sentence(check.text)}${link ? ` ${link}` : ""}`);
    }
  }
  const cleared = review.others.filter((row) => row.bucket === "cleared");
  const unresolved = review.others.filter((row) => row.bucket === "unresolved");
  if (cleared.length || unresolved.length) {
    lines.push("", "<details>", "<summary>Also reviewed</summary>", "");
    for (const row of cleared) lines.push(`- ${sentence(row.title)} ${fileLink(review, row.where)} ${sentence(row.reason)}`);
    for (const row of unresolved) {
      const failed = row.asks.find((ask) => ask.id === "R1" && relevantAsk(ask, false));
      const cite = failed?.text ? ` ${sentence(failed.text)} ${fileLink(review, failed.where)}` : "";
      lines.push(`- ${sentence(row.title)} ${fileLink(review, row.where)} ${sentence(row.reason)}${cite}`);
    }
    lines.push("", "</details>");
  }
  lines.push(
    "",
    "---",
    "",
    `<sub>${review.coverage.files} files · ${review.coverage.hunks} hunks · ${review.coverage.decisions} decisions</sub>`,
    "",
    "Reviewed by **[Fireweave](https://fireweave.ai)**.",
    "",
  );
  return lines.join("\n");
}

interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

function pullRef(url: string): PullRef {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
  if (!match) throw new Error(`not a GitHub pull request URL: ${url}`);
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function token(): string {
  const value = envValue("GITHUB_TOKEN");
  if (!value) throw new Error("Set GITHUB_TOKEN in .env. It is read the same way as CURSOR_API_KEY and is not printed.");
  return value;
}

async function gh(method: string, apiPath: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pr-decision-agent",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${method} ${apiPath} failed: ${response.status} ${scrub(text).slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export async function postReview(url: string, cwd = process.cwd()): Promise<{ url: string; body: string }> {
  loadEnv();
  const ref = pullRef(url);
  const root = fs.existsSync(path.join(cwd, "pi-agent", "package.json")) ? path.join(cwd, "pi-agent") : cwd;
  const outDir = path.join(root, "runs", `${ref.owner}__${ref.repo}__${ref.number}`, "out");
  const analysisPath = path.join(outDir, "analysis.json");
  const scorePath = path.join(outDir, "score.json");
  if (!fs.existsSync(analysisPath) || !fs.existsSync(scorePath)) {
    throw new Error(`no finished run at ${outDir}. Analyze the pull request first.`);
  }
  const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8")) as Record<string, unknown> & {
    pr?: { head_sha?: string };
  };
  const score = JSON.parse(fs.readFileSync(scorePath, "utf8")) as ScoreResult;
  const review = publicReview(analysis, score);
  const body = renderComment(review);
  const listPath = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`;
  const existing = (await gh("GET", listPath)) as Array<{ id: number; body?: string }>;
  const prior = existing.find((comment) => (comment.body ?? "").includes(MARKER));
  const saved = prior
    ? ((await gh("PATCH", `/repos/${ref.owner}/${ref.repo}/issues/comments/${prior.id}`, { body })) as { html_url?: string })
    : ((await gh("POST", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body })) as { html_url?: string });

  const head = analysis.pr?.head_sha;
  const notes = reviewNotes(review)
    .map((row) => ({ text: sentence(row.text), where: row.where, at: lineOf(row.where) }))
    .filter((row): row is { text: string; where: string; at: { path: string; line: number } } => Boolean(row.at));
  if (head && notes.length) {
    const priorNotes = (await gh("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`)) as Array<{
      id: number;
      path?: string;
      line?: number;
      body?: string;
    }>;
    const fresh = [];
    for (const row of notes) {
      const same = priorNotes.find((note) => note.path === row.at.path && note.line === row.at.line);
      if (!same) fresh.push(row);
    }
    if (fresh.length) {
      try {
        await gh("POST", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
          commit_id: head,
          event: "COMMENT",
          comments: fresh.map((row) => ({
            path: row.at.path,
            line: row.at.line,
            side: "RIGHT",
            body: row.text,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`inline batch skipped: ${message}\n`);
        for (const row of fresh) {
          try {
            await gh("POST", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, {
              commit_id: head,
              path: row.at.path,
              line: row.at.line,
              side: "RIGHT",
              body: row.text,
            });
          } catch (one) {
            const detail = one instanceof Error ? one.message : String(one);
            process.stderr.write(`inline skipped ${row.at.path}:${row.at.line}: ${detail}\n`);
          }
        }
      }
    }
  }
  return { url: saved.html_url ?? url, body };
}
