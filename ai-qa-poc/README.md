# ai-qa-poc

AI agents that take over most of the manual QA work (requirement analysis,
test case writing, execution and reporting), with a human approving the output
at each of three gates.

## Vision

Today the QA team does four things by hand: **requirement analysis → test case
creation → execution → reporting/defects**. The work usually starts before
there is a build: all we have is a user story document (module by module) from
the BA team, or a Jira ticket. The system is designed around that order:

```text
── Stage 1 · needs only the story / Jira ticket (no URL) ─────────────────
User story doc  or  Jira ticket
   ↓
Thinker Agent         requirement analysis: gaps, ambiguities, ranked risks,
                      scenarios, regression impact, coverage decisions
   ↓
HUMAN — Gate 1        Analysis approval: answer the questions, approve the analysis
   ↓
── Stage 2 · still no URL ───────────────────────────────────────────────
Test Case Agent       writes the test cases against the settled requirement
                      (UI-free intents, in the team's test case format)
   ↓
HUMAN — Gate 2        Test case approval: approve / edit / reject each case
   ↓                  → test cases are FINAL
── Stage 3 · when the build / service URL arrives ───────────────────────
Bind + Verify         map approved cases onto the real UI, re-check traceability
   ↓
Execution Agent       Playwright → Chromium → STAGE, full evidence for every test
   ↓
Classifier            PASS / FAIL / BLOCKED / INCONCLUSIVE, plus proposed cause
   ↓
HUMAN — Gate 3        Result review: real defect / test issue / environment / retry
   ↓
Defect review report  every defect laid out as Jira fields → a person posts it to Jira by hand
```

Principles:

* **Humans approve; the AI proposes.** Nothing moves past a gate without a named approver.
* **Ask before generating.** Gaps go to the requirement owner as questions *before*
  test cases are written. Writing them first and fixing them later wastes tokens and review time.
* **No URL is needed until Stage 3.** Analysis and test cases come from the story alone.
* **A false defect is worse than no defect.** When the evidence is weak the result is
  INCONCLUSIVE, never FAIL.
* **Subscription only.** Runtime AI goes through Claude Code headless on the Claude
  subscription. No API key, no other LLMs.

**New here? Start with [docs/USER-GUIDE.md](docs/USER-GUIDE.md):** the step-by-step
process and every command, written for the QA team. What is tested, partly
tested and not yet tested: [docs/COVERAGE-MATRIX.md](docs/COVERAGE-MATRIX.md).

See [../VISION.md](../VISION.md) for the reasoning behind the architecture.

## Status against the vision

| Step | Status | How today |
|---|---|---|
| Import story / Jira ticket | ✅ built | `npm run story` (live Jira, JSON/XML export, pasted text), one heading per AC |
| Thinker Agent analysis (gaps, risks, coverage) | ✅ built | `npm run think -- --feature X --run` runs it headless through Claude Code on the subscription: writes the analysis, adds its questions to the ledger, stops |
| Gate 1: analysis approval | ✅ built | `npm run approve-analysis`: refuses while questions are open; goes stale (and blocks generation) if the analysis, requirement or any answer changes afterwards |
| Test case generation | ✅ built | Intents (JSON) are the source of truth; `npm run test-cases` writes `reports/TEST-CASES-<feature>.csv` in the team's format, with no URL needed. Regenerating keeps whatever people typed in the Dev columns, the cross-browser column and QA Comment. After the team's 15 columns come the sign-off columns: Requirement / AC Ref, Priority, Test Type, Automation Status, Approved By/Date, Build / Environment, Defect ID, Evidence. |
| Gate 2: test case approval | ✅ built | Fill **Gate 2 Decision** (Approve / Reject / Rework) per row in the sheet, then `npm run approve-sheet`. Same checks as `npm run approve-intent` (one case). Rework requests are fed to the next `think --run`, which rewrites exactly those cases; rejected cases are never proposed again. |
| Bind + verify when the URL arrives | ✅ built | `inspect` → `bind` → `verify` |
| Execution + evidence | ✅ built | `run-mission`: per-step screenshots, video, API calls, trace, HTML report |
| Classification + healing proposals | ✅ built | `classify.ts`, `npm run heal` |
| Gate 3: result review | ✅ built | `reports/DEFECT-REVIEW.html`, rewritten by every run and every `npm run defects` command, groups defects as To review / Confirmed / Posted / Rejected. Decide with `npm run defects -- --confirm / --reject`. |
| Defect posted to Jira | ✅ by design, by hand | Nothing is sent to Jira automatically. The review page lays out each defect as Jira fields (Summary, Bug, Priority, Environment, Labels, story link, formatted description, attachments) with copy buttons. Post it yourself, then record the key with `--confirm <fp> --ticket <KEY>`. |
| Web UI | ⚠️ off-policy, outdated | `web/` calls the metered Anthropic API (and OpenAI/Gemini), and predates intents, Gate 1 and the sheet. Use the CLI. |
| Metrics | ✅ built | `npm run metrics`: Gate 1 state and analysis review minutes; Gate 2 rejected / rework counts and review minutes; Gate 3 false-defect rate |

Gate numbering everywhere: **Gate 1** analysis · **Gate 2** test cases · **Gate 2.5**
binding review (only when the URL arrives, exceptions only) · **Gate 3** results.

## The flow, command by command (Stages 1–2, no URL)

```bash
npm run story -- --feature login --prefix LG --jira PROJ-123    # or --from story.txt / export
npm run think -- --feature login --run                          # ANALYSE: analysis + questions
npm run clarify -- --feature login --answer Q-1 --text "..." --by "jay.r"
npm run approve-analysis -- --feature login --by "jay.r" --minutes 10   # GATE 1
npm run think -- --feature login --run                          # GENERATE: test cases + sheet
npm run verify -- --feature login
# open reports/TEST-CASES-login.csv, fill "Gate 2 Decision" per row (Approve / Reject / Rework,
# reason or requested change in QA Comment), save, then:
npm run approve-sheet -- --feature login --by "jay.r" --minutes 40 --dry-run   # preview
npm run approve-sheet -- --feature login --by "jay.r" --minutes 40             # GATE 2
npm run think -- --feature login --run                          # only if any rows were Rework
```

Gate 2 rules: a blank row stays waiting, and there is no "approve all". A row
marked Approve whose test case text was edited in the sheet is not approved
as-is; it becomes a rework request carrying the edits. Reject needs a reason.
Refused rows keep their decision so you can fix the cause and run again.
`npm run approve-intent -- <ID> --by "<name>"` still approves a single case.

`think --run` decides its phase from disk. It does not call the model while
questions are open or Gate 1 is pending, and it never overwrites an approved
test case. Any gap it finds while writing test cases is added to the ledger,
which makes Gate 1 stale again. The model and effort come from
[agent/thinking/config.yaml](agent/thinking/config.yaml) (`THINKING_MODEL` /
`THINKING_EFFORT` override). Without `--run`, `npm run think` still writes the
prompt pack for pasting by hand.

## Stage 3 → Gate 3, after a run

```bash
npm run run-mission -- --feature login         # writes the execution report AND reports/DEFECT-REVIEW.html
# open reports/DEFECT-REVIEW.html, read each defect, then:
npm run defects -- --confirm <fp> --by "jay.r" --note "..."      # or --reject <fp> --note "why"
# post the confirmed defect to Jira by hand from the page (Copy buttons, attach the evidence files)
npm run defects -- --confirm <fp> --by "jay.r" --ticket PROJ-123  # record the key; the card moves to Posted
```

The description is copied as formatted HTML, so it pastes into Jira's editor
with its headings and lists intact. Classifier and AI notes sit in a separate
"Reviewer notes" panel and are not part of what you paste.

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

### From a Jira story (Phase 4)

```bash
npm run story -- --feature login --prefix LG --jira PROJ-123           # live (JIRA_* in .env)
npm run story -- --feature login --from exports/PROJ-123.json          # JSON export
npm run story -- --feature login --from exports/sprint.xml             # Jira "Export → XML"
npm run story -- --feature login --from story.txt                      # text copied from the ticket
```

Creates the feature if needed (no URL required), keeps the raw ticket in
`input/feature-<name>/tickets/`, and writes `requirement.md` with **one heading
per acceptance criterion** — Gherkin scenarios, numbered lists and "AC1:" lines
are all split. That is what lets `npm run verify` say "AC-3 has no test case".
Re-importing a ticket replaces only its own block; tests approved against the
old text are flagged for a re-read. A ticket with no acceptance criteria is
imported as such, and the Thinker Agent asks rather than assumes.
`--with-comments` adds the ticket discussion as context (not as requirements).

### By hand

```text
input/feature/requirement.md      the requirement under test
input/feature/documentation.md    supporting product docs
input/feature/existing-tests.md   what is already covered
```

Keep these committed. The Thinker Agent runs in a chat window, so its reasoning
is not durable — this is what `requirement_ref` points at, and it is what makes
a result traceable back to a requirement rather than just to a test id.

## 6. Creating missions — the Thinker Agent

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
> Either route produces identical artifacts. Execution can optionally use a
> bounded AI review after a mission finishes; it does not control the browser
> or change PASS/FAIL.


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

### Before the front-end exists — no URL needed

Test cases are normally written before the application is built, so there is
nothing to inspect. Start the feature without a URL:

```bash
npm run new-feature -- --name billing --prefix BL      # no --url: pre-build
```

`npm run think` sees there is no capture and asks for UI-free **intents** only.
Nothing up to Gate 2 needs a running application.

### Verify the test cases before anything executes

```bash
npm run verify -- --feature billing
```

It picks its mode from what exists:

| Mode | When | What it checks |
|---|---|---|
| **pre-build** | no real URL yet | every `requirement_ref.quote` really appears in the requirement, docs or a clarification answer (a paraphrase reads the same as an invented rule) · every requirement section is cited by some test · no test rests on an open question or on an answer edited after approval · duplicates, missing critical outcomes, lint |
| **live** | URL configured | all of the above, plus: environment reachable · a capture exists, from this URL, newer than the approvals · every approved intent has an approved mission · no intent edited since it was bound (`binding.intent_hash`) · starting pages load · roles have a session |

A **block** issue holds that test back; a **warn** does not. Results go to
`reports/VERIFICATION-<feature>.md`. `npm run run-mission` runs the same checks
first and skips held tests, and the execution report lists each one with its
reason under "did not run". With no real URL, `run-mission` stops and points
at the verification report instead of launching a browser. `--skip-verify`
bypasses the gate for debugging.

When the build lands: set `base_url` (or `BASE_URL`) → `inspect` → `bind --write`
→ `verify` → `run-mission`.

## 7. Approving missions — Gate 2

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
  no longer test what it claims. Re-read it at Gate 2 and re-approve.
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

### Evidence for every test — passes included

By default (`--evidence full`) every test records, whether it passes or fails:

* for each step: the element it used **outlined in red**, the page after the step, and the URL
* for each check: expected vs actual, how it matched, and a screenshot of what was checked
* a screen recording (opened at the point where this test starts, when tests share a browser)
* the API calls the page made (XHR/fetch), failures highlighted, with secret values masked
* the Playwright trace

`--evidence minimal` (or `EVIDENCE=minimal`) goes back to failure-only evidence.

### The report to open: `reports/EXECUTION-REPORT-<feature>.html`

Written after every run. It opens with what **did not run**, then a trust summary,
then one card per test: a "why it failed" panel (expected, actual, proposed cause,
replay result) or a "how it passed" panel, then the step-by-step flow with
screenshots, the checks, the video and the API calls. Filter by status or
"needs review", search by id. The Markdown copy is still written next to it.

Every test carries a **trust** label:

| Label | Meaning |
|---|---|
| `verified` | every element and every check matched exactly |
| `review` | a fuzzy, synonym or AI match was involved — the card names each such step |
| `weak` | BLOCKED / INCONCLUSIVE, or evidence missing |

### Smarter element matching

Test cases are written before the UI exists, so their wording drifts from the
shipped page. When the exact descriptor finds nothing, the executor tries, in order:

1. **fuzzy** — same words ignoring case, spacing and punctuation (`Sign in` = `SIGN IN →`)
2. **synonym** — known equivalents (`Log in` = `Sign in`, `Email` = `E-mail address`, `Cart` = `Basket`); see `SYNONYM_GROUPS` in [src/smart-locator.ts](src/smart-locator.ts)
3. **AI** — Claude picks from the controls actually on the page, must give a reason, and a low-confidence answer is refused

Tiers 1–2 accept only a single visible match. The AI tier is used for **actions
only** — a check never passes because a model picked the element it examined.
Text checks accept exact, then normalised (case/spacing/punctuation), then — only
with high confidence — an AI judgement that the wording means the same thing
("Order placed successfully!" for "Your order has been placed"); a different
field, number or outcome is never accepted. Every non-exact match is recorded on
the step and makes the test `review`.

### AI without an API key

Execution-time AI (element matching, text meaning, failure triage) runs through
**Claude Code in headless mode on your Claude subscription** whenever Claude
Code is installed — no API key, no separate bill. Sign in once with `claude`.

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | auto | `claude-cli` (subscription), `api` (needs `ANTHROPIC_API_KEY`, metered), or `off`. Auto prefers the subscription. |
| `EXECUTION_AI_MODEL` | route default (Opus) | e.g. `claude-opus-5-5` |
| `EXECUTION_AI_EFFORT` | `low` | effort for the subscription route; each call takes a few seconds |
| `SEMANTIC_ASSERTIONS` | on | `off` disables AI judging of text meaning |
| `CLAUDE_CLI` | found automatically | path to the Claude Code binary if it is somewhere unusual |

AI is only called when deterministic matching fails, so a run where the page
matches the test cases makes no AI calls at all.

### Keeping test cases in step with the app (Phase 5)

Test cases written before the UI existed will describe some of it slightly
wrong. After each run, `run-mission` proposes updates from the evidence and
writes `reports/HEALING-<feature>.md`; `npm run heal -- --feature <name>` does
the same on demand.

| Proposal | When | Applying it |
|---|---|---|
| **locator** | a step or check only worked through fuzzy/synonym/AI matching | updates the test to the element's real name, so the next run is exact and `verified` |
| **expectation** | a check failed (or passed only on meaning) because the text differs | needs `--confirmed-with "<requirement owner>"`; **refused** when the requirement itself states the expected text — that is a defect |
| **rebind** | the intent was edited after the test was generated | shows the `bind` command |
| **reapprove** | the requirement changed under an approved test | shows the `approve` command |

```bash
npm run heal -- --feature login --apply H-1 H-2 --by "jay.r"
npm run heal -- --feature login --apply all-locators --by "jay.r"
npm run heal -- --feature login --apply H-5 --by "jay.r" --confirmed-with "PO: Priya"
```

Nothing changes until you apply a proposal by id. Applying re-stamps the
mission's approval with your name and adds a `change_log` entry (what, why, on
which screenshot). A proposal is refused if the mission changed since it was made.

### Optional execution-time AI review

The browser remains deterministic. When enabled, the AI reviews a completed
non-PASS run or incidental finding and writes `ai-analysis.json` beside the
mission evidence. It proposes likely cause and bounded follow-up checks only;
the result status, classifier, and human Gate 3 decision remain authoritative.

```powershell
$env:EXECUTION_AI="true"
npm run run-mission -- --feature ecommerce
```

Runs on the Claude subscription route above; no key needed. If the API is disabled,
unavailable, or returns invalid JSON, the mission still completes normally and
records the AI failure as a note.

Missions already reuse the same Chromium browser, context, and page when their
role and preconditions allow it. The session resets for a clean-state mission,
a role change, a fatal run error, or `--fresh-state`. Use `--fresh-state` when
you need every mission isolated.

Missions can make this explicit with `execution_policy.state`: `reuse` (the
default), `read_only`, `fresh_page`, or `fresh_context`. Replay always uses a
fresh context regardless of the mission setting.

Only `FAIL` results classified as `PRODUCT_DEFECT` create mission defect files.
`BLOCKED` and `INCONCLUSIVE` results remain investigation items, while
incidental findings are stored as separate exploration candidates.

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

Nothing files a defect. Gate 3 is a human reading reports/DEFECT-REVIEW.html.

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
the human at Gate 3 decides.

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

**2. AI is a fallback, not the driver.** Element resolution is deterministic
first: the mission's `role`/`name`/`label` descriptors are matched against the
live accessibility tree, with the locator cache tried first. Claude is called
only when that fails (see "Smarter element matching"), and only for actions,
never for checks.

---

## Deliberately not built (yet)

Full regression · all browsers · mobile · performance · CI/CD · regression
selection · vector DB / RAG · more than one project · unattended defect filing
(a human always confirms at Gate 3).

Healing exists, but only as *proposals* that a human applies. Nothing rewrites
a test on its own.

---

## Project layout

```text
agent/
  thinking/SYSTEM_PROMPT.md      what the Thinker Agent is held to
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
missions/approved/               Gate 2 passed — the only thing that runs
runs/                            evidence, one directory per run
reports/                         Markdown summaries for Gate 3
schemas/                         the two contracts, authoritative
scripts/                         new-feature · inspect · think · import · validate · approve · run-mission · coverage · report
src/                             the Execution Agent
docs/BASELINE.md                 the KPI measurement, filled in by hand
```
