export interface Hunk {
  id: string;
  file: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  text: string;
}

/** Unified diff → hunks. Phase 1 starts from this list, not from the model. */
export function parseUnifiedDiff(diff: string): Hunk[] {
  const lines = diff.split("\n");
  let file = "";
  const hunks: Hunk[] = [];
  let buf: string[] = [];
  let current: Omit<Hunk, "text"> | null = null;

  const flush = () => {
    if (!current) return;
    hunks.push({ ...current, text: buf.join("\n") });
    buf = [];
    current = null;
  };

  for (const line of lines) {
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus) {
      flush();
      file = plus[1] === "/dev/null" ? "" : plus[1];
      continue;
    }
    const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (at && file) {
      flush();
      current = {
        id: `H${hunks.length + 1}`,
        file,
        old_start: Number(at[1]),
        old_lines: at[2] === undefined ? 1 : Number(at[2]),
        new_start: Number(at[3]),
        new_lines: at[4] === undefined ? 1 : Number(at[4]),
      };
      buf = [line];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return hunks;
}
