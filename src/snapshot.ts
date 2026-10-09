import fs from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "mirror.git"]);

/** Enough of the tree for one question. The model should not walk the disk. */
export function snapshot(root: string, limit = 40_000): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name) || name.endsWith(".lock") || name.endsWith(".tgz")) continue;
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else files.push(path.relative(root, abs));
    }
  };
  walk(root);
  const listing = `FILES\n${files.slice(0, 400).join("\n")}`;
  const prefer = files.filter((f) => /^(readme|package\.json|apps\/|packages\/|src\/)/i.test(f) || /\.(md|ts|tsx|js|json)$/.test(f));
  const chunks = [listing];
  for (const rel of prefer) {
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.size > 16_000) continue;
    chunks.push(`FILE ${rel}\n${fs.readFileSync(abs, "utf8")}`);
    if (chunks.join("\n\n").length > limit) break;
  }
  return chunks.join("\n\n").slice(0, limit);
}
