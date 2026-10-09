import fs from "node:fs";
import path from "node:path";
import { accept, type Asker, type AskSpec, type FactAnswer } from "./accept.js";
import { classifyDiff } from "./classify.js";
import { parseUnifiedDiff, type Hunk } from "./diff.js";
import { BASE, B_IDS, C_IDS, CRK_IDS, F_IDS, K_MULT, QUESTIONS, REACH_MULT } from "./questions.js";
import { profileSources } from "./snapshot.js";
import type { Trees } from "./accept.js";

export interface RunInput {
  trees: Trees;
  diffText: string;
  topN?: number;
  cacheDir?: string;
}

async function ask<T>(asker: Asker, spec: AskSpec): Promise<T> {
  const raw = await asker.ask(spec);
  return accept(spec, raw) as T;
}

function prompt(lines: string[]): string {
  return lines.filter(Boolean).join("\n");
}

function region(root: string, citation: string | null | undefined): string {
  if (!citation) return "";
  const match = /^([^:]+):(\d+)/.exec(citation);
  if (!match) return "";
  const abs = path.join(root, match[1]);
  if (!fs.existsSync(abs)) return "";
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return "";
  }
  if (!st.isFile()) return "";
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const at = Number(match[2]);
  const start = Math.max(1, at - 30);
  const end = Math.min(lines.length, at + 160);
  const body = lines.slice(start - 1, end).map((line, i) => `${start + i}|${line}`).join("\n");
  return `FILE ${match[1]}\n${body}`;
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

function countedYes(answer: FactAnswer & { verified?: boolean } | undefined): boolean {
  return answer?.state === "yes" && answer.verified === true;
}

function ungated(t: TopicRow): boolean {
  if (!(t.change_test === "yes" && t.change_verified)) return false;
  if (t.direction === "narrower") return false;
  if (!C_IDS.some((c) => countedYes(t.questions[c]))) return false;
  const reach = t.questions.R1;
  return reach?.verified === true && (REACH_MULT[String(reach.state)] ?? 0) > 0;
}

function rankOf(t: TopicRow): number {
  if (!ungated(t)) return 0;
  let best = 0;
  for (const c of C_IDS) {
    if (countedYes(t.questions[c])) best = Math.max(best, BASE[c]);
  }
  const k = t.questions.K?.state === "yes" && t.questions.K.verified === true ? K_MULT.yes : t.questions.K?.state === "no" ? K_MULT.no : K_MULT.unknown;
  const reach = t.questions.R1;
  const mult = reach?.verified === true ? (REACH_MULT[String(reach.state)] ?? 0) : 0;
  return best * k * mult;
}

function orderIds(ids: string[], order: string[]): string[] {
  const rank = (id: string) => {
    const q = id.includes(".") ? id.split(".").pop()! : id;
    const at = order.indexOf(q);
    return at < 0 ? order.length : at;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
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
        "If a hunk spans two units, return one row per unit. If the unit is outside the diff, use the file excerpt.",
        "Do not use the profile or the PR type.",
        group.map((h) => `${h.id} ${h.file}\n${h.text}\n${region(trees.head, `${h.file}:${h.new_start}`)}`).join("\n\n"),
      ]),
    });
    units.push(...part);
  }

  const hunksOut: Array<Record<string, unknown>> = [];
  for (const h of hunks) {
    const rows = units.filter((u) => u.hunk === h.id);
    const use = rows.length ? rows : [{}];
    use.forEach((u, index) => {
      const enclosed = u.enclosed !== false && typeof u.unit === "string" && u.unit.length > 0;
      hunksOut.push({
        id: use.length > 1 ? `${h.id}.${index + 1}` : h.id,
        file: h.file,
        new_start: h.new_start,
        new_lines: h.new_lines,
        old_start: h.old_start,
        old_lines: h.old_lines,
        unit: enclosed ? u.unit : null,
        unit_citation: enclosed ? u.unit_citation ?? null : null,
        enclosed,
      });
    });
  }

  const listed: Array<Record<string, unknown>> = [];
  for (const group of chunk(hunksOut, 8)) {
    const part = await ask<Array<Record<string, unknown>>>(asker, {
      phase: 2,
      id: "decisions",
      root: trees.head,
      hunk: "all",
      hunks: group
        .map((h) => hunks.find((x) => x.id === String(h.id).replace(/\.\d+$/, "")))
        .filter((h): h is (typeof hunks)[number] => Boolean(h)),
      prompt: prompt([
        "Phase 2. Enumerate every decision point on a changed line in this batch.",
        "Do not use the profile or the PR type.",
        group
          .map((h) => `${h.id} unit ${String(h.unit)}\n${hunks.find((x) => x.id === String(h.id).replace(/\.\d+$/, ""))?.text ?? ""}`)
          .join("\n\n"),
      ]),
    });
    listed.push(...part);
  }
  const drafted = listed.map((d, i) => ({
    id: `D${i + 1}`,
    hunk: String(d.hunk ?? hunksOut[0]?.id ?? "H1"),
    unit: hunksOut.find((h) => h.id === d.hunk)?.unit ?? d.unit,
    where: d.where,
    kind: d.kind,
  }));
  const changeRows: Array<Record<string, unknown>> = [];
  for (const group of chunk(drafted, 8)) {
    const part = await ask<Array<Record<string, unknown>>>(asker, {
      phase: 3,
      id: "changes",
      root: trees.head,
      prompt: prompt([
        "Phase 3. Change-test every decision in this batch. Answer only from the before and after lines below. No profile. No PR type.",
        "no means the choice is the same. yes means it differs. ambiguous means the diff touches the unit and the difference is not clear.",
        "neither is new code or a swap with no before choice. narrower only adds checks. wider only relaxes them.",
        group
          .map((d) => {
            const text = hunks.find((h) => h.id === String(d.hunk).replace(/\.\d+$/, ""))?.text ?? "";
            return `${JSON.stringify(d)}\n${text}`;
          })
          .join("\n\n"),
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
      change: change.change === "yes" || change.change === "ambiguous" || change.change === "no" ? change.change : null,
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

  const files = [...new Set(hunks.map((h) => h.file))];
  const typed = classifyDiff(files, hunks);
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
        `Ask in this order when a topic has the question. The order does not skip any question and does not change the score. ${typed.order.join(", ") || "listed order"}.`,
        `P1: ${p1}`,
        `P2: ${p2}`,
        topics
          .map((t) =>
            [
              `${t.id}: ${t.description} at ${t.where}`,
              region(trees.head, t.where),
              region(trees.head, t.consumer.citation),
            ].filter(Boolean).join("\n"),
          )
          .join("\n\n"),
        orderIds(crkIds, typed.order).map((id) => `${id}: ${QUESTIONS[id.split(".")[1] as keyof typeof QUESTIONS]}`).join("\n"),
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
    t.interrogated = top.has(t.id) || t.change_test === "ambiguous";
    if (t.interrogated) for (const qid of F_IDS) fIds.push(`${t.id}.${qid}`);
  }
  if (fIds.length) {
    const rows = await ask<Array<FactAnswer & { id: string }>>(asker, {
      phase: 5,
      id: "batch",
      root: trees.head,
      ids: fIds,
      prompt: prompt([
        "Phase 5. Answer every F question for the interrogated topics. A yes must set meets_direction.",
        `Ask in this order when present. ${typed.order.join(", ") || "listed order"}.`,
        `P5: ${p5}`,
        topics
          .filter((t) => t.interrogated)
          .map((t) => [`${t.id}: ${t.description}. Direction ${t.direction}.`, region(trees.head, t.where)].filter(Boolean).join("\n"))
          .join("\n\n"),
        orderIds(fIds, typed.order).map((id) => `${id}: ${QUESTIONS[id.split(".")[1] as keyof typeof QUESTIONS]}`).join("\n"),
      ]),
    });
    for (const row of rows) {
      const [tid, qid] = row.id.split(".");
      const topic = topics.find((t) => t.id === tid);
      if (topic && qid) topic.questions[qid] = row;
    }
  }
  await verifyYeses(asker, topics, trees.head, p1);

  const asked = topics.filter((t) => t.interrogated);
  if (asked.length) {
    const probes = await ask<Array<{ topic?: string; question?: string; action?: string; answer?: string; resolves?: string }>>(asker, {
      phase: 5,
      id: "probes",
      root: trees.head,
      ids: asked.map((t) => t.id),
      prompt: prompt([
        "Phase 5 probes. A probe has question, action, answer, and resolves.",
        "action is the read, grep, or symbol lookup at head. resolves names the fixed question and the state, like F6 → no.",
        "A probe does not score by itself. Templates, if any, only suggest where to look.",
        typed.probes.join("\n"),
        asked.map((t) => [`${t.id} ${t.description}`, region(trees.head, t.where)].filter(Boolean).join("\n")).join("\n\n"),
      ]),
    });
    const raised: Array<{ id: string; citation: string; claim: string; topic: TopicRow; qid: string; previous: FactAnswer & { verified?: boolean } }> = [];
    for (const row of probes) {
      const topic = topics.find((t) => t.id === row.topic);
      if (!topic) continue;
      topic.probes.push({
        question: String(row.question ?? ""),
        action: String(row.action ?? ""),
        answer: String(row.answer ?? ""),
        resolves: String(row.resolves ?? ""),
      });
      const resolved = /^((?:C\d|R1|R2|K|F\d+|B\d+))\s*(?:→|->)\s*(yes|all|flag_or_cohort)/.exec(String(row.resolves ?? ""));
      if (!resolved) continue;
      const qid = resolved[1];
      const cited = /([\w./-]+\.(?:ts|tsx|js|py|go|sql):\d+)/.exec(String(row.answer ?? ""));
      raised.push({
        id: `${topic.id}.${qid}`,
        citation: cited?.[1] ?? topic.where,
        claim: String(row.answer ?? ""),
        topic,
        qid,
        previous: topic.questions[qid],
      });
      topic.questions[qid] = {
        state: resolved[2] as FactAnswer["state"],
        citation: cited?.[1] ?? topic.where,
        reason: String(row.answer ?? ""),
      };
    }
    await applyVerify(asker, raised, trees.head, (id, supports) => {
      const hit = raised.find((item) => item.id === id);
      if (!hit) return;
      if (!supports) hit.topic.questions[hit.qid] = hit.previous;
      else if (hit.topic.questions[hit.qid]) hit.topic.questions[hit.qid].verified = true;
    });
  }

  const anyPoints = topics.some((t) => t.interrogated && ungated(t));
  const containment: Record<string, FactAnswer & { verified?: boolean }> = {};
  if (anyPoints) {
    const rows = await ask<Array<FactAnswer & { id: string }>>(asker, {
      phase: 5,
      id: "batch",
      root: trees.head,
      ids: [...B_IDS],
      prompt: prompt([
        "Containment B1 B2 B3 once for the PR, about the lines that can earn points.",
        "B1 is yes only if every scoring topic is behind a flag. B2 is yes only if every scoring topic emits a metric or log. B3 is yes only if a test would catch each of them.",
        topics.filter((t) => t.interrogated).map((t) => [`${t.id} ${t.where}`, region(trees.head, t.where)].join("\n")).join("\n\n"),
        B_IDS.map((id) => `${id}: ${QUESTIONS[id]}`).join("\n"),
      ]),
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
    prompt: prompt(["Phase 0 at the base SHA. Do not open the diff. Excerpts are not the whole repo.", profileSources(root), QUESTIONS.P1]),
  });
  const p2 = await ask<Record<string, unknown>>(asker, {
    phase: 0,
    id: "P2",
    root,
    prompt: prompt(["Phase 0. Five caller classes, each yes or no. Excerpts are not the whole repo.", profileSources(root), QUESTIONS.P2]),
  });
  const rest: Record<string, unknown> = {};
  for (const id of ["P3", "P4", "P5", "P6"] as const) {
    rest[id] = await ask(asker, { phase: 0, id, root, prompt: prompt(["Phase 0. Excerpts are not the whole repo.", profileSources(root), QUESTIONS[id]]) });
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
    prompt: prompt([
      "Verify each claim against its own cited lines. Return checks, one per id.",
      "supports is about the state. It is true when the lines show that state. A detail in the reason that sits outside the excerpt does not fail the state.",
      "supports:true does not verify a batch.",
      ...items.map((item) => `${item.id}\n${item.claim}\n${region(root, item.citation)}`),
      `CHECKS ${JSON.stringify(items.map((item) => ({ id: item.id })))}`,
    ]),
  });
  if (items.length === 1 && raw.supports === true && !Array.isArray(raw.checks)) {
    set(items[0].id, true);
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
