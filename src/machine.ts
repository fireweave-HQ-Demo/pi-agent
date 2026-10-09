import fs from "node:fs";
import path from "node:path";
import { accept, type Asker, type AskSpec, type FactAnswer } from "./accept.js";
import { classifyDiff } from "./classify.js";
import { parseUnifiedDiff, type Hunk } from "./diff.js";
import { BASE, B_IDS, C_IDS, CRK_IDS, F_IDS, K_MULT, QUESTIONS, REACH_MULT } from "./questions.js";
import type { Trees } from "./accept.js";

export interface RunInput {
  trees: Trees;
  diffText: string;
  topN?: number;
  cacheDir?: string;
}

function unknownFact(reason: string): FactAnswer {
  return { state: "unknown", reason };
}

function fillMissing(topics: TopicRow[], containment: Record<string, FactAnswer & { verified?: boolean }>): void {
  for (const topic of topics) {
    for (const id of CRK_IDS) {
      if (!topic.questions[id]?.state) topic.questions[id] = unknownFact("not answered");
    }
    if (!topic.interrogated) continue;
    for (const id of F_IDS) {
      if (!topic.questions[id]?.state) topic.questions[id] = unknownFact("not answered");
    }
  }
  const scored = topics.some((t) => ungated(t) && t.interrogated);
  if (scored) {
    for (const id of B_IDS) {
      if (!containment[id]?.state) containment[id] = unknownFact("not answered");
    }
  }
}

async function ask<T>(asker: Asker, spec: AskSpec): Promise<T> {
  const raw = await asker.ask(spec);
  return accept(spec, raw) as T;
}

function prompt(lines: string[]): string {
  return lines.filter(Boolean).join("\n");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface TopicRow {
  id: string;
  decision_points: string[];
  description: string;
  where: string;
  kind: string;
  direction: string;
  change_test: string;
  change_verified: boolean;
  consumer: { description: string; citation: string | null };
  core_path: { outcome_index: number | null; path: string | null };
  interrogated: boolean;
  questions: Record<string, FactAnswer & { verified?: boolean }>;
  probes: unknown[];
}

function ungated(t: TopicRow): boolean {
  if (!(t.change_test === "yes" && t.change_verified)) return false;
  if (t.direction === "narrower") return false;
  const cYes = C_IDS.some((c) => t.questions[c]?.state === "yes" && t.questions[c]?.verified !== false);
  if (!cYes) return false;
  const reach = String(t.questions.R1?.state ?? "unknown");
  return (REACH_MULT[reach] ?? 0) > 0;
}

function rankOf(t: TopicRow): number {
  if (!ungated(t)) return 0;
  let best = 0;
  for (const c of C_IDS) {
    const a = t.questions[c];
    if (a?.state === "yes" && a.verified !== false) best = Math.max(best, BASE[c]);
  }
  const k = String(t.questions.K?.state ?? "unknown");
  const r = String(t.questions.R1?.state ?? "unknown");
  return best * (K_MULT[k] ?? 1) * (REACH_MULT[r] ?? 0);
}

export async function analyze(input: RunInput, asker: Asker): Promise<Record<string, unknown>> {
  const topN = input.topN ?? 6;
  const { trees } = input;
  const hunks = parseUnifiedDiff(input.diffText);
  if (hunks.length === 0) throw new Error("diff has no hunks");

  const cacheFile = input.cacheDir ? path.join(input.cacheDir, `${trees.meta.base_sha}.json`) : "";
  let profile: Record<string, unknown> | null = null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    profile = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
  }
  if (!profile) {
    profile = await profileAtBase(asker, trees.base);
    profile.base_sha = trees.meta.base_sha;
    profile.status = "known";
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(profile, null, 2));
    }
  }

  const units: Array<Record<string, unknown>> = [];
  for (const group of chunk(hunks, 35)) {
    const part = await ask<Array<Record<string, unknown>>>(asker, {
      phase: 1,
      id: "units",
      root: trees.head,
      hunks: group,
      prompt: prompt([
        "Phase 1. Name the enclosing unit of each hunk in this batch.",
        "Do not use the profile or the PR type.",
        group.map((h) => `${h.id} ${h.file}\n${h.text.slice(0, 400)}`).join("\n\n"),
      ]),
    });
    units.push(...part);
  }

  const hunksOut = hunks.map((h) => {
    const u = units.find((x) => x.hunk === h.id) ?? {};
    const enclosed = u.enclosed !== false && typeof u.unit === "string" && u.unit.length > 0;
    return {
      id: h.id,
      file: h.file,
      new_start: h.new_start,
      new_lines: h.new_lines,
      old_start: h.old_start,
      old_lines: h.old_lines,
      unit: enclosed ? u.unit : null,
      unit_citation: enclosed ? u.unit_citation ?? null : null,
      enclosed,
    };
  });

  const listed: Array<Record<string, unknown>> = [];
  for (const group of chunk(hunksOut, 35)) {
    const part = await ask<Array<Record<string, unknown>>>(asker, {
      phase: 2,
      id: "decisions",
      root: trees.head,
      hunk: "all",
      hunks: group.map((h) => hunks.find((x) => x.id === h.id)).filter((h): h is (typeof hunks)[number] => Boolean(h)),
      prompt: prompt([
        "Phase 2. At most one decision point per hunk. Pick the line that actually changed.",
        "Do not use the profile or the PR type.",
        group.map((h) => `${h.id} unit ${String(h.unit)}\n${(hunks.find((x) => x.id === h.id)?.text ?? "").slice(0, 700)}`).join("\n\n"),
      ]),
    });
    listed.push(...part);
  }
  const picked: Array<Record<string, unknown>> = [];
  const seenHunk = new Set<string>();
  for (const d of listed) {
    const hunk = String(d.hunk ?? hunksOut[0]?.id ?? "H1");
    if (seenHunk.has(hunk)) continue;
    seenHunk.add(hunk);
    picked.push(d);
    if (picked.length >= 24) break;
  }
  const drafted = picked.map((d, i) => ({
    id: `D${i + 1}`,
    hunk: String(d.hunk ?? hunksOut[0]?.id ?? "H1"),
    unit: hunksOut.find((h) => h.id === d.hunk)?.unit ?? d.unit,
    where: d.where,
    kind: d.kind,
  }));
  const changeRows: Array<Record<string, unknown>> = [];
  for (const group of chunk(drafted, 24)) {
    const part = await ask<Array<Record<string, unknown>>>(asker, {
      phase: 3,
      id: "changes",
      root: trees.head,
      prompt: prompt([
        "Phase 3. Change-test every decision in this batch. Answer only from before and after lines. No profile. No PR type.",
        JSON.stringify(group),
      ]),
    });
    changeRows.push(...part);
  }
  const decisionPoints: Array<{
    id: string;
    hunk: string;
    unit: unknown;
    where: unknown;
    kind: unknown;
    change: unknown;
    before: unknown;
    after: unknown;
    direction: unknown;
    second_pass: string | null;
  }> = drafted.map((d) => {
    const change = changeRows.find((x) => x.decision === d.id) ?? {};
    return {
      id: d.id,
      hunk: d.hunk,
      unit: d.unit,
      where: d.where,
      kind: d.kind,
      change: change.change === "yes" || change.change === "ambiguous" ? change.change : "no",
      before: change.before ?? null,
      after: change.after ?? null,
      direction: change.direction ?? null,
      second_pass: null,
    };
  });

  const changed = decisionPoints.filter((d) => d.change === "yes" || d.change === "ambiguous");
  const topicDrafts =
    changed.length === 0
      ? []
      : await ask<Array<Record<string, unknown>>>(asker, {
          phase: 4,
          id: "topics",
          root: trees.head,
          prompt: prompt([
            "Phase 4. Bundle yes and ambiguous decision points into topics.",
            "Profile P1 and P7 may be used to name consumers. PR type is not available.",
            JSON.stringify({ p1: (profile as { P1?: unknown }).P1, p7: (profile as { P7?: unknown }).P7, changed }),
          ]),
        });

  const topics: TopicRow[] = topicDrafts.map((t, i) => ({
    id: `T${i + 1}`,
    decision_points: (t.decision_points as string[]) ?? [],
    description: String(t.description ?? ""),
    where: String(t.where ?? ""),
    kind: String(t.kind ?? ""),
    direction: String(t.direction ?? ""),
    change_test: "yes",
    change_verified: false,
    consumer: (t.consumer as TopicRow["consumer"]) ?? { description: "", citation: null },
    core_path: (t.core_path as TopicRow["core_path"]) ?? { outcome_index: null, path: null },
    interrogated: false,
    questions: {},
    probes: [],
  }));

  const changeChecks = decisionPoints
    .filter((d) => d.change === "yes" || d.change === "ambiguous")
    .map((d) => ({ id: String(d.id), citation: String(d.where), claim: `${d.before} → ${d.after}` }));
  await applyVerify(asker, changeChecks, trees.head, (id, supports) => {
    const d = decisionPoints.find((x) => x.id === id);
    if (!d) return;
    d.second_pass = supports ? "yes" : "still_ambiguous";
    const topic = topics.find((t) => t.decision_points.includes(id));
    if (topic) topic.change_verified = supports && d.change === "yes";
    if (topic && d.change === "ambiguous") topic.change_test = supports ? "yes" : "ambiguous";
  });

  const p1 = ((profile as { P1?: Array<{ outcome?: string }> }).P1 ?? []).map((o) => o.outcome).join(" | ");
  const p2 = JSON.stringify((profile as { P2?: unknown }).P2 ?? []);
  const p5 = JSON.stringify((profile as { P5?: unknown }).P5 ?? {});

  const crkIds = topics.flatMap((t) => CRK_IDS.map((qid) => `${t.id}.${qid}`));
  if (crkIds.length) {
    const crk = await ask<Array<FactAnswer & { id: string }>>(asker, {
      phase: 5,
      id: "batch",
      root: trees.head,
      ids: crkIds,
      prompt: prompt([
        "Phase 5. Answer every C/R/K for every topic. No weights. No score.",
        `P1: ${p1}`,
        `P2: ${p2}`,
        topics.map((t) => `${t.id}: ${t.description} at ${t.where}`).join("\n"),
        crkIds.map((id) => `${id}: ${QUESTIONS[id.split(".")[1] as keyof typeof QUESTIONS]}`).join("\n"),
      ]),
    });
    for (const row of crk) {
      const [tid, qid] = row.id.split(".");
      const topic = topics.find((t) => t.id === tid);
      if (topic && qid) topic.questions[qid] = row;
    }
  }

  await verifyYeses(asker, topics, trees.head, p1);

  const ranked = [...topics].sort((a, b) => rankOf(b) - rankOf(a) || a.where.localeCompare(b.where));
  const top = new Set(ranked.filter((t) => rankOf(t) > 0).slice(0, topN).map((t) => t.id));
  const fIds: string[] = [];
  for (const t of topics) {
    t.interrogated = top.has(t.id);
    if (t.interrogated) for (const qid of F_IDS) fIds.push(`${t.id}.${qid}`);
  }
  if (fIds.length) {
    const rows = await ask<Array<FactAnswer & { id: string }>>(asker, {
      phase: 5,
      id: "batch",
      root: trees.head,
      ids: fIds,
      prompt: prompt([
        "Phase 5. Answer every F question for the top topics. A yes must set meets_direction.",
        `P5: ${p5}`,
        topics.filter((t) => t.interrogated).map((t) => `${t.id}: ${t.description}. Direction ${t.direction}.`).join("\n"),
        fIds.map((id) => `${id}: ${QUESTIONS[id.split(".")[1] as keyof typeof QUESTIONS]}`).join("\n"),
      ]),
    });
    for (const row of rows) {
      const [tid, qid] = row.id.split(".");
      const topic = topics.find((t) => t.id === tid);
      if (topic && qid) topic.questions[qid] = row;
    }
  }
  await verifyYeses(asker, topics, trees.head, p1);

  const anyPoints = topics.some((t) => t.interrogated && ungated(t));
  const containment: Record<string, FactAnswer & { verified?: boolean }> = {};
  if (anyPoints) {
    const rows = await ask<Array<FactAnswer & { id: string }>>(asker, {
      phase: 5,
      id: "batch",
      root: trees.head,
      ids: [...B_IDS],
      prompt: prompt(["Containment B1 B2 B3 once for the PR, about lines that can earn points.", B_IDS.map((id) => `${id}: ${QUESTIONS[id]}`).join("\n")]),
    });
    for (const row of rows) containment[row.id] = row;
    await applyVerify(
      asker,
      B_IDS.filter((id) => containment[id]?.state === "yes").map((id) => ({
        id,
        citation: containment[id]?.citation ?? "",
        claim: containment[id]?.reason ?? "",
      })),
      trees.head,
      (id, supports) => {
        if (containment[id]) containment[id].verified = supports;
      },
    );
  }

  fillMissing(topics, containment);

  const files = [...new Set(hunks.map((h) => h.file))];
  const typed = classifyDiff(files, hunks);

  return {
    schema: "risk-analysis/v1",
    pr: {
      owner: trees.meta.owner,
      repo: trees.meta.repo,
      number: trees.meta.number,
      base_sha: trees.meta.base_sha,
      head_sha: trees.meta.head_sha,
    },
    top_n: topN,
    profile,
    hunks: hunksOut,
    decision_points: decisionPoints,
    pr_types: typed.types,
    interrogation_order: typed.order,
    topics,
    containment,
  };
}

async function profileAtBase(asker: Asker, root: string): Promise<Record<string, unknown>> {
  const p1 = await ask<Record<string, unknown>>(asker, {
    phase: 0,
    id: "P1",
    root,
    prompt: prompt(["Phase 0 at the base SHA. Do not open the diff.", QUESTIONS.P1]),
  });
  const p2 = await ask<Record<string, unknown>>(asker, {
    phase: 0,
    id: "P2",
    root,
    prompt: prompt(["Phase 0. Five caller classes, each yes or no.", QUESTIONS.P2]),
  });
  const rest: Record<string, unknown> = {};
  for (const id of ["P3", "P4", "P5", "P6"] as const) {
    rest[id] = await ask(asker, { phase: 0, id, root, prompt: prompt(["Phase 0.", QUESTIONS[id]]) });
  }
  const p7 = await ask<Record<string, unknown>>(asker, {
    phase: 0,
    id: "P7",
    root,
    prompt: prompt(["Phase 0. Derived from P2–P6.", QUESTIONS.P7]),
  });
  const outcomes = ((p1.outcomes as Array<Record<string, string>>) ?? []).map((o) => ({
    outcome: o.outcome,
    path: o.path,
    citation: o.citation,
    verified: false,
  }));
  for (const o of outcomes) {
    const v = await ask<{ supports: boolean }>(asker, {
      phase: "verify",
      id: "P1.verify",
      root,
      citation: String(o.citation),
      outcome: String(o.outcome),
      path: String(o.path),
      prompt: prompt([
        "Verify this core outcome. You see the citation, the path, and the outcome line.",
        `outcome: ${String(o.outcome)}`,
        `path: ${String(o.path)}`,
        `citation: ${String(o.citation)}`,
      ]),
    });
    o.verified = v.supports;
  }
  const kept = outcomes.filter((o) => o.verified === true);
  return {
    P1: kept.length ? kept : outcomes,
    P2: (p2.classes as unknown[]) ?? [],
    ...rest,
    P7: { where_to_look: p7.where_to_look },
  };
}

async function applyVerify(
  asker: Asker,
  items: Array<{ id: string; citation: string; claim: string }>,
  root: string,
  set: (id: string, supports: boolean) => void,
): Promise<void> {
  if (items.length === 0) return;
  const raw = await ask<{ supports?: boolean; checks?: Array<{ id: string; supports: boolean }> }>(asker, {
    phase: "verify",
    id: "batch",
    root,
    citation: items.map((i) => i.citation).join(","),
    prompt: prompt(["Verify each claim against its citation. Return checks or supports:true for all.", JSON.stringify(items)]),
  });
  if (raw.supports === true) {
    for (const item of items) set(item.id, true);
    return;
  }
  for (const item of items) {
    const hit = raw.checks?.find((c) => c.id === item.id);
    set(item.id, hit?.supports === true);
  }
}

async function verifyYeses(asker: Asker, topics: TopicRow[], root: string, p1: string): Promise<void> {
  const items: Array<{ id: string; citation: string; claim: string }> = [];
  for (const t of topics) {
    for (const [qid, ans] of Object.entries(t.questions)) {
      const reachYes = qid === "R1" && (ans.state === "all" || ans.state === "flag_or_cohort");
      if (ans.state !== "yes" && !reachYes) continue;
      if (ans.verified === false) continue;
      items.push({
        id: `${t.id}.${qid}`,
        citation: ans.citation ?? "",
        claim: `${ans.reason ?? ""} ${qid === "K" ? `consumer ${t.consumer.citation} path ${t.core_path.path} P1 ${p1}` : ""}`.trim(),
      });
    }
  }
  await applyVerify(asker, items, root, (id, supports) => {
    const [tid, qid] = id.split(".");
    const topic = topics.find((t) => t.id === tid);
    if (topic && qid && topic.questions[qid]) topic.questions[qid].verified = supports;
  });
}

export function readDiff(trees: Trees): string {
  return fs.readFileSync(trees.diffPath, "utf8");
}
