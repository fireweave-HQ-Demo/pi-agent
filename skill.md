---
name: pr-decision-analysis
description: Analyze a pull request by profiling the repo, enumerating the decisions the diff changed, interrogating each with a fixed question set, and producing a scored card. Use when given a diff, a PR, or changed files and asked to assess risk, review, or produce a score.
---

# PR Decision Analysis

Status: final test skill, 2026-10-08. Supersedes `scoring-skill.md`. The weights
in section 5 are placeholders until the golden set in `plan.md` §9 calibrates
them. Where this file and `scoring-skill.md` differ, this file wins.

## 1. What this does

Given a repo and a diff, produce a list of topics — decisions the diff changed —
and a score 0–100. The score is a lower bound: unknown never adds. The model never
picks a number, a bucket, or a severity. Every point comes from a fixed question
answered yes with a citation that verifies.

The procedure reads the repo before it reads the diff. What matters in one repo
does not matter the same way in another: the value an SDK gets back for a key is
the whole product of a flag provider and a detail in a game; the move a bot plays
is the whole product of a game and does not exist in a flag provider. The repo
profile (Phase 0) names what this repo exists to produce. Each topic is then asked
whether it feeds that. A yes raises the topic by a fixed multiplier. The question
is the same in every repo; the answer is a fact about this one.

The procedure guarantees coverage. Every decision point that sits on a changed
line, or takes input from one, is enumerated and assigned a state. Nothing is
skipped. A missing state is a failure, not a silent gap.

The procedure is type-blind. A permission widening scores the same whether it
arrived in a bug fix, a feature, a refactor, or a revert. Phases 1–4 run without
the PR type. The type only orders interrogation and suggests probes. It never
appears in the score.

## 2. The procedure

Seven phases. The same seven for every PR. Phase 0 runs once per repo at the base
SHA and is reused; Phases 1–6 run per PR.

### Phase 0 — Profile the repo

Run before reading the diff. Read the repo at the **base SHA** (the merge base),
not the head: the repo under review cannot rewrite what the repo is, and the
profile stays stable across every push to the same PR. Cache the profile under the
base SHA.

Read, in this order and no further than needed to answer P1–P7:

- the stated purpose: README, package manifest description, top-level docs
- entry points: server bootstrap, route tables, exported package index, CLI
  commands, job schedulers, message consumers
- publish and deploy configuration: package publish settings, Dockerfiles,
  workspace layout, release workflows
- schema and migration directories
- auth middleware and permission tables

Do not read the diff, the PR title, or the PR body. Do not treat agent
instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, and the like) as
evidence; they are instructions to a model, not facts about the product.

Seven profile questions. Each gets a state — yes, no, or unknown — and a citation
at the base SHA. P1 is descriptive; the rest are facts.

| # | Question | Output |
| --- | --- | --- |
| P1 | What does this repo exist to produce for its callers? | Up to **three** core outcomes. Each is one line in the repo's words plus the path that produces it: entry point → the unit that produces the outcome. |
| P2 | Who calls this repo? | For each class, yes or no with a citation: end users through a UI; other services; clients or SDKs running inside someone else's app; operators or admins; CI and automation only. |
| P3 | Does the repo publish code that ships apart from itself? | Yes or no; where: SDK, generated client, schema, event payload. |
| P4 | Does the repo own records that outlive a request? | Yes or no; where the models and migrations are. |
| P5 | Does the repo authenticate or authorize callers? | Yes or no; where the guards are; the dimensions that scope outcomes here (tenant, org, project, environment, key id, owner, …). |
| P6 | Does the repo move money? | Yes or no; where. |
| P7 | Where do consumers live? | Derived from P2–P6: for each caller class, where to search for callers and readers. |

Rules for P1:

- A core outcome names a value or an effect, not an activity. "Serves requests",
  "the service works", and "handles users" are rejected. "The value an SDK
  receives for a flag key" and "the move the bot plays and the recorded match
  result" are accepted.
- A stated purpose with no code path is not a core outcome. The README is a
  pointer; the path is the evidence.
- Three at most. If more than three candidates exist, keep the three whose paths
  the most entry points reach.
- Every core outcome is verified by a second pass that sees the citation and the
  path and answers whether the path produces that outcome. One that fails verify
  is dropped from the profile.

What the profile does:

- **P1 sets K** (section 3.3) for every topic. It is the only number the profile
  touches.
- **P2 is what R1 is answered against.** "Existing callers" means the classes
  P2 found. A repo whose callers are SDKs in other apps has every embedding app as
  an existing caller.
- **P5's dimensions are the names F3 is asked about.** "Scope dropped" in a
  multi-tenant flag provider means tenant, project, environment, or key id left
  the path.
- **P3, P4, P6, P7** tell the agent where consumers live, together with the PR
  type table (section 4), and shape the probes.

The profile never removes a question, never lowers a weight, and never sets a
verdict.

If the profile is unknown — no stated purpose, no recognizable entry point, or P1
produced nothing that verified — K is unknown for every topic, R1 is answered from
the code alone, and the card's Method line says "profile unknown". Scoring
proceeds on the standard weights.

Output:

```
profile (base a1b2c3d):
P1 core outcomes:
  1. the value an SDK receives for a flag key — `api/evaluate.ts:evaluate` → response → `packages/sdk/src/client.ts:getValue`
  2. the flag configuration an operator saves — `api/flags.ts:update` → `db/flags`
P2 callers: SDKs in third-party apps (yes, `packages/sdk/package.json` publishes);
  operators via UI (yes, `web/routes.ts`); other services (no); CI only (no)
P3 separately deployed: yes — `packages/sdk`, `packages/edge-worker`
P4 durable state: yes — `db/migrations`
P5 access: yes — `api/middleware/auth.ts`; dimensions: project, environment, key id
P6 money: no
P7 where to look: SDK readers in `packages/sdk/src`; routes in `api/routes.ts`;
  wire types in `packages/contracts`
```

### Phase 1 — Bound

For each hunk, find the enclosing unit: the smallest syntactic unit that contains
it — a function, method, class body, route handler, or module-level statement. If
a hunk spans two units, split it and treat each separately.

If the enclosing unit is not visible in the diff window, fetch it from the repo at
head SHA. Do not describe a hunk whose unit you cannot see. If the symbol index
cannot find the enclosing unit, the hunk becomes a topic with the module as its
unit and every question marked unknown. It is flagged on the card, never dropped.

Output: a finite list of `(unit, hunk)` pairs. One per hunk. No skipping.

### Phase 2 — Enumerate

For each unit, enumerate the decision points that sit on a changed line or take
input from one: a value the changed line computes, writes, returns, or passes on.
Do not enumerate the rest of the unit. A decision point is a place where a value
determines an outcome. Syntactically:

- **condition** — `if`, `switch`, `match`, ternary
- **return_value** — a return statement
- **predicate** — a filter, query, or guard
- **write** — an assignment to durable state, or a call with side effects
- **default** — a parameter default, fallback value, null coalescing
- **check** — a validation, assertion, or guard clause
- **call** — a call whose result or absence changes behavior
- **boundary** — where external input enters, or output leaves
- **error_handler** — a catch, a fallback, a retry, a failure branch

Inside that scope, enumerate every decision point. Do not filter here: the change
test (Phase 3) filters, and every state it gives is recorded, including no.

Stay inside that scope. Enumerating every decision point in a unit costs a change
test each and drifts between runs. A decision point reached only through unchanged
values is out of scope. A changed line removed outright still counts: the decision
points it fed are in scope.

Output: a finite list of decision points per unit.

### Phase 3 — Change test

Run this phase without the PR type and without the profile. The profile is first
used in Phase 4, to find consumers; the type is first used in Phase 5. Neither
may influence whether a decision point counts as changed.

For each decision point, ask one question: did this diff change what it decides?

Three answers, and only three:

- **no** — before and after are the same choice.
- **yes** — before and after differ, and the difference is stated.
- **ambiguous** — the diff touches the unit, and it is not clear whether this
  decision point changed.

Every decision point gets a state. A decision point with no state is a failure.

For yes and ambiguous, state:

- **before** — what the unit chose before, in one line
- **after** — what it chooses after, in one line
- **kind** — one of the nine kinds above
- **direction** — narrower, wider, mixed, or neither (a property of the
  before/after pair)

Direction is derivable from the pair, not a judgment.

- **narrower** — the pair only adds checks, narrows scope, or adds bounds.
- **wider** — the pair only removes or relaxes checks, scope, or bounds.
- **mixed** — the pair does both.
- **neither** — a value swapped for another, or new code with no before choice.

`role === 'admin'` to `role === 'admin' || role === 'moderator'` is wider by
inspection. An added check that rejects on failure is narrower. An added check
whose error branch continues is mixed, and F1 can be yes. A value swapped for an
equivalent value is neither. A new endpoint is neither: there was no choice
before to widen.

An ambiguous decision point is not resolved by guessing. A second pass sees the
before and after lines and confirms whether they differ. Resolved to yes and
verified, it scores like any other topic. Still ambiguous, it is interrogated but
cannot score, and it is listed as unresolved on the card.

### Phase 4 — Describe topics

A **topic** is a decision point whose change test returned yes or ambiguous.
Decision points that feed the same consumer are one topic, even across hunks. One
decision point read by two unrelated consumers is two topics.

For each topic, find the consumer: what reads the result of the changed choice. A
return that is immediately checked, a write that is immediately read, a value
passed to a call. If the consumer is visible in the unit, name it. If not, look
where the profile's P7 says consumers live. If still not found, mark it unknown.

Follow the consumer one step further: does its chain end at one of the profile's
core outcomes (P1)? Record the path if it does. This is the evidence K (section
3.3) will cite. It is recorded here because the consumer lookup is already in
hand; it is scored in Phase 5.

State the topic's description in one line, in the repo's own words. Not
"user-facing behavior" — "bot move depth now follows the stored difficulty."

### Phase 5 — Interrogate

Classify the PR type now (section 4) and, with the profile, use it to order the
questions and pick probes. Interrogation runs in two passes.

1. **Every topic:** C1–C5, R1–R2, and K. They are cheap, and they set the
   ranking.
2. **Rank.** Rank value = the highest base weight among the topic's verified yes
   consequence nodes × its K multiplier × its R1 reach multiplier (5.2–5.4). Sort
   by rank value, highest first; ties by `where`, ascending, so two runs rank the
   same way. A topic with rank value 0, or one a gate already zeroes (narrower,
   still ambiguous), takes no slot: it is cleared or unresolved.
3. **Top N topics:** F1–F11, their probes, and the containment evidence. N is a
   run parameter, default 6.

A topic outside the top N is not interrogated. It carries no points (unknown never
adds), and it is listed by name on the card's Coverage line as "not interrogated".

Every question asked gets a state:

- **yes** — with a citation to a changed line that supports it.
- **no** — with a reason.
- **unknown** — with the probe that failed and why.

Three states. No fourth. A question with no state is a missing state, and a topic
with a missing state fails.

Every yes is verified by a second pass that sees the cited line and the claim and
answers whether the line supports it. A yes that does not verify is dropped, not
downgraded. For K, the second pass sees the consumer citation, the recorded path,
and the profile's core outcome line, and answers whether the path reaches that
outcome.

**Probes.** A probe is how a question gets its evidence. It has four parts:

- **question** — about this topic, in the repo's vocabulary: "does `depthFor`
  bound depth at `nightmare`?"
- **action** — what was done to answer it at head SHA: read a file region, grep,
  or a symbol lookup (definition or references).
- **answer** — one line with a citation, or unknown with why.
- **resolves** — the fixed question it answers (a C node, R1, R2, K, a failure
  pattern, or a B check) and the state it sets.

```
probe: does `depthFor` bound depth at `nightmare`?
action: symbol lookup `depthFor` → read `difficulty.ts`
answer: yes, capped at `difficulty.ts:7`
resolves: F6 → no
```

For every top-N topic whose K is yes or unknown, at least one probe is about the
core path: "what on the path from `<consumer>` to `<core outcome>` reads this
value, and what does it do with it?" Its answer is where the "Look at" line comes
from when the change is on the thing the repo exists for.

Probes carry no points. A probe answer that would set a question to yes still
passes verify like any other yes. Probes become the "Look at" lines on the card
(section 12).

Unless the topic is narrower, each failure pattern is yes only if the change
itself meets that pattern's stated direction: removed, weakened, widened, dropped.
A topic's direction never answers a failure pattern on its own.

### Phase 6 — Score

Compute the score by the graph in section 5. The model does not choose the
arithmetic. It answers questions; the graph consumes the answers.

## 3. The fixed questions

C1–C5, R1–R2, and K are asked about every topic. F1–F11 are asked about every
topic in the top N (Phase 5), and B1–B3 once for the PR. Within that scope none is
optional, and none is added or removed by PR type or by profile.

### 3.1 Consequence — what does the outcome control?

| # | Question |
| --- | --- |
| C1 | Does the outcome decide whether a caller may proceed, who the caller is, or what the caller may do? |
| C2 | Does a secret flow through the outcome, or does input from outside the process reach something that interprets it (SQL, shell, path, template, deserializer, HTML)? |
| C3 | Does the outcome move money, or change a record that outlives the request and that another decision reads later? |
| C4 | Does the outcome cross to code that deploys separately: another service, an SDK inside someone else's app, a queue consumer, infrastructure? |
| C5 | Does the outcome change what a person sees, gets, or is scored or ranked on? |

Each yes cites the **consumer** of the outcome: the `if` that reads it, the write,
the response field, the call it is passed to.

A change to a type shared with code that deploys separately (a DTO, a schema, a
generated client, an event payload) is C4 yes unless every existing consumer
tolerates the new shape. Cite the consumers checked. The profile's P3 says where
they are.

### 3.2 Reach — who reaches the new outcome?

| # | Question |
| --- | --- |
| R1 | Which of the four reach states applies? **all** — every existing caller on the path hits the new outcome. **flag_or_cohort** — a flag, percentage rollout, or opt-in among callers who already hit the path gates it. **none** — no existing caller reaches the new outcome. **unknown** — cannot be traced. |
| R2 | Is the decision in code that more than one deployable uses? |

R1 is answered against the caller classes in the profile's P2. A **cohort** is a
subset gate among callers who already reach the path. "Not every user of the
product" is not a cohort. A back-office route gated by admin auth is reached by
admins, who are its existing callers; every one of them hits the changed
decision, so it is **all**, not flag_or_cohort. If the changed decision is the
guard itself, every caller that hits the route reaches it: **all**. R2 informs
the card's blast radius; it carries no weight in the graph.

### 3.3 Core path — does it feed what this repo exists for?

| # | Question |
| --- | --- |
| K | Does the outcome of this decision feed a core outcome named in the profile (P1)? Cite the path from the topic's consumer to that outcome. |

Three states:

- **yes** — the path is cited and verifies. Multiplier 1.5 (5.4).
- **no** — the consumer's chain ends somewhere other than a core outcome, with the
  reason. Multiplier 1.0.
- **unknown** — the path could not be traced, or the profile is unknown.
  Multiplier 1.0; listed as unresolved.

K is the one place the repo changes the arithmetic. It is a fact about where the
changed value goes, verified like every other yes. It is not a judgment that the
change is important. A topic can be C1 and K no (a permission check on a
back-office page in a storefront); a topic can be C5 and K yes (the move a bot
plays, in a game). The same two questions, answered from evidence, give the two
repos different numbers without a different table.

K cannot rescue a topic a gate has zeroed. Narrower is still zero. No existing
caller is still zero. Unknown K adds nothing.

### 3.4 Failure patterns — how does it fail?

Each is phrased with a direction. An added check, a narrowed scope, or a new bound
is a no. A hardening PR scores zero by construction.

| # | Pattern | Question |
| --- | --- | --- |
| F1 | Fails open | Does an error, timeout, missing value, or unknown case now continue as allowed, success, or done? |
| F2 | Default changed | Does the value used when nothing matches or nothing is provided change? |
| F3 | Scope dropped | Does a dimension that constrained the outcome leave: user, tenant, org, owner, environment, key id, version, or any dimension named in the profile's P5? |
| F4 | Widened | Does the set that passes grow: roles, hosts, fields, ports, permissions, accepted algorithms, origins? |
| F5 | Trusts outside input | Does a value from a client, provider, webhook, or message now decide something it did not? |
| F6 | Unbounded | Does an amount, depth, retry count, loop, size, or TTL lose its cap, or does cost grow with input? |
| F7 | Runs twice or out of order | Can the same event run the side effect again, or run before something it depended on? |
| F8 | Skew | Can two versions be live at once and disagree? |
| F9 | Leaks | Does a secret or a personal identifier reach a log, response, query string, client bundle, or committed file? |
| F10 | Rewrites history | Does the change rewrite a record's history — overwrite or delete a posted row, or run a write that is not idempotent and not guarded by its own marker? An additive grant (`get_or_create` plus `add`, an insert-only migration, appending to a set) is **no**. Whether the same event can run twice is F7's question, not this one. |
| F11 | Check moved | Does a guard start, stop, or reorder relative to the action it protects? |

Two patterns can both be yes on one topic when each is met on its own terms. They
are not two names for one thing: a missing value that now continues as success is
F1; the value it continues with, if it differs from what nothing-provided used to
produce, is F2. A dimension that is still applied but now comes from a default is
F2, not F3; F3 is the dimension leaving the path. F7 and F10 are also not two
names for one thing. A write that is unsafe to run twice is F7. A write that
overwrites or deletes a posted row, or runs without its own marker, is F10. An
additive grant is neither: it is safe to run twice and it does not rewrite
anything.

### 3.5 Containment

| # | Question |
| --- | --- |
| B1 | Is the change behind a flag that can be turned off without a deploy? |
| B2 | Is there observability that would show the change going wrong? |
| B3 | Is there a test that would catch the change going wrong? |

## 4. The PR type — order and probes

The type is read from the diff (file paths and hunk content), not the title or
description. A PR can be several types; use every matching row. The type is not
used in Phases 1–4. It never sets a default verdict, never skips a question, and
never touches the graph. It decides which questions to ask first, where to look
for consumers and callers, and which probes to write.

The "Consumers live in" column is generic. When the profile's P7 names a location
for this repo, P7 wins.

| Type | Signals in the diff | Start with | Consumers live in | Probe templates | Common false positives |
| --- | --- | --- | --- | --- | --- |
| Feature | New routes, handlers, jobs, components wired to a caller | R1, then K, then C1 | Route registration, ingress config, the caller that wires it in | "is `<route>` reachable from public ingress without `<guard>`?" "is `<input>` size bounded?" | New code with no existing caller treated as reached |
| Bug fix | A condition, value, or default in existing code now gives a different outcome | Direction, F2, F1 | Existing callers of the unit | "does `<old caller>` get the same `<value>` for `<input>`?" "what happens when `<value>` is null?" | A log or message text change treated as a decision |
| Refactor | Renames, moves, extract or inline, type changes | Change test on every guard and default; F11 | Old and new call sites | "does `<new>` call `<guard>` before `<action>` as `<old>` did?" "is the default of `<param>` the same?" | A rename read as a changed decision |
| Hardening | Added validation, narrowed scope, new bound, tightened CORS or IAM | Direction, then F1 on the new error branch | The action the check protects | "what does the new check do on error or timeout?" "is anything removed alongside the added check?" | Scoring the added check itself |
| Migration | Migration files, DDL, model fields, backfills | F10, F8 | Every reader of the changed column, not just the writer in the diff | "can `<migration>` run twice?" "does `<old reader>` handle `<field>` being null?" | A nullable column written only for new rows, with no existing reader |
| Dependency | Manifest version lines, lockfiles, vendored code | Change test on call sites in the diff; F8 | Call sites of the package in this repo | "does `<call>` still receive `<arg>` under the new version?" | Upstream changelog claims with no changed line here to cite (unknown) |
| Config | Env defaults, config files, IaC, IAM, CI workflows | R1, F2, F4 | The code that reads the key; the resource the policy governs | "what does `<service>` use when `<VAR>` is unset?" "does `<policy>` still restrict `<action>` to `<resource>`?" | A CI-only change with no deployed reader |
| API / contract | Request or response types, shared DTOs, schemas, generated clients, SDK code, event payloads | C4, K, F8 | Generated clients, SDK source, other services' readers (P3) | "does a client on the old format tolerate `<field>`?" "do generated clients ship in the same deploy?" | An optional field that no existing consumer reads |
| Revert | The diff mirrors an earlier commit | Change test; F8, F10 | Rows and clients created while the reverted code was live | "do rows written by `<reverted code>` still parse?" | Assuming a revert is safe because it restores old code |
| Performance | Caches, TTLs, batching, parallelism, locks, retries, limits | F6, F2, F3, F7 | Cache readers, retried operations | "does `<cache key>` include `<tenant>`?" "is `<op>` safe to retry?" "what does a miss or timeout return?" | A pure speed-up with the same outputs |
| Test | Test files, snapshots, fixtures | Change test; check no non-test code imports the file | CI only | "is `<fixture>` imported outside tests?" | A fixture shared with production code |
| Docs | Docs, comments | Change test; check no loader reads the file | None | "does anything load `<file>` at runtime?" | A YAML or JSON "doc" that is config |
| Chore | Formatting, lint, import order, build scripts | Change test on every non-whitespace token | Build output | "does `<lint fix>` change a comparison or a default?" | A lint fix that changes behavior (`==` to `===`) |

If the type is wrong — a "refactor" changed a choice — the procedure finds it
anyway, because Phase 3 never saw the type.

## 5. The scoring graph

The score is a posterior. It shifts as answers come in. The model sets states; the
graph computes.

Every number below is a placeholder to calibrate on the golden set. Every number
lives in this section and nowhere else. No number is read from the repo, the
profile, or the model.

### 5.1 Gating nodes

Some answers collapse the score, regardless of everything else.

- **Direction = narrower.** The topic scores zero. For wider, mixed, or neither,
  direction gates nothing; each failure pattern meets its own direction.
- **R1 = no existing caller, or unknown.** The reach multiplier is zero, so the
  whole topic scores zero (5.3). Unknown is listed as unresolved on the card.
- **Change test still ambiguous.** The topic does not score. It is listed as
  unresolved on the card.
- **No consequence node is yes.** The topic does not score.
- **Topic outside the top N.** Not interrogated; it carries no points (Phase 5).
- **Part A = 0.** Containment rungs do not add. A PR with nothing to contain
  scores zero.

K is not a gate. It multiplies a non-zero topic; it never turns a zero into
something else.

### 5.2 Base weights

Each consequence node has a base weight. Every yes-answered, verified consequence
node is a candidate base node. The topic score is computed once per candidate
(5.8) and the highest result wins; that candidate is the topic's base node.

| Node | Base |
| --- | --- |
| C1 access control | 30 |
| C2 secret or injection | 30 |
| C3 money or durable record | 20 |
| C4 cross-deployable | 15 |
| C5 user-visible | 8 |

These are the same in every repo. Section 6 says why.

### 5.3 Reach multiplier

| R1 | Multiplier |
| --- | --- |
| Existing callers reach it | 1.0 |
| Behind a flag or cohort | 0.5 |
| No existing caller | 0 |
| Unknown | 0 |

Reach is a fact about who hits the changed decision, not who hits the product.
The existing callers of a path are the callers who legitimately reach it today:
profile P2, plus the route's own upstream gate.

- A route reachable from public ingress with no guard before the changed
  decision: **all** (1.0).
- A back-office route reached only by admins: admins are the existing callers of
  that path, and every one of them hits the changed decision. **all** (1.0).
  Admin auth is not a cohort; it is the path's caller definition.
- A route with a flag, a percentage rollout, or an opt-in among callers who
  already hit the path: **flag_or_cohort** (0.5). The subset gate is narrower
  than the path itself.
- "Not every user of the product" is not a cohort. A cohort is a subset gate on
  callers of this path.
- If the changed decision is the guard itself, every caller that hits the route
  reaches it: **all**.
- A new route behind admin auth with no callers yet: **none**.

The multiplier applies to the whole topic, base and failure patterns together,
so an unreached topic earns nothing.

### 5.4 Core multiplier

| K | Multiplier |
| --- | --- |
| Feeds a core outcome (cited, verified) | 1.5 |
| Does not | 1.0 |
| Unknown | 1.0 |

Applies to the whole topic, base and failure patterns together, before reach. One
number, the same in every repo. The repo decides whether it applies, through P1
and the cited path; the repo does not decide its size.

Calibration guard: across the golden set, report the fraction of scoring topics
with K yes. If it is above one half, P1 is naming outcomes too broadly. Tighten
the P1 rules before touching the multiplier.

### 5.5 Hazard weights

| Pattern | Base |
| --- | --- |
| F1 fails open | 10 |
| F2 default changed | 5 |
| F3 scope dropped | 10 |
| F4 widened | 10 |
| F5 trusts outside input | 12 |
| F6 unbounded | 7 |
| F7 runs twice or out of order | 8 |
| F8 skew | 6 |
| F9 leaks | 12 |
| F10 rewrites history | 8 |
| F11 check moved | 8 |

### 5.6 Amplification

Some consequence nodes raise the weight of some failure patterns. This is the
conditional split: answering one question changes what another is worth.

| If this is the base node | Then this pattern gains |
| --- | --- |
| C1 access control | F1 +22, F4 +6, F11 +12 |
| C2 secret or injection | F5 +22, F9 +22 |
| C3 money or durable record | F7 +6, F10 +6 |
| C4 cross-deployable | F8 +6 |

Amplification applies only when the amplifying consequence node is the one that
set the base. If C1 set the base and C2 is also yes, C2's amplification does not
apply. The base node is chosen in 5.8, so two nodes with the same base weight
(C1 and C2) are never ambiguous.

`amplifiers[pattern]` is the set of consequence nodes whose row above names that
pattern: `amplifiers[F1] = {C1}`, `amplifiers[F5] = {C2}`, and so on.

### 5.7 Direction

Direction is a gate only. It never multiplies.

| Direction | Effect |
| --- | --- |
| Narrower | Topic scores 0 (gating) |
| Wider | None; each failure pattern meets its own direction |
| Mixed | None; each failure pattern meets its own direction |
| Neither | None; each failure pattern meets its own direction |

Widening already scores through F4. A multiplier for wider would count it twice.

### 5.8 Topic score

```
def score_with(base_node):
    severity = base_weight[base_node]
    for each failure pattern p:
        # p counts only if it is answered yes AND the yes verified AND the change
        # meets p's own stated direction (removed, weakened, widened, dropped).
        # The narrower gate below is the only per-topic direction check.
        if answer[p] == yes and verified[p] and meets_direction[p]:
            weight = hazard_weight[p]
            if base_node in amplifiers[p]:          # property of the base node
                weight += amplification[base_node][p]
            severity += weight
    severity *= core_multiplier[K]                  # 1.5 / 1.0 / 1.0
    severity *= reach_multiplier[R1]                # 1.0 / 0.5 / 0 / 0
    return min(severity, 100)

if topic not in top_n: topic_score = 0                    # not interrogated
elif change_test is not yes-and-verified: topic_score = 0   # unresolved
elif direction == narrower: topic_score = 0
elif no consequence node is yes and verified: topic_score = 0
else:
    candidates = consequence nodes answered yes and verified
    topic_score = max(score_with(n) for n in candidates)
    base_node = the candidate that gave topic_score
                # equal results: the higher base weight, then the lower C number
```

### 5.9 PR score

```
topics_sorted = sort by topic_score desc
part_a = topics_sorted[0].topic_score            # 0 if no topics
for each remaining topic:
    part_a += topic.topic_score * 0.5             # half-weight rule
part_a = min(part_a, 70)
pr_score = part_a
# containment rung (Part B)
if part_a > 0:
    rung = 1 if part_a < 20 else 2 if part_a < 45 else 3 if part_a < 70 else 4
    for each B_i answered no:
        pr_score += rung
pr_score = clamp(pr_score, 0, 100)
```

Part B is the rung times the number of containment noes, so it runs 0–12.

B1, B2, and B3 are answered once for the PR, about the lines that earned points.
B_i is yes only if it holds for every scoring topic, no if any scoring topic
verifiably lacks it, and unknown otherwise. Unknown adds nothing.

### 5.10 Bands

- 0–19 Low
- 20–44 Medium
- 45–69 High
- 70–100 Critical

## 6. Why one weight table serves every repo

The same parameter does carry a different meaning in different repos. C5
(user-visible) is the product in a game and a detail in a backend library. C4
(cross-deployable) is the product in a flag provider and a side concern in a
monolith. C3 (durable record) is the product in a ledger. C1 (access) is the
product in an identity provider. A single table of base weights, read literally,
says these are all worth the same everywhere. They are not.

The fix is not a weight table per repo, and not a weight table per repo shape.

- A table per repo is a bank. Someone writes it before the first PR, and the
  product has to work on a repo it has never seen.
- A table per shape makes "what shape is this repo" the scorer, and that is a
  judgment the model would make by pattern-matching on names, not evidence.
- A weight the model adjusts is the model picking a number. That rule is the one
  that produced a defensible score on every PR so far and an indefensible 71 when
  it was broken.

So the weights are a **floor**, the same in every repo, and the repo **raises**
what is on its core path through K. Three properties follow, and all three are
deliberate:

1. **The repo raises; it never lowers.** A lowering is a guess that a harm does
   not apply here. The diff is the evidence of what applies. A payment call added
   to a repo that never moved money is not less serious because the profile said
   "no money"; it is a new surface, and it scores on the floor like anywhere else.
2. **The raise is a fact, not a judgment.** K is yes when a cited path from the
   consumer reaches a cited core outcome, and a second pass agrees. "This feels
   central" is not a state. "The value flows from `evaluate` into the response the
   SDK reads, and the SDK's return is P1 outcome 1" is.
3. **The raise is one fixed number.** 1.5 is a placeholder like every other
   number in section 5, and it is calibrated against the golden set, not against
   any single repo. If the golden set says core-path topics in flag providers need
   more than 1.5 and core-path topics in games need less, that is a finding about
   the base weights or about P1's rules, and it goes into section 5 for every repo
   at once.

What the model is asked to think about, per repo, is therefore exactly two
things: what does this repo exist to produce (P1), and does this changed value
reach it (K). Both are answered by reading code and citing it. Neither is a
number.

## 7. Completion criteria

A run is complete when:

1. A profile exists at the base SHA with P1–P7 each in a state, or the profile is
   marked unknown with the reason.
2. Every hunk has an enclosing unit, or is flagged unenclosed.
3. Every decision point on or fed by a changed line has a change-test state.
4. Every topic has C1–C5, R1–R2, and K in a state (yes / no / unknown).
5. Every top-N topic has F1–F11 in a state, and B1–B3 have a state whenever a
   topic earned points.
6. Every topic outside the top N is listed by name as not interrogated.
7. Every yes has a citation that verifies, including every P1 core outcome and
   every K yes.
8. Every topic has a direction (narrower, wider, mixed, neither), a kind, and a
   description.

A run that fails any of these is incomplete, and the harness rejects it. The card
(section 12) states the counts: decisions found, topics interrogated, topics not
interrogated, topics on the core path, topics unresolved, questions unknown,
decisions flagged unenclosed.

Stability across runs is measured on two sets: the `(where, kind)` set of
decisions, and the K state per topic. Both are compared across three runs of the
same PR (`plan.md` §9). A profile that drifts shows up as K drift.

## 8. Worked examples

Each example names the profile it runs under, because the same diff scores
differently under a different profile, and the examples should show where.

### 8.1 Refactor — no changed decision

Profile: any.

A PR renames a function and moves a conditional into a helper.

Phase 1: two hunks, same unit.
Phase 2: three decision points — a condition, a return, a call.
Phase 3: all three come back no.
Phase 4: no topics.
Phase 5: nothing to interrogate.
Phase 6: Part A 0, so no rungs. Score 0, Low.

Card: "No changed decisions found. This PR preserves behavior."

### 8.2 Feature with no reach

Profile: a SaaS back office. P1: "the tenant's records an operator edits".
P2: operators via UI.

A PR adds a new admin endpoint behind a flag, with no callers.

Phase 1: one hunk, new route handler.
Phase 2: three decision points — a return, a check, a call.
Phase 3: all three yes. Direction = neither (new code; no before choice to widen).
Phase 4: one topic (all three feed the same response). Consumer unknown.
Phase 5: C1 yes. K yes (the handler edits tenant records, P1). R1 no: no existing
caller reaches the handler at all, which is narrower than the flag → no existing
caller. All others no or unknown.

```
probe: does any existing route, client, or job call the new admin handler?
action: grep the route path and the handler symbol at head SHA
answer: no reference outside its own registration behind `admin-v2`
resolves: R1 → no existing caller
```
Phase 6:
  base = 30 (C1)
  no failure patterns yes → severity = 30
  K = 1.5 → 45
  reach = 0 → 45 × 0 = 0
  topic_score = 0
  Part A = 0. Rungs do not add when Part A is 0.
  PR score = 0. Low.

K did not rescue the topic. A core-path change nobody can reach is still nothing
to score.

Card: "New admin route on the core path, behind flag `admin-v2`, no existing
callers. No reach. Re-score when a caller is wired in."

### 8.3 Hardening

Profile: any.

A PR adds a length check to an input before it reaches a query.

Phase 1: one hunk, inside a validator.
Phase 2: two decision points — a condition, a return.
Phase 3: both yes. Direction = narrower (only adds a check; failure rejects).
Phase 4: one topic.
Phase 5: C2 yes. F5 no (input is checked, not trusted). F1 no (the new branch
rejects). All failure patterns no.

```
probe: does the length check reject before the query runs?
action: read the validator and the call that follows it
answer: yes, it returns an error before the query call
resolves: direction → narrower; F1 → no
```
Phase 6: direction = narrower gates the topic score to 0. Part A 0, so no rungs.
PR score 0, Low.

Card: "Added length check. Direction is narrower; scores zero by construction."

Had the new check's error branch continued to the query, the pair would be mixed,
and F1 would be asked on its own direction.

### 8.4 Bug fix that widens — and the same diff in another repo

Profile A: a storefront. P1: "the order a shopper places and pays for" (checkout
path); "the catalog a shopper browses". P2: end users via UI; operators via back
office. P5: yes, `requireRole`; dimensions: shop, customer.

A PR fixes a permissions check by changing `role === 'admin'` to
`role === 'admin' || role === 'moderator'` in a back-office guard.

Phase 1: one hunk, inside a guard.
Phase 2: one decision point — a condition.
Phase 3: yes. Direction = wider.
Phase 4: one topic. Consumer = the downstream handler it guards, which acts on
other customers' accounts.
Phase 5: C1 yes. R1 yes (every back-office caller hits it). K no: the guarded
handler edits customer accounts from the back office; neither P1 outcome
(checkout, catalog) is on that chain. F4 yes (the set of roles that passes grows).
B1 no, B2 unknown, B3 no.

```
probe: what does the call behind this guard do?
action: symbol lookup of the guarded handler
answer: it acts on other users' accounts, cited at the handler
resolves: C1 → yes

probe: does the handler's chain reach checkout or the catalog?
action: references of the handler's writes at head SHA
answer: no; the account rows it edits are read by the account page only
resolves: K → no

probe: does any later check still stop a moderator?
action: read the handler body after the guard
answer: no further role check
resolves: F4 → yes (stands)
```
Phase 6:
  base = 30 (C1)
  F4 yes: 10 + 6 (C1 amplifies F4) = 16
  severity = 30 + 16 = 46
  K = 1.0 → 46
  reach = 1.0 → 46
  topic_score = 46
  Part A = 46. Rung from Part A 46 → 3.
  B1 no, B2 unknown, B3 no → 2 × 3 = 6.
  PR score = 46 + 6 = 52. High.

Card: "Permission check widened from admin to admin+moderator. C1 access control,
F4 widened. Verify the moderator role is intended."

**Profile B: the same diff in an identity provider.** P1: "whether a caller is
allowed to act on an account". The guard's handler is on that path. Every answer
above is identical except K, which is yes with the path cited:

  severity = 46
  K = 1.5 → 69
  reach = 1.0 → 69
  Part A = 69. Rung from Part A 69 → 3.
  B1 no, B2 unknown, B3 no → 2 × 3 = 6.
  PR score = 69 + 6 = 75. Critical.

Same diff, same C1, same F4, same weights. One fact about the repo moved it a
band. That is the intended behavior, and the cited path is what a reviewer
disputes if they disagree.

### 8.5 Migration not re-runnable

Profile: a commerce platform. P1: "the order a shopper places"; "the inventory a
merchant sees". P4: yes.

A PR backfills a column with an `UPDATE` that has no `WHERE` on the migration's
own marker.

Phase 1: one hunk, a migration script.
Phase 2: two decision points — a write, a condition (the absent WHERE).
Phase 3: both yes. Direction = wider (more rows written).
Phase 4: one topic (both feed the same rows).
Phase 5: C3 yes (durable record another decision reads). R1 yes. K no: the only
reader of the column is a nightly reporting job, and neither P1 outcome reads the
report. F10 yes (not re-runnable). B1 no, B2 no, B3 no.

```
probe: does any decision read the backfilled column later?
action: grep the column name at head SHA
answer: yes, a condition in the nightly report reads it, cited at that line
resolves: C3 → yes

probe: does the report feed order placement or merchant inventory?
action: references of the report's output
answer: no; it writes a CSV for finance
resolves: K → no

probe: does the migration skip rows it already backfilled?
action: read the migration's UPDATE
answer: no, there is no WHERE on the migration marker
resolves: F10 → yes
```
Phase 6:
  base = 20 (C3)
  F10 yes: 8 + 6 (C3 amplifies F10) = 14
  severity = 20 + 14 = 34
  K = 1.0 → 34
  reach = 1.0 → 34
  topic_score = 34
  Part A = 34. Rung from Part A 34 → 2.
  B1 no, B2 no, B3 no → 3 × 2 = 6.
  PR score = 34 + 6 = 40. Medium.

Card: "Backfill has no re-run guard. Rewrites history. Add an idempotency marker
or a `WHERE` on the migration marker."

### 8.6 Severe — injection through a new public endpoint

Profile: a customer portal. P1: "the account record a customer views and edits".
P2: end users via UI, public ingress.

A PR adds a public endpoint that passes a user-supplied `id` into a SQL query with
no parameterization, behind no flag, with no test. The query reads the account
table.

Phase 1: one hunk, a route handler.
Phase 2: three decision points — a boundary (input), a predicate (query), a return.
Phase 3: all yes. Direction = neither (new endpoint; no before choice).
Phase 4: one topic (all three feed the query). Consumer = the query result, which
is the account record returned to the caller.
Phase 5: C2 yes. R1 yes: public ingress is an existing class of caller (P2), and
no guard sits between it and the query (narrowest guard: none). K yes: the query
result is the account record, P1. F5 yes (a client value now decides the query,
where nothing did before). F9 no. B1 no, B2 no, B3 no.

```
probe: is `id` passed to the query as a bound parameter?
action: read the handler's query line
answer: no, `id` is concatenated into the SQL string on that line
resolves: C2 → yes; F5 → yes

probe: what runs between public ingress and this handler?
action: read the route registration and its middleware list
answer: no auth or validation middleware on the route
resolves: R1 → existing callers (1.0)

probe: what does the query return, and where does it go?
action: read the query and the handler's response
answer: the account row, serialized into the response body
resolves: K → yes (P1 outcome 1)
```
Phase 6:
  base = 30 (C2)
  F5 yes: 12 + 22 (C2 amplifies F5) = 34
  severity = 30 + 34 = 64
  K = 1.5 → 96
  reach = 1.0 → 96
  topic_score = 96
  Part A = min(96, 70) = 70. Rung from Part A 70 → 4.
  B1 no, B2 no, B3 no → 3 × 4 = 12.
  PR score = 70 + 12 = 82. Critical.

Without K (a repo where the account table is incidental): 64, Part A 64, rung 3,
+9 = 73. Critical either way; the cap on Part A is what K ran into.

Had the same route sat behind admin auth, admins would be the existing callers of
that path and every one of them would hit the handler: R1 **all** (1.0). The
score would not halve. A flag or percentage among those admins would be
flag_or_cohort (0.5).

Card: "Public endpoint passes user `id` into SQL with no parameterization. C2
injection, F5 trusts outside input, on the core path. Parameterize before merge."

### 8.7 Feature behind a flag plus behavior change — arcade #21

Profile: a game. P1: "the match a player plays against the bot: the bot's moves
and the recorded result" — `games.ts` move search → match state. P2: end users
via web UI. P4: yes (`match-repo.ts`). P3, P5, P6: no.

A PR lets a player pick a bot difficulty. The picker is behind `game-difficulty`;
the server path is not.

Phase 1: five hunks, five units: `games.ts:209`, `router.ts:204`,
`match-repo.ts:41`, `App.tsx:236`, `shared/index.ts:27`.
Phase 2–3, without the type or the profile:

| Where | Before | After | Change | Direction |
| --- | --- | --- | --- | --- |
| `games.ts:209` | bot move searched at one fixed depth | depth follows `match.difficulty` | yes | neither |
| `router.ts:204` | request body ignored | `difficulty` parsed; unknown value → 400 | yes | narrower (the check); the parsed value feeds `games.ts:209` |
| `match-repo.ts:41` | no difficulty column | nullable column written for new rows | yes | neither |
| `App.tsx:236` | no picker | picker behind `game-difficulty` | yes | neither |
| `shared/index.ts:27` | `MatchDto` without `difficulty` | optional field added | yes | neither |

Phase 4: the parsed value at `router.ts:204` and the column at `match-repo.ts:41`
feed the same consumer as `games.ts:209` (the bot's search depth), so they join
that topic. The 400 check stays its own topic. Topics: depth, 400 check, picker,
DTO field.

Phase 5: type read from the diff is Feature (picker, new field) and Bug fix /
behavior change (depth). Order: R1 first, then K, then direction, F2, F6.

- Depth: C5 yes (the move a person plays against). R1 yes (every new match on the
  unflagged server path). K yes: the depth feeds the bot's move, P1. F6 no:
  `depthFor` caps at `nightmare`, `difficulty.ts:7`. F2 no: null maps to the
  previous depth. F5 no: the client chooses from a closed set the product offers,
  and `router.ts:204` rejects anything else. Others no.

  ```
  probe: does `depthFor` bound depth at `nightmare`?
  action: symbol lookup `depthFor` → read `difficulty.ts`
  answer: yes, capped at `difficulty.ts:7`
  resolves: F6 → no

  probe: what depth does a match with a null difficulty get?
  action: read `depthFor`
  answer: the previous fixed depth
  resolves: F2 → no

  probe: what on the path from the search depth to the bot's move reads it?
  action: read `games.ts` from the search call to the move it returns
  answer: the depth is the search bound; the move returned is the one the player sees
  resolves: K → yes (P1 outcome 1)
  ```
- 400 check: narrower → 0.
- Picker: C5 yes (what a flagged player sees). R1 behind flag → 0.5. K yes: the
  chosen level is stored on the match and feeds the depth above. F all no.
- DTO field: C4 no. The field is optional, and every existing consumer of
  `MatchDto` and its wire format still parses a match with or without it. No other
  consequence node is yes → 0.

  ```
  probe: does every existing reader of `MatchDto` parse a match with the new field?
  action: symbol lookup: references of `MatchDto` from `shared/index.ts:27`
  answer: yes; the field is optional and no reader requires or rejects it
  resolves: C4 → no
  ```
- Containment, about the scoring lines: B1 no (the depth path is not behind the
  flag), B2 unknown, B3 no.

Phase 6:
  depth: base = 8 (C5); severity = 8; K 1.5 → 12; reach 1.0 → 12
  picker: base = 8 (C5); severity = 8; K 1.5 → 12; reach 0.5 → 6
  Part A = 12 + 6 × 0.5 = 15. Rung from Part A 15 → 1.
  B1 no, B2 unknown, B3 no → 2 × 1 = 2.
  PR score = 15 + 2 = 17. Low.

Card: "Bot move depth now follows the stored difficulty — on the core path.
Picker behind `game-difficulty`."

`scoring-skill.md` scored this PR 12 without K. In a game, the bot's move is the
product; the profile says so, and the topic that changes it is raised. It stays
Low because every failure pattern is a cited no.

### 8.8 Flag provider — a relaxed check on the core path

Profile: a flag provider. P1: "the value an SDK receives for a flag key" —
`api/evaluate.ts:evaluate` → response → `packages/sdk/src/client.ts:getValue`;
"the flag configuration an operator saves". P2: SDKs in third-party apps;
operators via UI. P3: yes (`packages/sdk`). P5: yes; dimensions: project,
environment, key id.

A PR changes `evaluate()` so a request that names no environment resolves against
the project's default environment instead of returning an error.

Phase 1: one hunk, unit `evaluate`.
Phase 2: three decision points — the missing-environment condition, the error
return, the lookup call that receives the environment.
Phase 3: all three yes. Before: no environment → reject. After: no environment →
default environment → lookup proceeds. Direction = wider (a check relaxed).
Phase 4: all three feed the same consumer, the evaluation response. One topic:
"an evaluation that names no environment now resolves against the default
environment instead of failing."
Phase 5: type is Bug fix / behavior change. Order: direction, F2, F1, then C4, K.

- C4 yes: the response crosses to the SDK in someone else's app (P3), cited at the
  SDK's response reader. C1 no. C2 no. C3 no. C5 unknown: what the embedding
  app's end user sees is outside this repo.
- R1: existing callers that omit the environment exist — the SDK sends it only
  when configured, and a misconfigured SDK is an existing class of caller (P2);
  before this PR they received errors. 1.0.
- K yes: the response is P1 outcome 1, path cited from `evaluate` to `getValue`.
- F1 yes: a missing value now continues as success. F2 yes: the value used when
  nothing is provided changed, from an error to the default environment. F3 no:
  the environment dimension is still applied to the lookup; its source changed,
  which F2 already counts. F8 no: no wire format changed. Others no.
- B1 no (not behind a flag). B2 yes: evaluations are counted per environment, and
  a rise in default-environment evaluations is visible, cited at the metric. B3
  no: no test covers a request without an environment.

```
probe: what does an SDK do with the response when its configuration omits the environment?
action: read `packages/sdk/src/client.ts:getValue` and its config defaults
answer: it returns the value to the app; the environment is sent only if configured
resolves: C4 → yes; R1 → existing callers; K → yes (P1 outcome 1)

probe: is the environment dimension still applied to the lookup?
action: read the lookup call after the change
answer: yes, with the default environment's id
resolves: F3 → no; F2 → yes

probe: what did a request without an environment receive before?
action: read the removed branch
answer: an error response; the lookup did not run
resolves: F1 → yes
```
Phase 6:
  base = 15 (C4)
  F1 yes: 10. F2 yes: 5. No amplification (C4 amplifies F8 only).
  severity = 15 + 10 + 5 = 30
  K = 1.5 → 45
  reach = 1.0 → 45
  topic_score = 45
  Part A = 45. Rung from Part A 45 → 3.
  B1 no, B3 no → 2 × 3 = 6.
  PR score = 45 + 6 = 51. High.

**The same shape of change in a monolith**, where the API has one generated client
and P1 is something else: C4 yes, K no. Severity 30, Part A 30, rung 2, two noes
→ +4. 34, Medium.

C4's weight is 15 in both repos. What differs is a cited fact: in the flag
provider, the response is the thing the repo exists to produce.

Card: "Evaluations with no environment now resolve against the default
environment instead of failing — on the core path. C4, F1 fails open, F2 default
changed. Decide whether misconfigured SDKs should receive values at all."

## 9. What the model is free to do and what it is not

| Free | Fixed |
| --- | --- |
| How to describe a core outcome, in the repo's words, with a path | The seven profile questions and the three-outcome cap |
| How to describe a topic in one line | The nine kinds |
| Which consumer to cite, and the path from it to a core outcome | The five consequence questions |
| Which probes to write for evidence | The two reach questions and the core-path question |
| The order of interrogation, suggested by the PR type and the profile | The eleven failure-pattern questions |
| | The three containment checks |
| | The scoring graph: weights, multipliers, caps, bands |
| | Verify on every yes; direction rule; unknown never adds |
| | The completion criteria |

## 10. What this is not

- Not a per-repo bank. Nothing is authored per repo. The profile is read from the
  repo by the same seven questions every time.
- Not a per-type bank. The type sets an interrogation order and suggests probes,
  not a question set and not a verdict.
- Not a per-repo weight table. One table, one multiplier, every repo. The repo
  raises what is on its core path by a fixed number; it never lowers anything,
  and it never sets a number.
- Not free-form risk assessment. The model never writes a question that carries a
  point and never writes a number.
- Not the old arithmetic. The graph in section 5 replaces the class table in
  `plan.md`, and `plan.md` records the unfreeze. The half-weight rule, the Part A
  cap, and the bands are kept. The numbers are placeholders to calibrate on the
  golden set.

## 11. Reference card

When in doubt:

1. **Profile first, diff second.** The repo says what it exists to produce; the
   diff says what changed. K joins them. Read the profile at the base SHA, before
   the diff, and never from the PR's own description.
2. **Enumerate, don't generate.** The topics come from the changed lines, not from
   the model's judgment about what matters.
3. **Three states, no fourth.** No / yes / ambiguous for the change test. No /
   yes / unknown for questions. Missing is failure.
4. **Answer every question in scope.** C, R, and K on every topic; F on the top N.
   A missing state is incomplete. Outside the top N, no points.
5. **Direction gates.** Purely narrower scores zero. Otherwise each failure
   pattern must meet its own direction.
6. **Reach gates.** The narrowest guard on the path decides. No existing caller
   or unknown reach scores zero. A flag or cohort halves.
7. **The repo raises, never lowers.** K is yes only with a cited path to a cited
   core outcome. K cannot rescue a zero. Unknown K is 1.0.
8. **Unknown never adds.** Report it, don't guess it. Ambiguous never scores.
9. **Type orders, never filters.** It is not used in Phases 1–4 and never
   touches the score.
10. **The graph computes.** The model sets states. The weights are fixed. The
    conditionals are fixed. The posterior falls out.

## 12. The card

The card is what a reviewer reads. It has seven sections, in this order, always
present. An empty section says "none". The one-line "Card:" in each worked example
is its Verdict line.

1. **Verdict** — score, band, and the top topic's one-line description.
2. **What earned points** — each scoring topic: description, where, the base node
   and its consumer, each failure pattern that counted with its citation, core
   path (K state and the cited path), reach, topic score, and full or half
   weight. Under each, the probes that matter most as "Look at" lines.
3. **Cleared** — changed decision points and topics that do not score, each with
   its reason: narrower, no consequence node yes, no existing caller.
4. **Containment** — B1, B2, B3 with state and citation, the rung, and Part B.
5. **Unresolved** — ambiguous change tests, unknown reach, unknown K, and every
   question answered unknown, each with the probe that failed. This is where the
   lower bound may be low.
6. **Coverage** — hunks, units, decision points found, topics, topics
   interrogated, N, topics on the core path, topics unresolved, questions
   unknown, hunks flagged unenclosed. Every topic outside the top N is listed
   here by description and `where` as "not interrogated".
7. **Method** — skill name, graph date and that its weights are placeholders, the
   profile (base SHA, core outcomes named, caller classes, or "profile unknown"),
   the PR types read from the diff and the order they set, verify on every yes,
   and Part A + Part B.

Full card for 8.4 under profile B (file and symbol names illustrative):

```
<!-- score-ai -->
Verdict
  75 — Critical. Permission check widened from admin to admin+moderator, on the
  path that decides who may act on an account.

What earned points
  1. Role check now passes moderator as well as admin — `guard.ts:12`, `requireRole`
     Base: C1 access control; consumer: the handler it guards, `guard.ts:15`
     F4 widened: yes, `guard.ts:12` (moderator added to the passing set)
     Core path: yes — `guard.ts:15` → `accounts.ts:act` → P1 outcome 1 (×1.5)
     Reach: every existing caller (1.0). Topic score 69, full weight.
     Look at: does every handler behind `requireRole` intend moderators to pass?
     Look at: `accounts.ts:act` — which account operations does a moderator now reach?

Cleared
  none (one decision point, one topic)

Containment
  B1 flag: no, `guard.ts:12` is not behind a flag
  B2 observability: unknown
  B3 tests: no, no test calls `requireRole` with a moderator
  Rung 3 (Part A 69). Two noes → Part B 6.

Unresolved
  B2: grep for a log or metric on `requireRole` found none in the changed unit;
  absence not confirmed.

Coverage
  1 hunk, 1 unit, 1 decision point, 1 topic, 1 interrogated (N = 6),
  1 on the core path, 0 topics unresolved, 1 question unknown, 0 unenclosed.
  Not interrogated: none.

Method
  pr-decision-analysis, graph §5 (2026-10-08, placeholder weights).
  Profile at base 9f8e7d6: core outcomes — (1) whether a caller is allowed to act
  on an account; callers — end users via UI, other services.
  Type from the diff: Bug fix; order: direction, F2, F1. Verify on every yes.
  Part A 69 + Part B 6 = 75.
```
