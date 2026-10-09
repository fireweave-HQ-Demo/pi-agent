import path from "node:path";

/** Reject a path that would leave the phase root. Built-in read/bash are not used. */
export function resolveInside(root: string, rel: string): string {
  if (!rel || rel.includes("\0")) throw new Error("empty path");
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path leaves the phase root: ${rel}`);
  }
  return abs;
}

const FORBIDDEN = /\bcd\b|\.\.|~\/|\$[A-Z_]|`|>\s*\/|<\s*\//;

/** bash is allowed only when every absolute path it names sits under root. */
export function assertBashInside(root: string, command: string): void {
  if (FORBIDDEN.test(command)) throw new Error("bash command is not confined to the phase root");
  const abs = command.match(/(?:^|[\s"'=])(\/[^ \t\n"'`;|&]+)/g) ?? [];
  const base = path.resolve(root);
  for (const raw of abs) {
    const p = raw.trim().replace(/^[\s"'=]/, "");
    const resolved = path.resolve(p);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`bash path leaves the phase root: ${p}`);
    }
  }
}
