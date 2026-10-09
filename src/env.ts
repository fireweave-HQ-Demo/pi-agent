import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = ["CURSOR_API_KEY", "GITHUB_TOKEN"] as const;

/** Copy missing keys from a parent `.env`. Never prints the values. */
export function loadEnv(): void {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const file = path.join(dir, ".env");
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eq = trimmed.indexOf("=");
          if (eq < 1) continue;
          const name = trimmed.slice(0, eq);
          if (!(NAMES as readonly string[]).includes(name)) continue;
          if (process.env[name]) continue;
          let value = trimmed.slice(eq + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (value) process.env[name] = value;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
}

export function envValue(name: (typeof NAMES)[number]): string | undefined {
  loadEnv();
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function scrub(text: string): string {
  let out = text;
  for (const name of NAMES) {
    const value = process.env[name];
    if (value) out = out.split(value).join(`[${name}]`);
  }
  return out;
}
