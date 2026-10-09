import fs from "node:fs";
import path from "node:path";
import { BASE, B_IDS, C_IDS, F_IDS, K_MULT, REACH_MULT } from "./questions.js";

const F_WEIGHT: Record<string, number> = {
  F1: 10, F2: 5, F3: 10, F4: 10, F5: 12, F6: 7, F7: 8, F8: 6, F9: 12, F10: 8, F11: 8,
};
const AMP: Record<string, Record<string, number>> = {
  C1: { F1: 22, F4: 6, F11: 12 },
  C2: { F5: 22, F9: 22 },
  C3: { F7: 6, F10: 6 },
  C4: { F8: 6 },
};

interface Fact {
  state?: string;
  citation?: string;
  reason?: string;
  meets_direction?: boolean;
  verified?: boolean;
}

interface Topic {
  id: string;
  description: string;
  where: string;
  kind: string;
  direction: string;
  change_test: string;
  change_verified: boolean;
  interrogated: boolean;
  consumer?: { description?: string; citation?: string | null };
  core_path?: { path?: string | null };
  questions: Record<string, Fact>;
  probes?: Array<{ question?: string; answer?: string }>;
}

export interface ScoreResult {
  score: number;
  band: string;
  complete: boolean;
  problems: string[];
  part_a: number;
  part_b: number;
  rung: number;
}

function yes(fact: Fact | undefined, failure = false): boolean {
  if (!fact || fact.state !== "yes" || fact.verified !== true) return false;
  if (failure && fact.meets_direction !== true) return false;
  return true;
}

function reachOf(topic: Topic): number {
  const fact = topic.questions.R1;
  if (!fact || fact.verified !== true) return 0;
  return REACH_MULT[String(fact.state ?? "unknown")] ?? 0;
}

function coreOf(topic: Topic): number {
  const fact = topic.questions.K;
  if (fact?.state === "yes" && fact.verified === true) return K_MULT.yes;
  if (fact?.state === "no") return K_MULT.no;
  return K_MULT.unknown;
}

function clearReason(topic: Topic): string {
  if (topic.direction === "narrower") return "narrower";
  if (topic.change_test !== "yes" || !topic.change_verified) return "change not verified";
  if (!C_IDS.some((c) => yes(topic.questions[c]))) return "no consequence node yes";
  const reach = topic.questions.R1;
  const wouldReach = (REACH_MULT[String(reach?.state ?? "unknown")] ?? 0) > 0;
  if (wouldReach && reach?.verified !== true) return "reach not verified";
  if (reachOf(topic) === 0) return "no existing caller";
  if (!topic.interrogated) return "not interrogated";
  return "no scoring consequence";
}

function topicScore(topic: Topic): { score: number; base: string | null; counted: string[] } {
  if (!topic.interrogated) return { score: 0, base: null, counted: [] };
  if (!(topic.change_test === "yes" && topic.change_verified)) return { score: 0, base: null, counted: [] };
  if (topic.direction === "narrower") return { score: 0, base: null, counted: [] };
  const candidates = C_IDS.filter((c) => yes(topic.questions[c]));
  if (candidates.length === 0 || reachOf(topic) === 0) return { score: 0, base: null, counted: [] };
  const k = coreOf(topic);
  const reach = reachOf(topic);
  let best = -1;
  let base: (typeof C_IDS)[number] = candidates[0];
  let counted: string[] = [];
  for (const node of candidates) {
    const used: string[] = [];
    let severity = BASE[node];
    for (const f of F_IDS) {
      if (!yes(topic.questions[f], true)) continue;
      used.push(f);
      severity += F_WEIGHT[f] + (AMP[node]?.[f] ?? 0);
    }
    severity = Math.min(severity * k * reach, 100);
    if (severity > best || (severity === best && BASE[node] > BASE[base])) {
      best = severity;
      base = node;
      counted = used;
    }
  }
  return { score: best, base, counted };
}

function bandOf(score: number): string {
  if (score >= 70) return "Critical";
  if (score >= 45) return "High";
  if (score >= 20) return "Medium";
  return "Low";
}

function problemsOf(analysis: Record<string, unknown>, topics: Topic[]): string[] {
  const problems: string[] = [];
  const profile = analysis.profile as Record<string, unknown> | undefined;
  for (const id of ["P1", "P2", "P3", "P4", "P5", "P6", "P7"]) {
    if (!profile || profile[id] == null) problems.push(`profile missing ${id}`);
  }
  const hunks = (analysis.hunks as Array<{ enclosed?: boolean }> | undefined) ?? [];
  if (hunks.length === 0) problems.push("no hunks");
  const decisions = (analysis.decision_points as Array<{ change?: string }> | undefined) ?? [];
  if (decisions.some((d) => !d.change)) problems.push("a decision point has no change test");
  for (const topic of topics) {
    for (const id of ["C1", "C2", "C3", "C4", "C5", "R1", "R2", "K"]) {
      if (!topic.questions[id]?.state) problems.push(`${topic.id} missing ${id}`);
    }
    if (!topic.direction || !topic.kind || !topic.description) problems.push(`${topic.id} missing direction, kind, or description`);
    if (topic.interrogated) {
      for (const id of F_IDS) {
        if (!topic.questions[id]?.state) problems.push(`${topic.id} missing ${id}`);
      }
    }
  }
  const scored = topics.some((t) => topicScore(t).score > 0);
  const containment = (analysis.containment as Record<string, Fact> | undefined) ?? {};
  if (scored) {
    for (const id of B_IDS) if (!containment[id]?.state) problems.push(`missing ${id}`);
  }
  return problems;
}

function card(analysis: Record<string, unknown>, topics: Topic[], partA: number, partB: number, rung: number, score: number, band: string): string {
  const ranked = topics
    .map((t) => ({ t, ...topicScore(t) }))
    .sort((a, b) => b.score - a.score || a.t.where.localeCompare(b.t.where));
  const earning = ranked.filter((r) => r.score > 0);
  const lines: string[] = ["Verdict", `  ${score} — ${band}. ${earning[0]?.t.description ?? "No topic earned points."}`, "", "What earned points"];
  if (earning.length === 0) lines.push("  none");
  earning.forEach((row, i) => {
    const weight = i === 0 ? "full weight" : "half weight";
    const k = row.t.questions.K?.state ?? "unknown";
    const reach = row.t.questions.R1?.state ?? "unknown";
    lines.push(`  ${i + 1}. ${row.t.description} — \`${row.t.where}\``);
    lines.push(`     Base: ${row.base}. Consumer: ${row.t.consumer?.description ?? "none"} ${row.t.consumer?.citation ?? ""}`.trimEnd());
    lines.push(`     Counted: ${row.counted.join(", ") || "none"}`);
    lines.push(`     Core path: ${k}. Reach: ${reach}. Topic score ${row.score}, ${weight}.`);
    for (const probe of row.t.probes ?? []) {
      const text = probe.answer || probe.question;
      if (text) lines.push(`     Look at: ${text}`);
    }
  });
  lines.push("", "Cleared");
  const overflow = topics.filter((t) => !t.interrogated && topicScore({ ...t, interrogated: true }).score > 0);
  const decisions = (analysis.decision_points as Array<{ id?: string; where?: string; change?: string }> | undefined) ?? [];
  const unchanged = decisions.filter((d) => d.change === "no");
  const ambiguous = topics.filter((t) => t.change_test === "ambiguous");
  const cleared = topics.filter((t) => topicScore(t).score === 0 && !overflow.includes(t) && !ambiguous.includes(t));
  if (cleared.length === 0 && unchanged.length === 0) lines.push("  none");
  for (const t of cleared) lines.push(`  ${t.id} ${t.where}: ${clearReason(t)}`);
  for (const d of unchanged) lines.push(`  ${[d.id, d.where].filter(Boolean).join(" ")}: did not change`);
  const containment = (analysis.containment as Record<string, Fact> | undefined) ?? {};
  lines.push("", "Containment");
  if (partA === 0) lines.push("  none (Part A is 0)");
  else {
    for (const id of B_IDS) lines.push(`  ${id}: ${containment[id]?.state ?? "missing"} ${containment[id]?.reason ?? containment[id]?.citation ?? ""}`.trimEnd());
    lines.push(`  Rung ${rung} (Part A ${partA}). Part B ${partB}.`);
  }
  lines.push("", "Unresolved");
  const unknown: string[] = [];
  for (const t of ambiguous) unknown.push(`${t.id}: change still ambiguous`);
  for (const t of topics) {
    for (const [id, fact] of Object.entries(t.questions)) {
      if (fact.state === "unknown") unknown.push(`${t.id} ${id}: ${fact.reason ?? ""}`.trim());
    }
  }
  for (const id of B_IDS) if (containment[id]?.state === "unknown") unknown.push(`${id}: ${containment[id]?.reason ?? ""}`.trim());
  lines.push(unknown.length ? unknown.map((u) => `  ${u}`).join("\n") : "  none");
  const hunks = (analysis.hunks as unknown[] | undefined) ?? [];
  const profile = analysis.profile as { P1?: Array<{ outcome?: string }> } | undefined;
  const outcomes = (profile?.P1 ?? []).map((o) => o.outcome).filter(Boolean);
  lines.push(
    "",
    "Coverage",
    `  ${hunks.length} hunks, ${decisions.length} decision points, ${topics.length} topics, ${topics.filter((t) => t.interrogated).length} interrogated (N = ${String(analysis.top_n ?? 6)}).`,
    `  Not interrogated: ${overflow.map((t) => `${t.description} (${t.where})`).join("; ") || "none"}.`,
    "",
    "Method",
    "  pr-decision-analysis, graph §5 (2026-10-08, placeholder weights). The model set states. This file added the numbers.",
    `  Profile: ${outcomes.join(" | ") || "profile unknown"}.`,
    `  Part A ${partA} + Part B ${partB} = ${score}. Verify on every yes. An unverified yes is dropped.`,
  );
  return lines.join("\n") + "\n";
}

/** skill.md §5. The model never supplies these numbers. */
export function writeGraphScore(opts: {
  analysis: Record<string, unknown>;
  outDir: string;
}): ScoreResult {
  const topics = ((opts.analysis.topics as Topic[] | undefined) ?? []).map((t) => ({
    ...t,
    questions: t.questions ?? {},
  }));
  const scored = topics.map((t) => topicScore(t)).sort((a, b) => b.score - a.score);
  let partA = scored[0]?.score ?? 0;
  for (const row of scored.slice(1)) partA += row.score * 0.5;
  partA = Math.min(partA, 70);
  let rung = 0;
  let partB = 0;
  const containment = (opts.analysis.containment as Record<string, Fact> | undefined) ?? {};
  if (partA > 0) {
    rung = partA < 20 ? 1 : partA < 45 ? 2 : partA < 70 ? 3 : 4;
    const noes = B_IDS.filter((id) => containment[id]?.state === "no").length;
    partB = rung * noes;
  }
  const score = Math.max(0, Math.min(100, partA + partB));
  const band = bandOf(score);
  const problems = problemsOf(opts.analysis, topics);
  const result: ScoreResult = { score, band, complete: problems.length === 0, problems, part_a: partA, part_b: partB, rung };
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(path.join(opts.outDir, "score.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(opts.outDir, "card.md"), card(opts.analysis, topics, partA, partB, rung, score, band));
  return result;
}
