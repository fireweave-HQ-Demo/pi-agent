import { postReview } from "./comment.js";
import { analyzeUrl } from "./run.js";
import { runCursorE2E, runIdentityE2E } from "./e2e.js";

const usage = `pr-decision-agent

Usage:
  npm test
  npm run e2e:scripted
  npm run analyze -- https://github.com/owner/repo/pull/123
  npm run comment -- https://github.com/owner/repo/pull/123

  pi --extension ./extensions/index.ts
  /analyze-pr https://github.com/owner/repo/pull/123

Copy .env.example to .env and set CURSOR_API_KEY before a live run.
Set GITHUB_TOKEN the same way before posting a review comment.
A live PR also needs cursor-agent on PATH.
`;

const comment = process.argv.includes("--comment");
const scripted = process.argv.includes("--scripted");
const liveE2E = process.argv.includes("--e2e");
const urlArg = process.argv.find((arg) => arg.startsWith("https://github.com/"));
const help = process.argv.includes("--help") || process.argv.includes("-h");

if (help || (!scripted && !liveE2E && !urlArg)) {
  process.stdout.write(usage);
  process.exit(help || process.argv.length <= 2 ? 0 : 1);
}

if (urlArg && comment) {
  const posted = await postReview(urlArg);
  console.log(posted.url);
  process.exit(0);
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
