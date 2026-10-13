# pi-agent

Scores a GitHub pull request with [skill.md](./skill.md). The model answers frozen questions. The graph in `src/graph.ts` writes the number and the card. The model never sees a weight.

Works as a [Pi](https://pi.dev/) extension (`/analyze-pr`) and as a plain Node CLI.

## Requirements

- Node.js 22.19 or newer
- `git` and `curl`
- For a live pull request: a Cursor API key, and [`cursor-agent`](https://cursor.com/docs/cli/installation) on `PATH`
- `GITHUB_TOKEN` only for private repositories

## Clone and run

```bash
git clone https://github.com/fireweave-HQ-Demo/pi-agent.git
cd pi-agent
npm install
npm test
```

`npm test` checks out a local fixture and scores **75 Critical**. It does not need keys or a network model.

## Score a pull request

```bash
cp .env.example .env
```

Put `CURSOR_API_KEY` in `.env`. Put `GITHUB_TOKEN` in the same file to post the review. Do not commit `.env`.

Install the Cursor CLI so `cursor-agent` is on `PATH`, then:

```bash
npm run analyze -- https://github.com/owner/repo/pull/123
```

The card is `runs/<owner>__<repo>__<number>/out/card.md`.

Post the reviewer comment on that pull request. This updates the existing comment instead of adding another one:

```bash
npm run comment -- https://github.com/owner/repo/pull/123
```

## Pi session

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:pi-cursor-auth
pi --extension ./extensions/index.ts
```

Then:

```
/analyze-pr https://github.com/owner/repo/pull/123
```

Same card path as the CLI. See the [Pi quickstart](https://pi.dev/docs/latest/quickstart) if `pi` is not on `PATH`.

## Layout

| Path | Role |
| --- | --- |
| `skill.md` | Procedure. Phases 0–6. Frozen questions. |
| `src/machine.ts` | Walks the phases. |
| `src/graph.ts` | §5 arithmetic. Writes `card.md`. |
| `src/cursor.ts` | Live answers from `cursor-agent`. |
| `extensions/index.ts` | Pi `/analyze-pr` command. |
| `test/e2e.test.ts` | Identity fixture. No model. |

## Scripts

| Command | What it does |
| --- | --- |
| `npm test` | Build + identity e2e. No keys. |
| `npm run e2e:scripted` | Same fixture from the CLI. |
| `npm run analyze -- <url>` | Checkout a GitHub PR and write a card. |
