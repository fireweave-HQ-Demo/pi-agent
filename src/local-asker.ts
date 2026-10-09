import path from "node:path";
import { verifyChecks, type Asker, type AskSpec } from "./accept.js";
import type { Hunk } from "./diff.js";

const NO = (reason: string) => ({ state: "no" as const, reason });

const FACT: Record<string, unknown> = {
  C1: NO("parseDifficulty is input validation on a game start, not auth"),
  C2: NO("no secret and no interpreter of untrusted text"),
  C3: {
    state: "yes",
    citation: "apps/api/src/application/games.ts:106",
    reason: "difficulty is stored on the match row and applyBotMove reads it later",
  },
  C4: NO("engines and web ship in the same arcade deployable"),
  C5: {
    state: "yes",
    citation: "packages/engines/src/lib/difficulty.ts:4",
    reason: "the chosen level changes the bot the player faces and therefore the game they get",
  },
  R1: {
    state: "flag_or_cohort",
    citation: "apps/web/src/App.tsx:236",
    reason: "the picker is behind control point game-difficulty, default false",
  },
  R2: NO("one arcade deployable"),
  K: {
    state: "yes",
    citation: "apps/api/src/application/games.ts:209",
    reason: "bot move during play is a core P1 path: play a catalog game",
  },
  F1: NO("unknown difficulty in the body is 400; omitted stays undefined"),
  F2: NO("omitted and mid keep the engine's current depth"),
  F3: NO("no tenant or owner dimension left"),
  F4: {
    state: "yes",
    citation: "apps/api/src/application/games.ts:45",
    reason: "accepted bot levels grow to easy, mid, hard, nightmare",
    meets_direction: true,
  },
  F5: {
    state: "yes",
    citation: "apps/api/src/interfaces/http/router.ts:204",
    reason: "the client body now chooses the bot the engine will play",
    meets_direction: true,
  },
  F6: NO("depthFor still caps hard and nightmare"),
  F7: NO("one start writes one difficulty"),
  F8: {
    state: "yes",
    citation: "apps/web/src/App.tsx:236",
    reason: "flag off keeps the old play screen; flag on shows the picker",
    meets_direction: true,
  },
  F9: NO("level is not a secret"),
  F10: NO("new column, existing rows stay null"),
  F11: NO("auth.me still runs before newMatch"),
  B1: {
    state: "yes",
    citation: "apps/web/src/App.tsx:236",
    reason: "game-difficulty can be turned off without a deploy",
  },
  B2: {
    state: "yes",
    citation: "apps/web/src/App.tsx:322",
    reason: "arcade_web_difficulty_errors_total is emitted on start failure",
  },
  B3: NO("no test file mentions difficulty"),
};

function unitOf(h: Hunk): string {
  const named =
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(h.text) ||
    /(?:const|let)\s+(\w+)\s*=/.exec(h.text) ||
    /^\+\s*(?:async\s+)?(\w+)\s*\(/.exec(h.text);
  return named?.[1] ?? path.basename(h.file, path.extname(h.file));
}

function kindOf(h: Hunk): string {
  const t = h.text;
  if (/parseDifficulty|unknown difficulty|controlPoints/.test(t)) return "check";
  if (/if\s*\(|\?\:|===/.test(t)) return "condition";
  if (/INSERT|ADD COLUMN|difficulty:/.test(t)) return "write";
  if (/return /.test(t)) return "return_value";
  return "write";
}

function material(row: { where?: string; hunk?: string; unit?: string }): boolean {
  return /difficulty|depthFor|parseDifficulty|LEVELS|game-difficulty|applyBotMove|BotDifficulty|games\.ts|App\.tsx|router\.ts|match-repo|engines|game-core/.test(
    `${row.where ?? ""} ${row.hunk ?? ""} ${row.unit ?? ""}`,
  );
}

function decisionsFromPrompt(prompt: string): Array<{ id: string; where?: string; hunk?: string; unit?: string }> {
  const start = prompt.lastIndexOf("[");
  if (start < 0) return [];
  let depth = 0;
  for (let i = start; i < prompt.length; i++) {
    if (prompt[i] === "[") depth += 1;
    else if (prompt[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(prompt.slice(start, i + 1)) as Array<{
            id: string;
            where?: string;
            hunk?: string;
            unit?: string;
          }>;
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function changedFromPrompt(prompt: string): Array<{ id: string; where?: string }> {
  const start = prompt.indexOf('{"p1"');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(prompt.slice(start)) as { changed?: Array<{ id: string; where?: string }> };
    return parsed.changed ?? [];
  } catch {
    return [];
  }
}

/** Answers taken from the Arcade PR 21 checkout. The graph still assigns the numbers. */
export function localAsker(): Asker {
  return {
    async ask(spec: AskSpec) {
      if (spec.phase === "verify") return verifyChecks(spec.prompt);
      if (spec.phase === 0 && spec.id === "P1") {
        return {
          outcomes: [
            {
              outcome: "let callers authenticate, play turn-based games, and read history",
              path: "apps/web/src/App.tsx:PlayPage → apps/api/src/interfaces/http/router.ts → packages/engines",
              citation: "apps/api/src/application/games.ts:89",
            },
          ],
        };
      }
      if (spec.phase === 0 && spec.id === "P2") {
        return {
          classes: [
            { class: "end_users_ui", state: "yes", citation: "apps/web/src/App.tsx:233" },
            { class: "other_services", state: "no", reason: "first-party web and API only" },
            { class: "embedded_sdk_clients", state: "no", reason: "packages are in-repo" },
            { class: "operators_admins", state: "yes", citation: "apps/web/src/Admin.tsx:1" },
            { class: "ci_automation_only", state: "no", reason: "runtime web callers exist" },
          ],
        };
      }
      if (spec.phase === 0 && spec.id === "P3") return { state: "no", reason: "ships as the arcade app" };
      if (spec.phase === 0 && spec.id === "P4") {
        return { state: "yes", citation: "apps/api/src/infrastructure/db/match-repo.ts:1", reason: "matches persist" };
      }
      if (spec.phase === 0 && spec.id === "P5") {
        return { state: "yes", citation: "apps/api/src/application/auth.ts:1", reason: "session auth on routes" };
      }
      if (spec.phase === 0 && spec.id === "P6") return { state: "no", reason: "no payments" };
      if (spec.phase === 0 && spec.id === "P7") return { where_to_look: ["apps/api", "apps/web"] };
      if (spec.phase === 1) {
        return {
          units: spec.hunks.map((h) => ({
            hunk: h.id,
            unit: unitOf(h),
            unit_citation: `${h.file}:${h.new_start}`,
            enclosed: true,
          })),
        };
      }
      if (spec.phase === 2) {
        const hunks = spec.hunks ?? [];
        return {
          decisions: hunks.map((h) => ({
            hunk: h.id,
            unit: unitOf(h),
            where: `${h.file}:${h.new_start}`,
            kind: kindOf(h),
          })),
        };
      }
      if (spec.phase === 3 && spec.id === "changes") {
        let group = decisionsFromPrompt(spec.prompt);
        if (group.length === 0) {
          group = Array.from({ length: 24 }, (_, i) => ({ id: `D${i + 1}` }));
        }
        return {
          changes: group.map((d) => {
            const yes = !d.where && !d.unit ? true : material(d);
            return yes
              ? {
                  decision: d.id,
                  change: "yes",
                  before: "bot used the engine default",
                  after: "bot uses a stored difficulty",
                  direction: "wider",
                }
              : { decision: d.id, change: "no" };
          }),
        };
      }
      if (spec.phase === 4) {
        const changed = changedFromPrompt(spec.prompt);
        const ids = changed.map((d) => d.id);
        return {
          topics: [
            {
              decision_points: ids.length ? ids : ["D1"],
              description: "Player-chosen bot difficulty is stored on the match and changes how the bot plays",
              where: "packages/engines/src/lib/difficulty.ts:4",
              kind: "return_value",
              direction: "wider",
              consumer: {
                description: "applyBotMove on a playing match",
                citation: "apps/api/src/application/games.ts:209",
              },
              core_path: {
                outcome_index: 1,
                path: "App.tsx:PlayPage → router.ts:newMatch → games.ts:applyBotMove → depthFor",
              },
            },
          ],
        };
      }
      if (spec.phase === 5 && spec.id === "batch") {
        return {
          answers: (spec.ids ?? []).map((id) => {
            const key = id.includes(".") ? id.split(".").pop()! : id;
            return { id, ...(FACT[key] as object) };
          }),
        };
      }
      const key = spec.id.includes(".") ? spec.id.split(".").pop()! : spec.id;
      return FACT[key] ?? { state: "unknown", reason: "no local answer" };
    },
  };
}
