import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accept, type Asker, type AskSpec } from "./accept.js";
import { loadEnv } from "./env.js";
import { P2_CLASSES } from "./questions.js";

loadEnv();

const MODEL = process.env.CURSOR_MODEL || "composer-2.5-fast";

function cursorKey(): string {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, ".env");
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m = /^CURSOR_API_KEY=(.*)$/.exec(line.trim());
        if (m && m[1]) return m[1];
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error("CURSOR_API_KEY is missing. Set it in the environment or the repo .env.");
}

function agentBin(): string {
  const local = path.join(os.homedir(), ".local", "bin", "cursor-agent");
  if (fs.existsSync(local)) return local;
  return "cursor-agent";
}

function shape(spec: AskSpec): string {
  if (spec.phase === "verify") return '{"supports":true} or {"supports":false}';
  if (spec.phase === 0 && spec.id === "P1") {
    return '{"outcomes":[{"outcome":"...","path":"file.ts:fn → file.ts:fn","citation":"file.ts:1"}]}';
  }
  if (spec.phase === 0 && spec.id === "P2") {
    return `{"classes":[${P2_CLASSES.map((c) => `{"class":"${c}","state":"yes|no|unknown","citation":"file.ts:1" or "reason":"..."}`).join(",")}]}`;
  }
  if (spec.phase === 0 && spec.id === "P7") return '{"where_to_look":["path or area"]}';
  if (spec.phase === 0) return '{"state":"yes|no|unknown","citation":"file.ts:1","reason":"...","where":"optional"}';
  if (spec.phase === 1) {
    const ids = spec.hunks.map((h) => h.id).join(", ");
    return `{"units":[{"hunk":"one of ${ids}","unit":"function name","unit_citation":"file.ts:1","enclosed":true}]}`;
  }
  if (spec.phase === 2) {
    return `{"decisions":[{"hunk":"${spec.hunk}","unit":"name","where":"file.ts:1","kind":"condition|return_value|predicate|write|default|check|call|boundary|error_handler"}]}`;
  }
  if (spec.phase === 3 && spec.id === "changes") {
    return '{"changes":[{"decision":"D1","change":"no|yes|ambiguous","before":"...","after":"...","direction":"narrower|wider|mixed|neither"}]}';
  }
  if (spec.phase === 3) return '{"change":"no|yes|ambiguous","before":"...","after":"...","direction":"narrower|wider|mixed|neither"}';
  if (spec.phase === 5 && spec.id === "batch") {
    return '{"answers":[{"id":"T1.C1","state":"yes|no|unknown","citation":"file.ts:1","reason":"...","meets_direction":true}]}';
  }
  if (spec.id === "batch" && "citation" in spec) return '{"supports":true} or {"checks":[{"id":"D1","supports":true}]}';
  if (spec.phase === 4) {
    return '{"topics":[{"decision_points":["D1"],"description":"...","where":"file.ts:1","kind":"check","direction":"wider","consumer":{"description":"...","citation":"file.ts:1"},"core_path":{"outcome_index":1,"path":"..."}}]}';
  }
  if (spec.phase === 5 && spec.id === "probes") {
    return '{"probes":[{"topic":"T1","question":"...","action":"read file.ts","answer":"...","resolves":"F6 → no"}]}';
  }
  const failure = /\.F\d+$/.test(spec.id) || /^F\d+$/.test(spec.id);
  if (failure) return '{"state":"yes|no|unknown","citation":"file.ts:1","reason":"...","meets_direction":true}';
  if (spec.id.endsWith(".R1") || spec.id === "R1") return '{"state":"all|flag_or_cohort|none|unknown","citation":"file.ts:1","reason":"..."}';
  return '{"state":"yes|no|unknown","citation":"file.ts:1","reason":"..."}';
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) throw new Error("model reply had no JSON object");
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error("model reply had no JSON object");
}

function callModel(spec: AskSpec, correction: string): string {
  const prompt = [
    "Reply with one JSON object. Do not edit files.",
    "Answer from the excerpts in the question. A file missing from an excerpt is not evidence that it is absent.",
    "The program that called you parses a single JSON object from your answer.",
    `JSON shape: ${shape(spec)}`,
    "A yes, all, or flag_or_cohort needs citation as path:line. A no or unknown needs reason.",
    spec.prompt,
    correction,
  ].filter(Boolean).join("\n\n");
  const env = { ...process.env, CURSOR_API_KEY: cursorKey(), PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH ?? ""}` };
  const run = spawnSync(
    agentBin(),
    ["-p", "--mode", "ask", "--trust", "--sandbox", "disabled", "--model", MODEL, "--output-format", "json", "--workspace", spec.root, prompt],
    { encoding: "utf8", env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (run.error) throw new Error(`cursor-agent failed to start: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`cursor-agent exited ${run.status}: ${(run.stderr || run.stdout || "").slice(-500)}`);
  const line = run.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).at(-1);
  if (!line) throw new Error(`cursor-agent returned no JSON: ${(run.stdout || run.stderr).slice(-400)}`);
  const wrapper = JSON.parse(line) as { is_error?: boolean; result?: string };
  if (wrapper.is_error) throw new Error(`cursor-agent error: ${wrapper.result ?? "unknown"}`);
  if (!wrapper.result) throw new Error("cursor-agent returned an empty result");
  return wrapper.result;
}

/** One Cursor call per question. The key is read from the environment or the repo .env and is not printed. */
export function cursorAsker(log: (line: string) => void = (line) => {
  process.stderr.write(line + "\n");
}): Asker {
  return {
    async ask(spec: AskSpec) {
      let last = "no answer";
      for (let attempt = 1; attempt <= 2; attempt++) {
        log(`cursor ${MODEL} phase ${String(spec.phase)} ${spec.id} attempt ${attempt}`);
        let text = "";
        try {
          text = callModel(spec, "");
          const parsed = extractJson(text);
          if (
            spec.phase === 0 &&
            spec.id === "P1" &&
            parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { outcomes?: unknown }).outcomes)
          ) {
            const outcomes = (parsed as { outcomes: unknown[] }).outcomes;
            if (outcomes.length > 3) (parsed as { outcomes: unknown[] }).outcomes = outcomes.slice(0, 3);
          }
          accept(spec, parsed);
          return parsed;
        } catch (err) {
          last = err instanceof Error ? err.message : String(err);
          log(`rejected ${spec.id}: ${last.slice(0, 400)}`);
          if (text) log(`reply: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
        }
      }
      throw new Error(`${spec.id} was not a valid answer after 2 tries: ${last}`);
    },
  };
}
