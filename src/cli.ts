import "./fireweave/start.js"; // FireWeave: must stay the first import
import { analyzeUrl } from "./run.js";
import { runCursorE2E, runIdentityE2E } from "./e2e.js";

const usage = `pr-decision-agent

Usage:
  npm test
  npm run e2e:scripted
  npm run analyze -- https://github.com/owner/repo/pull/123

  pi --extension ./extensions/index.ts
  /analyze-pr https://github.com/owner/repo/pull/123

Copy .env.example to .env and set CURSOR_API_KEY before a live run.
A live PR also needs cursor-agent on PATH. GITHUB_TOKEN is only required for private repos.
`;

const scripted = process.argv.includes("--scripted");
const liveE2E = process.argv.includes("--e2e");
const urlArg = process.argv.find((arg) => arg.startsWith("https://github.com/"));
const help = process.argv.includes("--help") || process.argv.includes("-h");

if (help || (!scripted && !liveE2E && !urlArg)) {
  process.stdout.write(usage);
  process.exit(help || process.argv.length <= 2 ? 0 : 1);
}

if (urlArg) {
  const result = await analyzeUrl(urlArg);
  console.log(`${result.score.score} ${result.score.band} complete=${result.score.complete}`);
  console.log(result.outDir);
  process.exit(result.score.complete ? 0 : 1);
}

const result = scripted ? await runIdentityE2E() : await runCursorE2E();
console.log(`${result.score.score} ${result.score.band} complete=${result.score.complete}`);
console.log(result.outDir);
if (!result.score.complete) {
  console.error(result.score.problems);
  process.exit(1);
}
if (scripted && (result.score.band !== "Critical" || result.score.score !== 75)) {
  console.error(result.score.problems);
  process.exit(1);
}
