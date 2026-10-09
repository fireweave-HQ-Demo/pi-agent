import type { Asker, AskSpec } from "../src/accept.js";

const NO = (reason: string) => ({ state: "no", reason });

const FACT: Record<string, unknown> = {
  C1: { state: "yes", citation: "guard.ts:15", reason: "decides who may act" },
  C2: NO("no secret or interpreter"),
  C3: NO("no write"),
  C4: NO("same deployable"),
  C5: NO("not a display value"),
  R1: { state: "all", citation: "routes.ts:1", reason: "every route calls requireRole" },
  R2: NO("one deployable"),
  K: { state: "yes", citation: "guard.ts:15", reason: "guard.ts:15 → accounts.ts:act → outcome 1" },
  F1: NO("rejects on failure"),
  F2: NO("no default"),
  F3: NO("no dimension left"),
  F4: { state: "yes", citation: "guard.ts:12", reason: "moderator added to the passing set", meets_direction: true },
  F5: NO("role from session"),
  F6: NO("no bound"),
  F7: NO("no side effect"),
  F8: NO("one version live"),
  F9: NO("nothing logged"),
  F10: NO("no rows"),
  F11: NO("order unchanged"),
  B1: { state: "no", citation: "guard.ts:12", reason: "not behind a flag" },
  B2: { state: "unknown", reason: "no log or metric on requireRole in the changed unit" },
  B3: { state: "no", reason: "no test calls requireRole with a moderator" },
};

/** Canned answers for the identity-provider guard fixture. Records every spec the machine sends. */
export function identityAsker(seen: AskSpec[]): Asker {
  return {
    async ask(spec: AskSpec) {
      seen.push(spec);
      if (spec.phase === "verify") return spec.id === "batch" ? { supports: true } : { supports: true };
      if (spec.phase === 0 && spec.id === "P1") {
        return {
          outcomes: [
            {
              outcome: "whether a caller is allowed to act on an account",
              path: "routes.ts:accounts → accounts.ts:act",
              citation: "accounts.ts:3",
            },
          ],
        };
      }
      if (spec.phase === 0 && spec.id === "P2") {
        return {
          classes: [
            { class: "end_users_ui", state: "yes", citation: "routes.ts:1" },
            { class: "other_services", state: "yes", citation: "routes.ts:2" },
            { class: "embedded_sdk_clients", state: "no", reason: "nothing published" },
            { class: "operators_admins", state: "no", reason: "no admin surface" },
            { class: "ci_automation_only", state: "no", reason: "has runtime callers" },
          ],
        };
      }
      if (spec.phase === 0 && spec.id === "P3") return { state: "no", where: null, reason: "no package publish config" };
      if (spec.phase === 0 && spec.id === "P4") return { state: "yes", where: "db/migrations", citation: "db/migrations/001.sql:1" };
      if (spec.phase === 0 && spec.id === "P5") {
        return { state: "yes", where: "guard.ts", dimensions: ["role", "account"], citation: "guard.ts:12" };
      }
      if (spec.phase === 0 && spec.id === "P6") return { state: "no", reason: "no payment code" };
      if (spec.phase === 0 && spec.id === "P7") return { where_to_look: ["route handlers in routes.ts", "guards in guard.ts"] };
      if (spec.phase === 1) {
        return { units: spec.hunks.map((h) => ({ hunk: h.id, unit: "requireRole", unit_citation: "guard.ts:10", enclosed: true })) };
      }
      if (spec.phase === 2) {
        const ids = spec.hunks?.map((h) => h.id) ?? [spec.hunk];
        return { decisions: ids.map((hunk) => ({ hunk, unit: "requireRole", where: "guard.ts:12", kind: "check" })) };
      }
      if (spec.phase === 3 && spec.id === "changes") {
        return { changes: [{ decision: "D1", change: "yes", before: "passes role === 'admin'", after: "passes admin or moderator", direction: "wider" }] };
      }
      if (spec.phase === 3) {
        return { change: "yes", before: "passes role === 'admin'", after: "passes admin or moderator", direction: "wider" };
      }
      if (spec.phase === 4) {
        return {
          topics: [
            {
              decision_points: ["D1"],
              description: "Role check now passes moderator as well as admin",
              where: "guard.ts:12",
              kind: "check",
              direction: "wider",
              consumer: { description: "the handler it guards", citation: "guard.ts:15" },
              core_path: { outcome_index: 1, path: "guard.ts:15 → accounts.ts:act → P1 outcome 1" },
            },
          ],
        };
      }
      if (spec.phase === 5 && spec.id === "batch") {
        return {
          answers: (spec.ids ?? []).map((id) => {
            const key = id.includes(".") ? id.split(".").pop()! : id;
            const ans = FACT[key];
            if (!ans) throw new Error(`identity fixture has no answer for ${id}`);
            return { id, ...(ans as object) };
          }),
        };
      }
      const key = spec.id.includes(".") ? spec.id.split(".").pop()! : spec.id;
      const ans = FACT[key];
      if (!ans) throw new Error(`identity fixture has no answer for ${spec.id}`);
      return ans;
    },
  };
}
