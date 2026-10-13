/**
 * Pi slash command. `/analyze-pr <github pull request url>` checks the PR out,
 * asks skill.md one question at a time through Pi, and writes the card.
 * Cursor is the model provider. The model never sees a weight.
 */
import "../src/fireweave/start.js"; // FireWeave: must stay the first import
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { accept, type Asker, type AskSpec } from "../src/accept.js";
import { checkoutPullRequest } from "../src/checkout.js";
import { loadEnv } from "../src/env.js";
import { analyze, readDiff } from "../src/machine.js";
import { P2_CLASSES } from "../src/questions.js";
import { snapshot } from "../src/snapshot.js";
import { assertBashInside, resolveInside } from "../src/root.js";
import { writeAndScore } from "../src/score.js";

loadEnv();

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  terminate?: boolean;
  isError?: boolean;
};

interface Model {
  provider: string;
  id: string;
}

interface Pi {
  registerCommand(name: string, spec: {
    description: string;
    handler: (args: string, ctx: CommandCtx) => Promise<void>;
  }): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }): void;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  setModel(model: Model): Promise<boolean>;
  on(event: string, handler: (event: { messages?: Array<{ role?: string }> }, ctx?: { model?: Model }) => Promise<{ messages?: unknown[] } | void> | { block?: boolean; reason?: string } | void): () => void;
  appendEntry(customType: string, data: unknown): void;
  sendUserMessage(content: string): void;
}

interface CommandCtx {
  ui: { notify: (message: string, level?: string) => void };
  cwd: string;
  mode: string;
  model?: Model;
  modelRegistry: { getAvailable: () => Model[] };
  isIdle(): boolean;
  abort(): void;
}

const loose = Type.Object({
  outcomes: Type.Optional(Type.Array(Type.Any())),
  classes: Type.Optional(Type.Array(Type.Any())),
  where_to_look: Type.Optional(Type.Array(Type.String())),
  state: Type.Optional(Type.String()),
  citation: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  where: Type.Optional(Type.String()),
  supports: Type.Optional(Type.Boolean()),
  units: Type.Optional(Type.Array(Type.Any())),
  decisions: Type.Optional(Type.Array(Type.Any())),
  topics: Type.Optional(Type.Array(Type.Any())),
  change: Type.Optional(Type.String()),
  before: Type.Optional(Type.String()),
  after: Type.Optional(Type.String()),
  direction: Type.Optional(Type.String()),
  meets_direction: Type.Optional(Type.Boolean()),
  unknown: Type.Optional(Type.Boolean()),
  dimensions: Type.Optional(Type.Array(Type.String())),
  answers: Type.Optional(Type.Array(Type.Any())),
  changes: Type.Optional(Type.Array(Type.Any())),
  checks: Type.Optional(Type.Array(Type.Any())),
});
const readParams = Type.Object({ path: Type.String() });
const bashParams = Type.Object({ command: Type.String() });

let phaseRoot = "";
let openSpec: AskSpec | null = null;
let captured: unknown;
let lastText = "";

function shape(spec: AskSpec): string {
  if (spec.phase === "verify") return '{"supports":true} or {"supports":false}';
  if (spec.phase === 0 && spec.id === "P1") return '{"outcomes":[{"outcome":"...","path":"a.ts:fn → b.ts:fn","citation":"a.ts:1"}]}';
  if (spec.phase === 0 && spec.id === "P2") {
    return `{"classes":[${P2_CLASSES.map((c) => `{"class":"${c}","state":"yes|no|unknown"}`).join(",")}]}`;
  }
  if (spec.phase === 0 && spec.id === "P7") return '{"where_to_look":["area"]}';
  if (spec.phase === 0) return '{"state":"yes|no|unknown","citation":"file.ts:1","reason":"..."}';
  if (spec.phase === 1) return '{"units":[{"hunk":"H1","unit":"name","unit_citation":"file.ts:1","enclosed":true}]}';
  if (spec.phase === 2) return '{"decisions":[{"hunk":"H1","unit":"name","where":"file.ts:1","kind":"check"}]}';
  if (spec.phase === 3 && spec.id === "changes") {
    return '{"changes":[{"decision":"D1","change":"no|yes|ambiguous","before":"...","after":"...","direction":"wider"}]}';
  }
  if (spec.phase === 3) return '{"change":"no|yes|ambiguous","before":"...","after":"...","direction":"wider"}';
  if (spec.phase === 4) return '{"topics":[{"decision_points":["D1"],"description":"...","where":"file.ts:1","kind":"check","direction":"wider","consumer":{"description":"...","citation":"file.ts:1"},"core_path":{"outcome_index":1,"path":"..."}}]}';
  if (spec.phase === 5 && spec.id === "batch") {
    return '{"answers":[{"id":"T1.C1","state":"yes|no|unknown","citation":"file.ts:1","reason":"...","meets_direction":true}]}';
  }
  if (spec.id === "batch" && "citation" in spec) return '{"supports":true} or {"checks":[{"id":"D1","supports":true}]}';
  if (/\.F\d+$/.test(spec.id)) return '{"state":"yes|no|unknown","citation":"file.ts:1","reason":"...","meets_direction":true}';
  if (spec.id.endsWith(".R1")) return '{"state":"all|flag_or_cohort|none|unknown","citation":"file.ts:1","reason":"..."}';
  return '{"state":"yes|no|unknown","citation":"file.ts:1","reason":"..."}';
}

function submitName(spec: AskSpec): string {
  if (spec.phase === 1) return "submit_units";
  if (spec.phase === 2) return "submit_decisions";
  if (spec.phase === 4) return "submit_topics";
  return "submit_answer";
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json");
  return JSON.parse(body.slice(start, end + 1));
}

function tryTake(text: string): boolean {
  if (!openSpec || captured !== undefined || !text) return false;
  try {
    const parsed = extractJson(text) as Record<string, unknown>;
    if (openSpec.phase === 0 && openSpec.id === "P1" && Array.isArray(parsed.outcomes) && parsed.outcomes.length > 3) {
      parsed.outcomes = parsed.outcomes.slice(0, 3);
    }
    accept(openSpec, parsed);
    captured = parsed;
    return true;
  } catch {
    return false;
  }
}

function runsRoot(cwd: string): string {
  if (fs.existsSync(path.join(cwd, "pi-agent", "package.json"))) return path.join(cwd, "pi-agent", "runs");
  return path.join(cwd, "runs");
}

export default function (pi: Pi) {
  pi.registerTool({
    name: "read_root",
    label: "read",
    description: "Read a file inside the current phase root. path is relative to that root.",
    parameters: readParams,
    async execute(_id, params) {
      const file = resolveInside(phaseRoot, String(params.path ?? ""));
      return { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] };
    },
  });
  pi.registerTool({
    name: "bash_root",
    label: "bash",
    description: "Run a shell command whose paths stay inside the current phase root.",
    parameters: bashParams,
    async execute(_id, params) {
      const command = String(params.command ?? "");
      assertBashInside(phaseRoot, command);
      const child = spawn("bash", ["-lc", command], { cwd: phaseRoot });
      let out = "";
      child.stdout.on("data", (b) => { out += String(b); });
      child.stderr.on("data", (b) => { out += String(b); });
      const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
      return { content: [{ type: "text", text: `exit ${code}\n${out.slice(0, 20_000)}` }] };
    },
  });
  for (const name of ["submit_answer", "submit_units", "submit_decisions", "submit_topics"]) {
    pi.registerTool({
      name,
      label: name,
      description: "Submit the answer for the open question. This is the only way to finish the question.",
      parameters: loose,
      async execute(_id, params) {
        log(`submit ${name}`);
        if (!openSpec) return { content: [{ type: "text", text: "no question is open" }], isError: true };
        const raw = { ...params };
        if (openSpec.phase === 0 && openSpec.id === "P1" && Array.isArray(raw.outcomes) && raw.outcomes.length > 3) {
          raw.outcomes = raw.outcomes.slice(0, 3);
        }
        try {
          accept(openSpec, raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`rejected ${openSpec.id}: ${message} keys ${Object.keys(raw).join(",") || "(none)"}`);
          return { content: [{ type: "text", text: message }], isError: true };
        }
        captured = raw;
        pi.appendEntry("pr-decision-answer", { id: openSpec.id, params: raw });
        return { content: [{ type: "text", text: "recorded" }], terminate: true };
      },
    });
  }

  pi.on("context", async (event) => {
    const messages = event.messages ?? [];
    if (!openSpec || messages.length === 0) return;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        start = i;
        break;
      }
    }
    const system = messages.filter((message) => message?.role === "system");
    const turn = messages.slice(start).filter((message) => message?.role !== "system");
    return { messages: [...system, ...turn] };
  });

  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }).message;
    if (!openSpec || captured !== undefined || message?.role !== "assistant") return;
    const text = (message.content ?? []).map((part) => part.text ?? "").join("\n");
    if (text) lastText = text;
    tryTake(text);
  });

  pi.on("tool_call", (event) => {
    const name = (event as { toolName?: string }).toolName ?? "";
    if (!openSpec) return;
    const allowed = new Set(["read_root", "bash_root", submitName(openSpec)]);
    if (!allowed.has(name)) return { block: true, reason: `only ${[...allowed].join(", ")} are available for this question` };
  });

  pi.registerCommand("analyze-pr", {
    description: "Score a GitHub pull request with skill.md. Argument: the pull request URL.",
    handler: async (args, ctx) => {
      const url = args.trim().split(/\s+/)[0] ?? "";
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) {
        ctx.ui.notify("Pass a GitHub pull request URL, for example /analyze-pr https://github.com/owner/repo/pull/21", "error");
        process.exitCode = 1;
        throw new Error("analyze-pr needs a GitHub pull request URL");
      }
      const { analyzeUrl } = await import("../src/run.js");
      ctx.ui.notify(`Checking out ${url}`, "info");
      const result = await analyzeUrl(url, ctx.cwd);
      const summary = `${result.score.score} ${result.score.band} complete=${result.score.complete}\n${result.outDir}/card.md`;
      ctx.ui.notify(summary, result.score.complete ? "info" : "error");
    },
  });
}

function idle(ctx: CommandCtx, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (ctx.isIdle() || Date.now() - start > ms) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

function waitForSubmit(pi: Pi, ctx: CommandCtx, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (captured !== undefined || tryTake(lastText)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 150_000) {
        clearInterval(timer);
        ctx.abort();
        reject(new Error("no submit in 150s"));
      }
    }, 100);
    pi.sendUserMessage(prompt);
  });
}

async function useCursor(pi: Pi, ctx: CommandCtx): Promise<void> {
  if (ctx.model?.provider === "cursor") return;
  const wanted = process.env.PI_CURSOR_MODEL || "default";
  const available = ctx.modelRegistry.getAvailable().filter((m) => m.provider === "cursor");
  const model = available.find((m) => m.id === wanted) ?? available.find((m) => m.id === "default");
  if (!model) throw new Error("No Cursor model is available. Install pi-cursor-auth and set CURSOR_API_KEY.");
  const ok = await pi.setModel(model);
  if (!ok) throw new Error(`Could not select cursor/${model.id}. Set CURSOR_API_KEY before starting pi.`);
  log(`model cursor/${model.id}`);
}
