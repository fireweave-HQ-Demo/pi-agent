/** Question text copied from skill.md §2–§3. A test fails if these drift. */

export const P2_CLASSES = [
  "end_users_ui",
  "other_services",
  "embedded_sdk_clients",
  "operators_admins",
  "ci_automation_only",
] as const;

export const KINDS = [
  "condition",
  "return_value",
  "predicate",
  "write",
  "default",
  "check",
  "call",
  "boundary",
  "error_handler",
] as const;

export const DIRECTIONS = ["narrower", "wider", "mixed", "neither"] as const;

export const QUESTIONS = {
  P1: "What does this repo exist to produce for its callers?",
  P2: "Who calls this repo?",
  P3: "Does the repo publish code that ships apart from itself?",
  P4: "Does the repo own records that outlive a request?",
  P5: "Does the repo authenticate or authorize callers?",
  P6: "Does the repo move money?",
  P7: "Where do consumers live?",
  C1: "Does the outcome decide whether a caller may proceed, who the caller is, or what the caller may do?",
  C2: "Does a secret flow through the outcome, or does input from outside the process reach something that interprets it (SQL, shell, path, template, deserializer, HTML)?",
  C3: "Does the outcome move money, or change a record that outlives the request and that another decision reads later?",
  C4: "Does the outcome cross to code that deploys separately: another service, an SDK inside someone else's app, a queue consumer, infrastructure?",
  C5: "Does the outcome change what a person sees, gets, or is scored or ranked on?",
  R1: "Which of the four reach states applies?",
  R2: "Is the decision in code that more than one deployable uses?",
  K: "Does the outcome of this decision feed a core outcome named in the profile (P1)?",
  F1: "Does an error, timeout, missing value, or unknown case now continue as allowed, success, or done?",
  F2: "Does the value used when nothing matches or nothing is provided change?",
  F3: "Does a dimension that constrained the outcome leave: user, tenant, org, owner, environment, key id, version, or any dimension named in the profile's P5?",
  F4: "Does the set that passes grow: roles, hosts, fields, ports, permissions, accepted algorithms, origins?",
  F5: "Does a value from a client, provider, webhook, or message now decide something it did not?",
  F6: "Does an amount, depth, retry count, loop, size, or TTL lose its cap, or does cost grow with input?",
  F7: "Can the same event run the side effect again, or run before something it depended on?",
  F8: "Can two versions be live at once and disagree?",
  F9: "Does a secret or a personal identifier reach a log, response, query string, client bundle, or committed file?",
  F10: "Does the change rewrite a record's history — overwrite or delete a posted row, or run a write that is not idempotent and not guarded by its own marker?",
  F11: "Does a guard start, stop, or reorder relative to the action it protects?",
  B1: "Is the change behind a flag that can be turned off without a deploy?",
  B2: "Is there observability that would show the change going wrong?",
  B3: "Is there a test that would catch the change going wrong?",
} as const;

export const C_IDS = ["C1", "C2", "C3", "C4", "C5"] as const;
export const F_IDS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11"] as const;
export const B_IDS = ["B1", "B2", "B3"] as const;
export const CRK_IDS = [...C_IDS, "R1", "R2", "K"] as const;

/** Same numbers score.py uses for rank. The PR score still comes only from score.py. */
export const BASE: Record<(typeof C_IDS)[number], number> = { C1: 30, C2: 30, C3: 20, C4: 15, C5: 8 };
export const REACH_MULT: Record<string, number> = { all: 1, flag_or_cohort: 0.5, none: 0, unknown: 0 };
export const K_MULT: Record<string, number> = { yes: 1.5, no: 1, unknown: 1 };
