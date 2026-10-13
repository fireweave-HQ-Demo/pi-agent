import fs from "node:fs";
import path from "node:path";
import { BASE, B_IDS, C_IDS, F_IDS, K_MULT, QUESTIONS, REACH_MULT } from "./questions.js";

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

interface HazardPart {
  id: string;
  weight: number;
  amp: number;
}

interface ScoreParts {
  score: number;
  base: string | null;
  counted: string[];
  basePoints: number;
  hazards: HazardPart[];
  k: number;
  reach: number;
}

const EMPTY_SCORE: ScoreParts = { score: 0, base: null, counted: [], basePoints: 0, hazards: [], k: 1, reach: 0 };

function topicScore(topic: Topic): ScoreParts {
  if (!topic.interrogated) return EMPTY_SCORE;
  if (!(topic.change_test === "yes" && topic.change_verified)) return EMPTY_SCORE;
  if (topic.direction === "narrower") return EMPTY_SCORE;
  const candidates = C_IDS.filter((c) => yes(topic.questions[c]));
  if (candidates.length === 0 || reachOf(topic) === 0) return EMPTY_SCORE;
  const k = coreOf(topic);
  const reach = reachOf(topic);
  let best = -1;
  let picked: ScoreParts = { ...EMPTY_SCORE, k, reach };
  for (const node of candidates) {
    const hazards: HazardPart[] = [];
    let severity = BASE[node];
    for (const f of F_IDS) {
      if (!yes(topic.questions[f], true)) continue;
      const weight = F_WEIGHT[f];
      const amp = AMP[node]?.[f] ?? 0;
      hazards.push({ id: f, weight, amp });
      severity += weight + amp;
    }
    const score = Math.min(severity * k * reach, 100);
    const prior = (picked.base ?? node) as (typeof C_IDS)[number];
    if (score > best || (score === best && BASE[node] > BASE[prior])) {
      best = score;
      picked = { score, base: node, counted: hazards.map((row) => row.id), basePoints: BASE[node], hazards, k, reach };
    }
  }
  return picked;
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

const PLAIN: Record<string, string> = {
  narrower: "the change only tightens a check",
  "change not verified": "the before and after lines did not confirm a change",
  "no consequence node yes": "this does not change access, stored data, or what a person sees",
  "reach not verified": "who can reach this was not confirmed, so it was dropped",
  "no existing caller": "no existing caller reaches it",
  "not interrogated": "not reviewed in this pass",
  "no scoring consequence": "nothing in the change scored",
};

const NODE_NAME: Record<string, string> = {
  C1: "access",
  C2: "secret or interpreter",
  C3: "durable record",
  C4: "separate deploy",
  C5: "what a person sees",
  F1: "fail open",
  F2: "default changed",
  F3: "dimension left",
  F4: "widened set",
  F5: "client value decides",
  F6: "cap lost",
  F7: "runs twice or out of order",
  F8: "two versions",
  F9: "secret exposed",
  F10: "history rewritten",
  F11: "guard moved",
  R1: "reach",
  K: "core path",
};

const REACH_NAME: Record<string, string> = {
  all: "every existing caller",
  flag_or_cohort: "flag or cohort",
  none: "no existing caller",
  unknown: "unknown",
};

const CALLER_NAME: Record<string, string> = {
  end_users_ui: "end users via UI",
  other_services: "other services",
  embedded_sdk_clients: "embedded SDK clients",
  operators_admins: "operators and admins",
  ci_automation_only: "CI only",
};

const CLEARED = new Set(["narrower", "no consequence node yes", "no existing caller", "no scoring consequence"]);
const OPEN = new Set(["reach not verified", "change not verified"]);

export interface Cited {
  text: string;
  where: string;
}

export interface Asked {
  id: string;
  group: string;
  question: string;
  state: string;
  text: string;
  where: string;
  note: string;
}

export interface AuditTopic {
  title: string;
  where: string;
  base: string | null;
  baseName: string;
  baseWhere: string;
  consumer: Cited | null;
  counted: Array<Cited & { id: string; name: string }>;
  coreState: string;
  coreText: string;
  coreWhere: string;
  reachState: string;
  reachName: string;
  reachText: string;
  reachWhere: string;
  topicScore: number;
  weight: "full" | "half";
  weighted: number;
  asks: Asked[];
  points: string[];
  lookAt: Array<{ text: string; where: string; inBank: boolean }>;
}

export interface ReviewCheck {
  label: "Flag" | "Signal" | "Test";
  question: string;
  state: "yes" | "no";
  text: string;
  where: string;
}

export interface AuditItem {
  text: string;
  where: string;
}

export interface PublicReview {
  score: number;
  band: string;
  verdict: string;
  source: { owner: string; repo: string; sha: string };
  topics: AuditTopic[];
  cleared: AuditItem[];
  unchanged: number;
  checks: ReviewCheck[];
  rung: number;
  partA: number;
  partB: number;
  noes: number;
  unresolved: AuditItem[];
  others: Array<{ title: string; where: string; bucket: "cleared" | "unresolved"; reason: string; asks: Asked[] }>;
  profile: Asked[];
  coverage: {
    files: number;
    hunks: number;
    units: number;
    decisions: number;
    topics: number;
    interrogated: number;
    n: number;
    core: number;
    unresolvedTopics: number;
    unknownQuestions: number;
    unenclosed: number;
    notInterrogated: string[];
  };
  method: {
    baseSha: string;
    outcomes: string[];
    callers: string[];
    types: string[];
    order: string[];
  };
  notes: Cited[];
}

function cited(fact: Fact | undefined): Cited | null {
  const text = fact?.reason?.trim() ?? "";
  if (!text) return null;
  return { text, where: fact?.citation?.trim() ?? "" };
}

const ASK_ORDER: Array<{ id: string; group: string }> = [
  ...C_IDS.map((id) => ({ id, group: "Consequence" })),
  { id: "R1", group: "Reach" },
  { id: "R2", group: "Reach" },
  { id: "K", group: "Core path" },
  ...F_IDS.map((id) => ({ id, group: "Failure pattern" })),
];

function stateLabel(id: string, state: string): string {
  if (id === "R1") {
    const name = REACH_NAME[state] ?? state;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  if (state === "yes") return "Yes";
  if (state === "no") return "No";
  if (state === "unknown") return "Unknown";
  return state;
}

function askNote(topic: Topic, id: string, parts: ScoreParts): string {
  const fact = topic.questions[id];
  if (!fact?.state) return "";
  const verified = fact.verified === true;
  const hazard = parts.hazards.find((row) => row.id === id);
  if (id === parts.base) return `This is the base. ${parts.basePoints} points.`;
  if (hazard) {
    const extra = hazard.amp ? ` Plus ${hazard.amp}, because this pattern amplifies ${parts.base}.` : "";
    return `Counted. +${hazard.weight}.${extra}`;
  }
  if (C_IDS.includes(id as (typeof C_IDS)[number]) && fact.state === "yes" && verified && !parts.base) {
    return "Yes, and verified. The topic still adds nothing because it dropped out before a base was chosen.";
  }
  if (C_IDS.includes(id as (typeof C_IDS)[number]) && fact.state === "yes" && verified && id !== parts.base) {
    return `Yes, and verified. ${parts.base} produced the higher score, so this is not the base.`;
  }
  if (fact.state === "yes" && fact.verified === false) return "Answered yes. The citation was not verified, so this adds nothing.";
  if (id.startsWith("F") && fact.state === "yes" && fact.meets_direction !== true) return "Answered yes. The direction does not hold, so this adds nothing.";
  if (id === "K" && fact.state === "yes" && verified) return `Counted. Multiplies the topic by ${parts.k}.`;
  if (id === "K" && fact.state === "no") return `Multiplies the topic by ${K_MULT.no}.`;
  if (id === "R1" && (REACH_MULT[String(fact.state)] ?? 0) === 0) return "No existing caller, so the topic adds nothing.";
  if (id === "R1" && verified && (REACH_MULT[String(fact.state)] ?? 0) > 0) return `Counted. Multiplies the topic by ${REACH_MULT[String(fact.state)]}.`;
  if (id === "R1" && fact.verified === false && (REACH_MULT[String(fact.state)] ?? 0) > 0) return "This reach was not verified, so the topic drops out.";
  if (fact.state === "no") return "Adds nothing.";
  if (fact.state === "unknown") return "Unknown, so it adds nothing. The number is a lower bound here.";
  return "";
}

function asksFor(topic: Topic, parts: ScoreParts): Asked[] {
  return ASK_ORDER.filter((row) => topic.questions[row.id]?.state || (topic.interrogated && row.id.startsWith("F"))).map((row) => {
    const fact = topic.questions[row.id];
    return {
      id: row.id,
      group: row.group,
      question: QUESTIONS[row.id as keyof typeof QUESTIONS],
      state: fact?.state ? stateLabel(row.id, fact.state) : "Not asked",
      text: fact?.reason?.trim() ?? "",
      where: fact?.citation?.trim() ?? "",
      note: askNote(topic, row.id, parts),
    };
  });
}

function pointLines(parts: ScoreParts, weight: "full" | "half"): string[] {
  if (!parts.base) return [];
  const hazardSum = parts.hazards.reduce((sum, row) => sum + row.weight + row.amp, 0);
  const subtotal = parts.basePoints + hazardSum;
  const raw = subtotal * parts.k * parts.reach;
  const weighted = weight === "half" ? parts.score * 0.5 : parts.score;
  return [
    `${parts.base} base ${parts.basePoints}.`,
    ...parts.hazards.map((row) => `${row.id} +${row.weight}${row.amp ? ` and +${row.amp} amplification` : ""}.`),
    hazardSum === 0 ? "No failure pattern counted, +0." : `Failure patterns ${hazardSum}.`,
    `Subtotal ${subtotal}.`,
    `× ${parts.k} core path.`,
    `× ${parts.reach} reach.`,
    raw > 100 ? `${raw}, capped at 100, = ${parts.score}.` : `${subtotal} × ${parts.k} × ${parts.reach} = ${parts.score}.`,
    weight === "half" ? `Half weight: ${parts.score} × 0.5 = ${weighted} of Part A.` : `Full weight: ${weighted} of Part A.`,
  ];
}

function auditTopic(topic: Topic, parts: ScoreParts, weight: "full" | "half"): AuditTopic {
  const base = parts.base;
  const effect = base ? cited(topic.questions[base]) : null;
  const reachFact = topic.questions.R1;
  const coreFact = topic.questions.K;
  const reachState = String(reachFact?.state ?? "unknown");
  return {
    title: effect?.text || topic.description,
    where: topic.where,
    base,
    baseName: base ? NODE_NAME[base] ?? base : "",
    baseWhere: effect?.where || topic.where,
    consumer: topic.consumer?.description
      ? { text: topic.consumer.description, where: topic.consumer.citation?.trim() ?? "" }
      : null,
    counted: parts.counted.map((id) => {
      const fact = cited(topic.questions[id]);
      return { id, name: NODE_NAME[id] ?? id, text: fact?.text ?? "", where: fact?.where ?? "" };
    }),
    coreState: String(coreFact?.state ?? "unknown"),
    coreText: coreFact?.reason?.trim() ?? "",
    coreWhere: coreFact?.citation?.trim() ?? "",
    reachState,
    reachName: REACH_NAME[reachState] ?? reachState,
    reachText: reachFact?.reason?.trim() ?? "",
    reachWhere: reachFact?.citation?.trim() ?? "",
    topicScore: parts.score,
    weight,
    weighted: weight === "half" ? parts.score * 0.5 : parts.score,
    asks: asksFor(topic, parts),
    points: pointLines(parts, weight),
    lookAt: (topic.probes ?? [])
      .map((probe) => {
        const raw = probe.answer || probe.question || "";
        const inBank = !/does not meet a failure pattern/i.test(raw);
        const text = raw
          .replace(/\s*That does not meet a failure pattern, so it adds nothing\.?/gi, "")
          .replace(/\s*It does not meet a failure pattern\.?/gi, "")
          .trim();
        return { text, where: topic.where, inBank };
      })
      .filter((probe) => probe.text),
  };
}

/** Reviewer-facing card. The number, the nodes that produced it, and the lines that support them. */
export function publicReview(analysis: Record<string, unknown>, result: ScoreResult): PublicReview {
  const topics = ((analysis.topics as Topic[] | undefined) ?? []).map((t) => ({ ...t, questions: t.questions ?? {} }));
  const ranked = topics
    .map((t) => ({ t, ...topicScore(t) }))
    .sort((a, b) => b.score - a.score || a.t.where.localeCompare(b.t.where));
  const earning = ranked.filter((row) => row.score > 0);
  const containment = (analysis.containment as Record<string, Fact> | undefined) ?? {};
  const ambiguous = topics.filter((t) => t.change_test === "ambiguous");
  const asked = (topic: Topic) => C_IDS.some((id) => topic.questions[id]?.state);
  const zero = topics.filter((t) => topicScore(t).score === 0 && t.change_test !== "ambiguous" && t.description && (t.interrogated || asked(t)));
  const cleared = zero
    .filter((t) => CLEARED.has(clearReason(t)))
    .map((t) => ({ text: `${t.description} — ${PLAIN[clearReason(t)] ?? clearReason(t)}`, where: t.where }));
  const unresolvedTopics = [
    ...ambiguous.map((t) => ({ text: `${t.description} — the before and after lines still disagree`, where: t.where })),
    ...zero
      .filter((t) => OPEN.has(clearReason(t)))
      .map((t) => ({ text: `${t.description} — ${PLAIN[clearReason(t)] ?? clearReason(t)}`, where: t.where })),
  ];
  const unknownQuestions = topics.flatMap((t) =>
    Object.entries(t.questions)
      .filter(([, fact]) => fact.state === "unknown")
      .map(([id, fact]) => ({
        text: `${t.description} — ${NODE_NAME[id] ?? id} is unknown. ${fact.reason ?? ""}`.trim(),
        where: fact.citation || t.where,
      })),
  );
  const checkLabel = { B1: "Flag", B2: "Signal", B3: "Test" } as const;
  const unresolvedChecks = B_IDS.flatMap((id) => {
    const fact = containment[id];
    if (fact?.state !== "unknown") return [];
    return [{ text: `${checkLabel[id]} — ${fact.reason || "this check is still unknown"}`, where: fact.citation ?? "" }];
  });
  const pr = analysis.pr as { owner?: string; repo?: string; head_sha?: string; base_sha?: string } | undefined;
  const hunks = (analysis.hunks as Array<{ file?: string; unit?: string; enclosed?: boolean }> | undefined) ?? [];
  const decisions = (analysis.decision_points as Array<{ change?: string }> | undefined) ?? [];
  const profile = analysis.profile as {
    base_sha?: string;
    P1?: Array<{ outcome?: string; verified?: boolean }>;
    P2?: Array<{ class?: string; state?: string }>;
  } | undefined;
  const outcomes = (profile?.P1 ?? []).filter((row) => row.verified !== false && row.outcome).map((row) => row.outcome as string);
  const audited = earning.map((row, index) => auditTopic(row.t, row, index === 0 ? "full" : "half"));
  const packet = (topic: Topic, bucket: "cleared" | "unresolved") => ({
    title: topic.description,
    where: topic.where,
    bucket,
    reason: PLAIN[clearReason(topic)] ?? clearReason(topic),
    asks: asksFor(topic, topicScore(topic)),
  });
  const others = [
    ...zero.filter((topic) => CLEARED.has(clearReason(topic))).map((topic) => packet(topic, "cleared")),
    ...ambiguous.map((topic) => ({ ...packet(topic, "unresolved"), reason: "the before and after lines still disagree" })),
    ...zero.filter((topic) => OPEN.has(clearReason(topic))).map((topic) => packet(topic, "unresolved")),
  ];
  const notes: Cited[] = [];
  for (const topic of audited) {
    if (topic.reachText) notes.push({ text: topic.reachText, where: topic.reachWhere });
    for (const row of topic.counted) if (row.text) notes.push({ text: row.text, where: row.where });
    for (const row of topic.lookAt) notes.push({ text: row.inBank ? row.text : `Not in the bank. ${row.text}`, where: row.where });
  }
  return {
    score: result.score,
    band: result.band,
    verdict: earning[0]?.t.description ?? "No change earned a score.",
    source: { owner: pr?.owner ?? "", repo: pr?.repo ?? "", sha: pr?.head_sha ?? "" },
    topics: audited,
    cleared,
    unchanged: decisions.filter((d) => d.change === "no").length,
    checks: B_IDS.flatMap((id) => {
      const fact = containment[id];
      if (fact?.state !== "yes" && fact?.state !== "no") return [];
      return [{
        label: checkLabel[id],
        state: fact.state,
        question: QUESTIONS[id],
        text: fact.reason || fact.citation || "",
        where: fact.citation ?? "",
      }];
    }),
    rung: result.rung,
    partA: result.part_a,
    partB: result.part_b,
    noes: B_IDS.filter((id) => containment[id]?.state === "no").length,
    unresolved: [...unresolvedTopics, ...unknownQuestions, ...unresolvedChecks],
    coverage: {
      files: new Set(hunks.map((hunk) => hunk.file).filter(Boolean)).size,
      hunks: hunks.length,
      units: new Set(hunks.map((hunk) => hunk.unit).filter(Boolean)).size,
      decisions: decisions.length,
      topics: topics.length,
      interrogated: topics.filter((t) => t.interrogated || asked(t)).length,
      n: Number(analysis.top_n ?? 6),
      core: topics.filter((t) => t.questions.K?.state === "yes" && t.questions.K?.verified === true).length,
      unresolvedTopics: new Set([...ambiguous, ...zero.filter((t) => OPEN.has(clearReason(t)))].map((t) => t.where)).size,
      unknownQuestions: unknownQuestions.length,
      unenclosed: hunks.filter((hunk) => hunk.enclosed === false).length,
      notInterrogated: topics.filter((t) => !t.interrogated && !asked(t)).map((t) => `${t.description} (${t.where})`),
    },
    method: {
      baseSha: (profile?.base_sha || pr?.base_sha || "").slice(0, 7),
      outcomes,
      callers: (profile?.P2 ?? []).filter((row) => row.state === "yes" && row.class).map((row) => CALLER_NAME[row.class as string] ?? row.class as string),
      types: (analysis.pr_types as string[] | undefined) ?? [],
      order: (analysis.interrogation_order as string[] | undefined) ?? [],
    },
    notes,
    others,
    profile: repoAsks(profile as Record<string, unknown> | undefined),
  };
}

function repoAsks(profile: Record<string, unknown> | undefined): Asked[] {
  if (!profile) return [];
  const asks: Asked[] = [];
  const outcomes = (profile.P1 as Array<{ outcome?: string; citation?: string; verified?: boolean }> | undefined) ?? [];
  if (outcomes.length === 0) {
    asks.push({ id: "P1", group: "Repo", question: QUESTIONS.P1, state: "Unknown", text: "", where: "", note: "Not answered." });
  }
  outcomes.forEach((row, index) => {
    asks.push({
      id: "P1",
      group: "Repo",
      question: index === 0 ? QUESTIONS.P1 : "",
      state: row.verified === false ? "Not verified" : "Yes",
      text: row.outcome ?? "",
      where: row.citation ?? "",
      note: row.verified === false ? "Not verified, so a topic cannot earn the core-path multiplier from this outcome." : "A core outcome. K is yes only when a topic feeds one of these.",
    });
  });
  const callers = (profile.P2 as Array<{ class?: string; state?: string; reason?: string; citation?: string }> | undefined) ?? [];
  callers.forEach((row, index) => {
    const name = CALLER_NAME[row.class ?? ""] ?? row.class ?? "caller";
    asks.push({
      id: "P2",
      group: "Repo",
      question: index === 0 ? QUESTIONS.P2 : "",
      state: stateLabel("P2", row.state ?? "unknown"),
      text: `${name}. ${row.reason ?? ""}`.trim(),
      where: row.citation ?? "",
      note: row.state === "yes" ? "These callers are who reach is judged against." : "Not a caller.",
    });
  });
  for (const id of ["P3", "P4", "P5", "P6"] as const) {
    const fact = profile[id] as Fact | undefined;
    asks.push({
      id,
      group: "Repo",
      question: QUESTIONS[id],
      state: stateLabel(id, fact?.state ?? "unknown"),
      text: fact?.reason ?? "",
      where: fact?.citation ?? "",
      note: fact?.state === "yes" ? "Used when a later question depends on it." : "Adds nothing on its own.",
    });
  }
  const look = (profile.P7 as { where_to_look?: string[] } | undefined)?.where_to_look ?? [];
  asks.push({
    id: "P7",
    group: "Repo",
    question: QUESTIONS.P7,
    state: look.length ? "Yes" : "Unknown",
    text: look.join(", "),
    where: "",
    note: "Consumers were looked for in these places.",
  });
  return asks;
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
