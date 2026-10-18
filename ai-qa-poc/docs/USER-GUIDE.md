# QAgents — User Guide

How to take a user story from Jira (or a BA document) to reviewed test cases,
executed tests and Jira-ready defects, with a person approving the output at
every step.

---

## 1. What the platform does

```text
 STAGE 1 · story only, no URL needed
 ┌──────────────┐    ┌────────────────────┐    ┌─────────────────────────┐
 │ Jira story / │ →  │ Thinker Agent      │ →  │ GATE 1 · you            │
 │ BA document  │    │ gaps, risks,       │    │ answer the questions,   │
 └──────────────┘    │ questions          │    │ approve the analysis    │
                     └────────────────────┘    └─────────────────────────┘
 STAGE 2 · still no URL
                     ┌────────────────────┐    ┌─────────────────────────┐
                  →  │ Test Case Agent    │ →  │ GATE 2 · you            │
                     │ writes test cases  │    │ Approve / Reject /      │
                     │ (Excel sheet)      │    │ Rework each row         │
                     └────────────────────┘    └─────────────────────────┘
 STAGE 3 · when the build / URL is available
                     ┌────────────────────┐    ┌─────────────────────────┐
                  →  │ Execution Agent    │ →  │ GATE 3 · you            │
                     │ runs in Chromium,  │    │ confirm real defects,   │
                     │ records evidence   │    │ post them to Jira       │
                     └────────────────────┘    └─────────────────────────┘
```

**The AI proposes; a person decides.** Nothing moves past a gate without a
named approver, and nothing is ever posted to Jira automatically.

---

### The three agents

| Agent | What it does | Chat | Command |
|---|---|---|---|
| **Thinker Agent** | Story → analysis, gaps, risks, questions | `/thinker` | `npm run thinker -- --feature X` |
| **Test Case Agent** | Approved analysis → test cases (sheet) | `/test-cases` | `npm run test-case-agent -- --feature X` |
| **Execution Agent** | Approved test cases → run, evidence, defects | `/execute` | `npm run execution-agent -- --feature X` |

### The easy way: just chat

Open the **`QAgents POC`** folder in Claude Code (terminal or VS Code) and talk
to it. You don't need to remember any command below.

```text
/thinker login PROJ-123            ← import the story from Jira and analyse it
/thinker login                     ← then paste the story text in the same message
Q-1: locked for 15 minutes. Q-2: assume email only.     ← answer the questions
approve the analysis, 15 minutes   ← GATE 1
/test-cases login                  ← generate the test cases
approve LG-001 to LG-012; reject LG-013, duplicate of LG-004;
LG-014 should use 3 attempts not 5                       ← GATE 2
/execute login                     ← when the build URL is ready
approve all clean missions                               ← GATE 2.5 (it lists them first)
confirm defect 3fa9c1, reproduced manually               ← GATE 3
I posted it as PROJ-456            ← records the Jira key
/qa-status login                   ← where are we, what's next?
```

Claude runs the commands, summarises the results in chat, and records each
decision **in your name**. It asks for your name once per conversation. It
never approves, rejects or confirms anything you didn't say, and it never
posts to Jira. The rest of this guide is what happens underneath, for anyone
who prefers the commands or needs to troubleshoot.

---

> **What gets tested?** See [COVERAGE-MATRIX.md](COVERAGE-MATRIX.md) for every
> testing type (✅ / ⚠️ / ❌) and the automatic bug detectors that run on every test.

## 2. One-time setup

You need **Node.js 20+**, **Claude Code** signed in with your Claude
subscription, and access to the STAGE environment. No API key is needed.

```powershell
cd ai-qa-poc
npm install
npm run browsers                 # installs Chromium for Playwright
npm run browsers:all             # optional: also Firefox and WebKit (Safari's engine), for cross-browser runs
claude update                    # Claude Code must be 2.1.280 or newer
claude                           # sign in once, then exit
copy .env.example .env           # then edit .env (below)
```

In `.env`:

| Setting | When you need it |
|---|---|
| `BASE_URL` | Stage 3 only: the STAGE URL under test |
| `BUILD` | Stage 3: build or version, shown in reports |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Only to import stories straight from Jira (read-only) |

`.env` and `.auth/` are never committed. Do not put credentials anywhere else.

> **Shell:** the commands below are written for PowerShell (Windows). Set a
> one-off variable with `$env:NAME="value"; npm run ...`.

---

## 3. The workflow, step by step

Throughout this guide, `login` is the **feature name** (lowercase, one word)
and `LG` is the **test ID prefix** (2–4 capital letters). Use your own.

### Step 1 · Import the story

Pick whichever way you have the story:

```powershell
npm run story -- --feature login --prefix LG --jira PROJ-123        # live from Jira
npm run story -- --feature login --prefix LG --from story.txt       # text copied from the ticket / BA doc
npm run story -- --feature login --prefix LG --from PROJ-123.json   # Jira JSON or XML export
```

This creates the feature and writes `input/feature-login/requirement.md`, with
one heading per acceptance criterion. Add `--with-comments` to include the
ticket discussion as context.

**Check:** open `requirement.md` and make sure every acceptance criterion came
through. If the story has none, the agent will ask rather than guess.

### Step 2 · Run the analysis (Thinker Agent)

```powershell
npm run thinker -- --feature login
```

It takes a few minutes. Output:

* `thinking/analysis/login-<date>.md`: gaps, ambiguities, ranked risks, scenarios,
  smoke set and coverage decisions
* a numbered list of **questions for the requirement owner**, also saved to
  `input/feature-login/clarifications.yaml`

No test cases are written yet. That is deliberate: questions first, so test
cases are never written against a guess.

### Step 3 · Answer the questions

Get answers from the BA / PO, then record each one:

```powershell
npm run clarify -- --feature login --open                                   # list what is open
npm run clarify -- --feature login --answer Q-1 --text "Locked for 15 minutes after 5 failures" --by "your.name"
```

If you must proceed without a confirmed answer, record it as an assumption.
Tests built on it are flagged everywhere they appear.

```powershell
npm run clarify -- --feature login --answer Q-2 --text "Assume 15 minutes" --by "your.name" --assumed
```

### Step 4 · GATE 1: approve the analysis

Read the analysis file, then:

```powershell
npm run approve-analysis -- --feature login --by "your.name" --minutes 15
npm run approve-analysis -- --feature login --status                        # check the gate
```

It refuses while any question is still open. If the analysis, the requirement
or an answer changes later, the approval becomes **stale** and test case
generation stops until someone approves again.

### Step 5 · Generate the test cases

```powershell
npm run test-case-agent -- --feature login
```

The Test Case Agent refuses to start until Gate 1 is approved. Output:

* `reports/TEST-CASES-login.csv`: **the test case sheet**, opens in Excel
* `thinking/analysis/login-coverage-audit-<date>.md`: which acceptance criterion
  each test covers

If it finds a new gap while writing, it adds a question and Gate 1 goes stale
again. Answer it (step 3), re-approve (step 4), and run this step again.

Then run the automatic checks:

```powershell
npm run verify -- --feature login                 # every test quotes the real requirement; every AC is covered
npm run coverage -- --check --drafts              # every test category is covered or ruled out
```

### Step 6 · GATE 2: review the test cases in the sheet

Open `reports/TEST-CASES-login.csv` in Excel. The columns are the team's
standard format (Test Case ID, Module, FE/BE?, Title, Pre-Conditions, Steps,
Test Data, Expected Result, …) followed by sign-off columns (Gate 2 Decision,
Requirement / AC Ref, Priority, Test Type, …).

For each row, fill **Gate 2 Decision**:

| Decision | Meaning | Also fill |
|---|---|---|
| `Approve` | Correct as written | nothing |
| `Reject` | This test should not exist | the reason in **QA Comment** (required) |
| `Rework` | Needs changing | what to change in **QA Comment**, or edit the cells directly |

Save the file **as CSV** (keep the same name and format), then:

```powershell
npm run approve-sheet -- --feature login --by "your.name" --minutes 40 --dry-run   # preview, changes nothing
npm run approve-sheet -- --feature login --by "your.name" --minutes 40             # apply
```

Rules:

* A blank row stays waiting. There is no "approve all".
* If you mark a row **Approve** but also edited its text, it is not approved
  as-is. It becomes a **Rework** request carrying your edits.
* A refused row keeps its decision and the reason is printed. Fix the cause and
  run again.
* If anything was marked **Rework**, regenerate. Only those test cases are
  rewritten, and rejected ones are never proposed again:

  ```powershell
  npm run test-case-agent -- --feature login
  ```

To decide named cases without the sheet:
`npm run decide -- --by "your.name" --approve LG-001..LG-010 --minutes 10`
(also `--reject LG-011 --reason "..."` and `--rework LG-012 --request "..."`).

### Step 7 · When the build is ready: connect the tests to the real app

Set `BASE_URL` in `.env` (or `base_url` in
`knowledge/application-context-login.yaml`). Then:

```powershell
npm run auth -- --role admin --feature login     # opens a browser: sign in once, close it
npm run inspect -- --feature login               # captures the real pages
npm run bind -- --feature login --write          # maps each approved test case onto the real UI
npm run verify -- --feature login                # re-checks everything against the live app
```

`bind` writes `reports/reconciliation-login-<time>.md`, which lists anything it
could not settle (a control it could not find, two candidates for one step).

**GATE 2.5:** approve each mission.

```powershell
npm run approve -- LG-001 --by "your.name"                  # clean binding
npm run approve -- LG-004 --by "your.name" --reviewed       # had exceptions: read the reconciliation first
```

### Step 8 · Run the tests

```powershell
npm run execution-agent -- --feature login                # all approved tests
npm run execution-agent -- LG-001                         # one test
npm run execution-agent -- --feature login --headless     # without a visible browser
npm run execution-agent -- --feature login --viewport mobile   # the whole suite on a phone-size screen (tablet, desktop, 1280x720)
npm run execution-agent -- --feature login --browser firefox   # the whole suite in Firefox (or webkit / safari)
npm run execution-agent -- --feature login --no-explore        # skip the exploration that runs at the end
```

Open **`reports/EXECUTION-REPORT-login.html`** in a browser. It starts with
what did **not** run, then each test with step-by-step screenshots, the
expected-vs-actual for every check, video, the API calls the page made, and the
Playwright trace.

Statuses: **PASS** (every check verified) · **FAIL** (a check did not hold) ·
**BLOCKED** (could not run: environment, login, missing element) ·
**INCONCLUSIVE** (ran, but cannot honestly be called either way).

The test case sheet is updated with Actual Result, QA Status and Evidence. Run
`npm run test-cases -- --feature login` to refresh it at any time.

If a test failed only because the UI wording differs slightly from the test
case, the run proposes fixes in `reports/HEALING-login.md`:
`npm run heal -- --feature login --apply H-1 --by "your.name"`.

### Step 9 · GATE 3: review defects and post them to Jira

Open **`reports/DEFECT-REVIEW.html`** in a browser. Every defect candidate is
laid out as a Jira bug: Summary, Priority, Environment, Labels, story link,
description and attachments, each with a **Copy** button.

1. Read the card. The **Reviewer notes** panel shows the AI's view, but do not paste it into Jira.
2. Decide:

   ```powershell
   npm run defects -- --confirm <fingerprint> --by "your.name" --note "Reproduced manually"
   npm run defects -- --reject  <fingerprint> --by "your.name" --note "Environment slowness, not a bug"
   ```

3. For a confirmed defect, create the Bug in Jira **yourself**: copy each field,
   use **Copy description (formatted)** for the description, and attach the
   evidence files listed on the card.
4. Record the Jira key so the card moves to **Posted** and repeats link to it:

   ```powershell
   npm run defects -- --confirm <fingerprint> --by "your.name" --ticket PROJ-456
   ```

The fingerprint is shown on each card and in `npm run defects -- --list`.

---

## 4. Command cheat sheet

| I want to… | Command |
|---|---|
| Where is a feature, what's next? | `npm run status -- --feature X` |
| Import a story | `npm run story -- --feature X --prefix XX --jira KEY` / `--from file` |
| Thinker Agent (analysis) | `npm run thinker -- --feature X` |
| Test Case Agent (test cases, rework) | `npm run test-case-agent -- --feature X` |
| List / answer questions | `npm run clarify -- --feature X --open` / `--answer Q-n --text "..." --by "me"` |
| Gate 1 | `npm run approve-analysis -- --feature X --by "me" --minutes N` |
| Rebuild the test case sheet | `npm run test-cases -- --feature X` |
| Check test cases | `npm run verify -- --feature X` · `npm run coverage -- --check --drafts` · `npm run validate` |
| Gate 2 (sheet) | `npm run approve-sheet -- --feature X --by "me" --minutes N [--dry-run]` |
| Gate 2 (named cases) | `npm run decide -- --by "me" --approve XX-001..XX-010` · `--reject XX-011 --reason "..."` · `--rework XX-012 --request "..."` |
| Save a login session | `npm run auth -- --role <role> --feature X` |
| Capture the real app | `npm run inspect -- --feature X` |
| Map tests onto the app | `npm run bind -- --feature X --write` |
| Gate 2.5 | `npm run approve -- XX-001 --by "me" [--reviewed]` |
| Execution Agent (run tests) | `npm run execution-agent -- --feature X` |
| Apply healing proposals | `npm run heal -- --feature X --apply H-1 --by "me"` |
| Gate 3 | `npm run defects -- --confirm/--reject <fp> --by "me"` |
| Access control: every role × every page | `npm run access-matrix -- --feature X` (rules under `access:` in the app context) |
| Visual baselines: list / approve | `npm run visual -- --list` · `npm run visual -- --approve XX-001 --by "me"` |
| Rebuild the defect review page | `npm run defects -- --review` |
| Team metrics (review time, false-defect rate) | `npm run metrics` |

---

## 5. Where things are

| File | What it is |
|---|---|
| `input/feature-X/requirement.md` | The imported story, one heading per acceptance criterion |
| `input/feature-X/clarifications.yaml` | Questions and answers: part of the requirement once answered |
| `input/feature-X/review-feedback.yaml` | Gate 2 rework requests |
| `thinking/analysis/X-<date>.md` | The analysis approved at Gate 1 |
| `intents/draft/`, `intents/approved/`, `intents/rejected/` | Test cases by Gate 2 state (JSON, the source of truth) |
| `missions/draft/`, `missions/approved/` | Test cases bound to the real UI (only `approved/` runs) |
| `reports/TEST-CASES-X.csv` | **The test case sheet** |
| `reports/EXECUTION-REPORT-X.html` | **The run report** |
| `reports/DEFECT-REVIEW.html` | **The Gate 3 / Jira page** |
| `runs/<TEST_ID>/<run>/` | Raw evidence: screenshots, video, trace, logs |

---

## 6. Good practice

* **Always use your real name in `--by`.** It is the audit trail for every gate.
* **Pass `--minutes`** at each gate. It is how we prove (or disprove) that this
  saves time.
* **Answer questions instead of assuming.** Use `--assumed` only when you
  must, because every test built on an assumption is flagged and its failures
  may not be real defects.
* **Edit the test case, not the generated report.** The sheet's test case cells
  are rebuilt from the JSON. Your changes go in through Rework. Only Dev Status,
  Dev Date Executed, Dev Notes, cross browser Verfied ?, QA Comment and Gate 2
  Decision are yours to type in, and those are kept when the sheet is rebuilt.
* **A FAIL is not a defect until a person confirms it.** Check the evidence and
  the Reviewer notes first. BLOCKED and INCONCLUSIVE are investigations, not bugs.
* **Generated data (intents, missions, runs, reports) is never committed.**
  Only engine code is.

---

## 7. Troubleshooting

| Message | What to do |
|---|---|
| `Claude Code … does not support this model` | Run `claude update`. Or, for now: `$env:THINKING_MODEL="opus"; npm run thinker -- --feature X` |
| `Claude Code was not found` | Install Claude Code and run `claude` once to sign in |
| `N question(s) … are still open` | Answer them with `npm run clarify` (step 3) |
| `Gate 1 — the analysis … is waiting for a person` / `stale` | Read the analysis and run `approve-analysis` again (step 4) |
| `The sheet has no "Gate 2 Decision" column` | Rebuild the sheet: `npm run test-cases -- --feature X` |
| `Reject needs a reason in QA Comment` | Add the reason and run `approve-sheet` again |
| `base_url is still the placeholder` | Set `BASE_URL` in `.env` |
| A test is **BLOCKED** with a session error | `npm run auth -- --role <role> --feature X` to sign in again |
| Analysis or test cases look thin | Check `requirement.md`: the agent only knows what the story says |
