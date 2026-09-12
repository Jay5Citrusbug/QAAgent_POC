# ai-qa-poc

A small proof of concept for AI-driven functional smoke testing.

```text
Requirement
   ↓
Thinking Agent      analysis, gaps, risks, draft missions
   ↓
HUMAN — Gate 1      approve, edit, or reject
   ↓
Test Mission JSON   the contract between the two agents
   ↓
Execution Agent     Playwright → Chromium → STAGE
   ↓
Result + evidence   PASS / FAIL / BLOCKED / INCONCLUSIVE
   ↓
Classifier          proposes why it failed
   ↓
HUMAN — Gate 2      confirmed defect / accepted failure / retry
```

The point of the POC is to prove one thing: **an approved, natural-language
mission can drive a real browser and produce a result a human can trust** —
without anyone hand-writing a Playwright test first.

See [../VISION.md](../VISION.md) for the reasoning behind the architecture.

---

## 1. Prerequisites

* Node.js 20 or newer
* Network access to your STAGE environment
* An Admin account on STAGE that is safe to create test data with

## 2. Installation

```bash
cd ai-qa-poc
npm install
```

## 3. Playwright setup

```bash
npm run browsers          # installs Chromium only
```

POC-1 is Chromium-only on purpose. More browsers multiply run time and evidence
volume without telling you anything new about whether the *approach* works.

## 4. Configuration

```bash
cp .env.example .env
```

Set `BASE_URL` to your STAGE host. `knowledge/application-context.yaml` ships
with a placeholder (`stage.example.com`) and `BASE_URL` overrides it, so a real
internal hostname never has to be committed.

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | from application-context.yaml | STAGE host |
| `HEADED` | `true` | Watch it work. `false` for headless. |
| `SLOW_MO` | `0` | Milliseconds per action — useful when demoing |
| `BUILD` | `unknown` | Build/commit under test, shown in the report |

### Authentication

The agent **never logs in through the UI on a per-mission basis**. It loads a
seeded Playwright session instead. Seed one once:

```bash
npx playwright open --save-storage=.auth/admin.json <your STAGE URL>
# log in as Admin in the window that opens, then close it
```

`.auth/` and `.env` are gitignored. No credential belongs in a mission file, and
nothing in this repo reads one.

A mission whose role has no seeded session is reported `BLOCKED` /
`ENVIRONMENT_FAILURE` — never as a product defect.

## 5. Where requirements go

```text
input/feature/requirement.md      the requirement under test
input/feature/documentation.md    supporting product docs
input/feature/existing-tests.md   what is already covered
```

Keep these committed. The Thinking Agent runs in a chat window, so its reasoning
is not durable — this is what `requirement_ref` points at, and it is what makes
a result traceable back to a requirement rather than just to a test id.

## 6. Creating missions — the Thinking Agent

### First: look at the application

```bash
npm run inspect -- --feature ecommerce
```

Captures the real page into `knowledge/observed/<feature>.md` — what controls
exist and what they are called, which names are ambiguous, and **what is
absent**.

This step exists because it was skipped. Writing missions from requirement prose
alone produced assertions against UI that does not exist: a cart count badge,
an `aria-pressed` attribute the page never uses. A tester opens the app before
writing tests; so should the agent. Re-run it whenever the application changes —
a stale capture is worse than none, because it gets believed.

### Then: generate

> **Cost note.** The `web/` UI calls the Anthropic API and is billed per token
> **on top of** any Claude subscription you already have. If you hold a Claude
> seat, use it instead — see [docs/NO-EXTRA-COST.md](docs/NO-EXTRA-COST.md).
> Either route produces identical artifacts; execution itself has never used a
> model and costs nothing per run.


```bash
npm run think              # assemble the prompt pack
npm run think -- --copy    # ...and copy it to the clipboard
```

This writes `thinking/prompts/prompt-<date>.md` containing everything the model
needs in one paste: the system prompt, the application context, the requirement
and documentation, **the full mission JSON Schema**, a **worked example**
(SM-001), and the analysis template.

The schema and example are inlined deliberately — a chat model cannot open a
file path, and without them it returns plausible JSON that fails
`npm run validate`.

**Model: `claude-opus-5` at effort `high`**, set in
[agent/thinking/config.yaml](agent/thinking/config.yaml). Requirement analysis is
the task of finding what *is not stated*, which is where reasoning depth
actually pays. Roughly **$0.20–0.30 per feature analysis** — model cost is not
the variable that matters here; review time is. Override for one run with
`THINKING_MODEL` / `THINKING_EFFORT`.

Then save what comes back, in two places:

| Output | Goes to | Committed? |
|---|---|---|
| The analysis (gaps, risks, scenarios) | `thinking/analysis/<feature>-<date>.md` | **Yes** |
| Each mission | `missions/draft/<TEST_ID>.json` | Yes |

The analysis is committed, not left in the chat. The gaps it finds are usually
worth more than the missions — they are questions for the requirement author
that nobody else had time to ask, and a closed tab is the cheapest way to lose
them. Structure is in
[agent/thinking/ANALYSIS_TEMPLATE.md](agent/thinking/ANALYSIS_TEMPLATE.md).

Then check the missions:

```bash
npm run validate              # all missions
npm run validate -- SM-001    # one
```

Schema errors are fatal. Lint warnings are not — they are the things worth
noticing before you approve, such as a creation test with no `{run_id}` in its
naming pattern, or a `test_objective` containing "and" (usually two missions
wearing one coat).

## 7. Approving missions — Gate 1

```bash
npm run approve -- SM-001 --by "jay.r" --minutes 4
npm run approve -- SM-001 --by "jay.r" --minutes 9 --edited
```

This moves `missions/draft/SM-001.json` → `missions/approved/SM-001.json` and
stamps an approval block. Commit the move; that is the audit trail.

`--minutes` and `--edited` feed the mission edit rate in
[docs/BASELINE.md](docs/BASELINE.md). They are not bookkeeping: review cost is
the hidden failure mode of this whole approach. A mission that takes twenty
minutes to review is a net loss even when execution is free.

There is deliberately no bulk-approve flag.

### Requirement pinning

Approval records a hash of the requirement as it read that day
(`requirement_ref.content_hash`). Before each run, the executor re-checks it:

```text
! SM-001: The requirement at input/feature/requirement.md has changed since this
  mission was approved (recorded sha256:2f4a…, now sha256:cd67…). The mission may
  no longer test what it claims. Re-read it at Gate 1 and re-approve.
```

This catches the one failure nothing else can: the requirement is edited, the
mission is not, and the mission silently stops testing what it claims — while
its approval stamp still looks perfectly valid. It warns rather than blocks,
because some edits are typo fixes and some invalidate the mission entirely, and
only a person can tell which. The warning is also recorded on the result.

## 8. Running the Execution Agent

```bash
npm run run-mission               # every approved mission
npm run run-mission -- SM-001     # one
HEADED=false npm run run-mission  # headless
```

Only missions in `missions/approved/` with a populated approval block run. A
draft never executes, however valid it looks.

Exit code is `1` if any mission is not PASS — including BLOCKED and
INCONCLUSIVE, because both mean a human still has to look.

## 9. Where evidence is stored

```text
runs/<TEST_ID>/<RUN_ID>/
├── execution.log            every step, every resolution, flushed as it happens
├── replayable-trace.json    the resolved locators actually used
├── result.json              the structured result
├── failure.png              screenshot (failures only, by default)
├── failure-snapshot.yaml    accessibility snapshot at the point of failure
└── trace.zip                Playwright trace (failures only, by default)
```

Open a trace with:

```bash
npx playwright show-trace runs/SM-001/<RUN_ID>/trace.zip
```

The bar for evidence is simple: **a human must be able to review the result
without re-running the test.** Traces are on from day one because the trace
viewer alone nearly satisfies that on its own.

Screenshots are *not* taken after every action. That cost is paid again on every
run forever, and it buys very little.

### The replayable trace

Every run writes the ordered list of *resolved* locators it actually used. It
costs nothing to produce and it is the most valuable thing here:

* it feeds `knowledge/locator-cache.json`, so later runs are faster
* it makes the deterministic replay possible
* it is what turns a validated flow into a permanent Playwright test later —
  codegen rather than re-authoring the whole thing by hand

## 10. Results and reports

```bash
npm run report                # rebuild from results on disk
npm run report -- SM-001
```

Reports land in `reports/` and lead with what is *not* trustworthy — BLOCKED and
INCONCLUSIVE before failures — then show each failure's expected/actual,
evidence paths, and the classifier's reasoning.

Nothing files a defect. Gate 2 is a human reading the report.

---

## How results are decided

| Status | Meaning |
|---|---|
| `PASS` | Every critical assertion was explicitly verified against the live page |
| `FAIL` | The flow completed and a critical assertion did not hold |
| `BLOCKED` | The run could not be performed — missing session, unreachable page, unidentifiable element, budget exhausted |
| `INCONCLUSIVE` | The run happened but cannot honestly be called either way |

Status and classification are separate axes. Status says *what happened to the
test*; classification says *whose fault it was*:

`PRODUCT_DEFECT` · `AGENT_EXECUTION_FAILURE` · `ENVIRONMENT_FAILURE` ·
`TEST_DATA_FAILURE` · `INCONCLUSIVE`

The executor never classifies its own failure — an agent that just failed is the
least reliable narrator of why. [src/classify.ts](src/classify.ts) proposes;
the human at Gate 2 decides.

### Rules the executor will not break

* PASS requires explicit verification. A click that did not throw is not evidence.
* If the intended element cannot be identified with reasonable confidence — or
  several match and the mission did not say so — it stops and reports. It never
  operates a plausible-looking neighbour.
* An environment problem is never reported as a product defect.
* An unmet precondition is BLOCKED, not FAIL. So is a budget overrun.
* Before reporting FAIL, it replays once. If the two runs disagree, the result is
  INCONCLUSIVE — a false defect costs more human QA time than reporting nothing.
* It stays inside the mission's module.

---

## A note on "Playwright CLI" and LLM integration

Two honest caveats, so nobody is surprised later:

**1. The executor uses the Playwright library, not shell calls to the CLI.**
The mission interpreter in `src/` drives Chromium through Playwright's API —
which is what the CLI drives too. The requirement that *matters* is met: no
human writes a Playwright test file, and missions are authored in structured
natural language. Playwright's own CLI is used for what it is best at:
`playwright install`, `playwright open --save-storage`, and
`playwright show-trace`.

**2. There is no LLM integration yet, by design.** So "semantic discovery" here
is deterministic: the mission's `role`/`name`/`label` descriptors are matched
against the live accessibility tree, with the locator cache tried first. That is
genuinely semantic — it is meaning, not CSS — but it is not a model reading the
page.

`resolveTarget()` in [src/discovery.ts](src/discovery.ts) is exactly where a
model-driven resolver plugs in, and `describeCandidates()` already produces the
accessibility context such a resolver would need. Nothing above that boundary
changes when it arrives.

---

## Deliberately not built

Full regression · all browsers · mobile · performance · accessibility · CI/CD ·
automatic defect creation · self-healing · regression selection · vector
DB / RAG · multi-agent orchestration · more than one project.

POC-1 proves the core loop. Everything above multiplies before the loop is
known to work.

---

## Project layout

```text
agent/
  thinking/SYSTEM_PROMPT.md      what the Thinking Agent is held to
  thinking/config.yaml           model (claude-opus-5) and effort
  thinking/ANALYSIS_TEMPLATE.md  the shape of the committed analysis
  execution/EXECUTION_PROMPT.md  the executor's rules (and src/'s spec)
input/feature/                   requirement, documentation, existing coverage
thinking/
  prompts/                       generated prompt packs (gitignored)
  analysis/                      committed gap/risk analysis
knowledge/
  application-context.yaml       modules, roles, global testing rules
  locator-cache.json             written by successful runs, not by hand
missions/draft/                  proposed — never executed
missions/approved/               Gate 1 passed — the only thing that runs
runs/                            evidence, one directory per run
reports/                         Markdown summaries for Gate 2
schemas/                         the two contracts, authoritative
scripts/                         new-feature · inspect · think · import · validate · approve · run-mission · coverage · report
src/                             the Execution Agent
docs/BASELINE.md                 the KPI measurement, filled in by hand
```
