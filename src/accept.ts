import { B_IDS, C_IDS, CRK_IDS, DIRECTIONS, F_IDS, KINDS, P2_CLASSES } from "./questions.js";
import type { Hunk } from "./diff.js";

export type Kind = (typeof KINDS)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type YesNo = "yes" | "no" | "unknown";
export type Reach = "all" | "flag_or_cohort" | "none" | "unknown";

export interface Trees {
  runDir: string;
  head: string;
  base: string;
  diffPath: string;
  meta: {
    owner: string;
    repo: string;
    number: number;
    base_sha: string;
    head_sha: string;
    url?: string;
  };
}

export interface UnitAnswer {
  hunk: string;
  unit: string | null;
  unit_citation: string | null;
  enclosed: boolean;
}

export interface DecisionAnswer {
  hunk: string;
  unit: string;
  where: string;
  kind: Kind;
}

export interface ChangeAnswer {
  change: "no" | "yes" | "ambiguous";
  before?: string;
  after?: string;
  direction?: Direction;
}

export interface TopicAnswer {
  decision_points: string[];
  description: string;
  where: string;
  kind: Kind;
  direction: Direction;
  consumer: { description: string; citation: string | null };
  core_path: { outcome_index: number | null; path: string | null };
}

export interface FactAnswer {
  state: YesNo | Reach;
  citation?: string;
  reason?: string;
  meets_direction?: boolean;
}

export interface VerifyAnswer {
  supports: boolean;
}

export type AskSpec =
  | { phase: 0; id: "P1"; root: string; prompt: string }
  | { phase: 0; id: "P2"; root: string; prompt: string }
  | { phase: 0; id: "P3" | "P4" | "P5" | "P6"; root: string; prompt: string }
  | { phase: 0; id: "P7"; root: string; prompt: string }
  | { phase: 1; id: "units"; root: string; prompt: string; hunks: Hunk[] }
  | { phase: 2; id: "decisions"; root: string; prompt: string; hunk: string; hunks?: Hunk[] }
  | { phase: 3; id: "change"; root: string; prompt: string; decision: string }
  | { phase: 3; id: "changes"; root: string; prompt: string }
  | { phase: 4; id: "topics"; root: string; prompt: string }
  | { phase: 5; id: string; root: string; prompt: string; topic?: string; ids?: string[] }
  | { phase: "verify"; id: string; root: string; prompt: string; citation: string; path?: string; outcome?: string };

export interface Asker {
  ask(spec: AskSpec): Promise<unknown>;
}

const YESNO = new Set(["yes", "no", "unknown"]);
const REACH = new Set(["all", "flag_or_cohort", "none", "unknown"]);

function obj(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label} must be an object`);
  return v as Record<string, unknown>;
}

function fact(v: unknown, label: string, reach = false): FactAnswer {
  const o = obj(v, label);
  const state = String(o.state ?? "");
  if (reach) {
    if (!REACH.has(state)) {
      return { state: "unknown", reason: `model returned ${state || "empty"}, not a reach state` };
    }
  } else if (!YESNO.has(state)) {
    return { state: "unknown", reason: `model returned ${state || "empty"}` };
  }
  if (state === "yes" || state === "all" || state === "flag_or_cohort") {
    if (typeof o.citation !== "string" || !o.citation) throw new Error(`${label} yes requires citation`);
  } else if (typeof o.reason !== "string" || !o.reason) {
    throw new Error(`${label} ${state} requires reason`);
  }
  const out: FactAnswer = { state: state as FactAnswer["state"] };
  if (typeof o.citation === "string") out.citation = o.citation;
  if (typeof o.reason === "string") out.reason = o.reason;
  if (typeof o.meets_direction === "boolean") out.meets_direction = o.meets_direction;
  return out;
}

/** Canned verifiers read CHECKS from the prompt and confirm each id. A batch supports:true is not a second pass. */
export function verifyChecks(prompt: string): { supports: true } | { checks: Array<{ id: string; supports: boolean }> } {
  const marker = prompt.lastIndexOf("CHECKS ");
  if (marker < 0) return { supports: true };
  const items = JSON.parse(prompt.slice(marker + "CHECKS ".length)) as Array<{ id: string }>;
  return { checks: items.map((item) => ({ id: item.id, supports: true })) };
}

export function accept(spec: AskSpec, raw: unknown): unknown {
  if (spec.phase === "verify") {
    const o = obj(raw, spec.id);
    if (Array.isArray(o.checks)) return o;
    if (typeof o.supports !== "boolean") throw new Error(`${spec.id} verify requires supports`);
    return { supports: o.supports } satisfies VerifyAnswer;
  }
  if (spec.phase === 0 && spec.id === "P1") {
    const o = obj(raw, "P1");
    if (o.unknown === true) {
      if (typeof o.reason !== "string") throw new Error("P1 unknown requires reason");
      return o;
    }
    if (!Array.isArray(o.outcomes) || o.outcomes.length < 1 || o.outcomes.length > 3) {
      throw new Error("P1 needs 1–3 outcomes");
    }
    for (const item of o.outcomes) {
      const x = obj(item, "P1 outcome");
      if (typeof x.outcome !== "string" || typeof x.path !== "string" || typeof x.citation !== "string") {
        throw new Error("P1 outcome needs outcome, path, citation");
      }
    }
    return o;
  }
  if (spec.phase === 0 && spec.id === "P2") {
    const o = obj(raw, "P2");
    if (!Array.isArray(o.classes) || o.classes.length !== P2_CLASSES.length) {
      throw new Error("P2 needs all five caller classes");
    }
    const seen = new Set<string>();
    for (const item of o.classes) {
      const x = obj(item, "P2 class");
      const name = String(x.class ?? "");
      if (!(P2_CLASSES as readonly string[]).includes(name)) throw new Error(`P2 unknown class ${name}`);
      seen.add(name);
      fact({ state: x.state, citation: x.citation, reason: x.reason }, name);
    }
    for (const name of P2_CLASSES) if (!seen.has(name)) throw new Error(`P2 missing ${name}`);
    return o;
  }
  if (spec.phase === 0 && (spec.id === "P3" || spec.id === "P4" || spec.id === "P5" || spec.id === "P6")) {
    const o = obj(raw, spec.id);
    fact(o, spec.id);
    return o;
  }
  if (spec.phase === 0 && spec.id === "P7") {
    const o = obj(raw, "P7");
    if (!Array.isArray(o.where_to_look) || o.where_to_look.some((x) => typeof x !== "string")) {
      throw new Error("P7 needs where_to_look strings");
    }
    return o;
  }
  if (spec.phase === 1) {
    const o = obj(raw, "units");
    if (!Array.isArray(o.units)) throw new Error("units must be a list");
    return o.units;
  }
  if (spec.phase === 2) {
    const o = obj(raw, "decisions");
    if (!Array.isArray(o.decisions)) throw new Error("decisions must be a list");
    for (const d of o.decisions) {
      const x = obj(d, "decision");
      if (!(KINDS as readonly string[]).includes(String(x.kind))) throw new Error(`bad kind ${String(x.kind)}`);
      if (typeof x.where !== "string") throw new Error("decision needs where");
    }
    return o.decisions;
  }
  if (spec.phase === 3 && spec.id === "changes") {
    const o = obj(raw, "changes");
    if (!Array.isArray(o.changes)) throw new Error("changes must be a list");
    return o.changes;
  }
  if (spec.phase === 3) {
    const o = obj(raw, "change");
    const change = String(o.change ?? "");
    if (!["no", "yes", "ambiguous"].includes(change)) throw new Error("change test state invalid");
    if (change !== "no") {
      if (typeof o.before !== "string" || typeof o.after !== "string") throw new Error("change needs before and after");
      if (!(DIRECTIONS as readonly string[]).includes(String(o.direction))) throw new Error("change needs direction");
    }
    return o;
  }
  if (spec.phase === 4) {
    const o = obj(raw, "topics");
    if (!Array.isArray(o.topics)) throw new Error("topics must be a list");
    return o.topics;
  }
  if (spec.phase === 5 && spec.id === "probes") {
    const o = obj(raw, "probes");
    if (!Array.isArray(o.probes)) throw new Error("probes must be a list");
    return o.probes;
  }
  if (spec.phase === 5 && spec.id === "batch") {
    const o = obj(raw, "batch");
    if (!Array.isArray(o.answers)) throw new Error("batch needs answers");
    return o.answers.map((item) => {
      const x = obj(item, "batch answer");
      const id = String(x.id ?? "");
      const reach = id.endsWith(".R1") || id === "R1";
      const failure = F_IDS.some((f) => id.endsWith(`.${f}`) || id === f);
      const ans = fact(x, id, reach);
      if (failure && ans.state === "yes" && typeof ans.meets_direction !== "boolean") {
        throw new Error(`${id} yes requires meets_direction`);
      }
      return { id, ...ans };
    });
  }
  if (spec.phase === 5) {
    const reach = spec.id.endsWith(".R1") || spec.id === "R1";
    const failure = F_IDS.some((f) => spec.id.endsWith(`.${f}`));
    const ans = fact(raw, spec.id, reach);
    if (failure && ans.state === "yes" && typeof ans.meets_direction !== "boolean") {
      throw new Error(`${spec.id} yes requires meets_direction`);
    }
    return ans;
  }
  throw new Error(`unhandled ask ${spec.phase} ${spec.id}`);
}

export const QUESTION_GROUPS = { C_IDS, F_IDS, B_IDS, CRK_IDS };
