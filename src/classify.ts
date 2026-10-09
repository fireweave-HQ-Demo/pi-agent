import type { Hunk } from "./diff.js";

export interface PrTypeHit {
  type: string;
  order: string[];
}

const ORDER: Record<string, string[]> = {
  Feature: ["R1", "K", "C1"],
  "Bug fix": ["direction", "F2", "F1"],
  Refactor: ["change test", "F11"],
  Hardening: ["direction", "F1"],
  Migration: ["F10", "F8"],
  Dependency: ["change test", "F8"],
  Config: ["R1", "F2", "F4"],
  "API / contract": ["C4", "K", "F8"],
  Revert: ["change test", "F8", "F10"],
  Performance: ["F6", "F2", "F3", "F7"],
  Test: ["change test"],
  Docs: ["change test"],
  Chore: ["change test"],
};

function isTest(file: string): boolean {
  return /\.(test|spec)\./.test(file) || file.includes("__tests__") || file.startsWith("test/");
}
function isDocs(file: string): boolean {
  return /\.(md|rst|adoc)$/.test(file) || file.startsWith("docs/");
}
function isMigration(file: string): boolean {
  return /migrat/i.test(file) || file.endsWith(".sql");
}
function isDep(file: string): boolean {
  return /(^|\/)(package\.json|go\.mod|Cargo\.toml|requirements.*\.txt|poetry\.lock|package-lock\.json|pnpm-lock\.yaml)$/.test(file);
}
function isConfig(file: string): boolean {
  return /\.(ya?ml|toml|ini|env)$/.test(file) || file.includes(".github/workflows") || /(^|\/)Dockerfile$/.test(file);
}
function isContract(file: string): boolean {
  return /\/(sdk|client|proto|openapi|schema)\//.test(file) || file.endsWith(".proto");
}

/**
 * skill.md §4, as a matcher over paths and hunk headers. Not a model call.
 * Runs only at the start of phase 5. It orders questions; it does not score.
 */
export function classifyDiff(files: string[], hunks: Hunk[]): { types: string[]; order: string[] } {
  const hits: string[] = [];
  const add = (t: string) => {
    if (!hits.includes(t)) hits.push(t);
  };
  for (const file of files) {
    if (isTest(file)) add("Test");
    else if (isDocs(file)) add("Docs");
    else if (isMigration(file)) add("Migration");
    else if (isDep(file)) add("Dependency");
    else if (isConfig(file)) add("Config");
    else if (isContract(file)) add("API / contract");
  }
  const sourceHunk = hunks.some((h) => !isTest(h.file) && !isDocs(h.file) && h.old_lines > 0 && h.new_lines > 0);
  if (sourceHunk && hits.length === 0) add("Bug fix");
  if (hits.length === 0) add("Chore");
  const order = hits.flatMap((t) => ORDER[t] ?? []);
  return { types: hits, order };
}
