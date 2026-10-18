# QA Playbook — how to run a requirement through this system

This is the hands-on guide: what to type, in what order, to take a real
requirement from "here's the ticket" to "here's the report and the tickets for
what's broken." If you want to understand *why* it's built this way, read
[`VISION.md`](../VISION.md) — this doc is the opposite of that: no design
rationale, just the steps.

Keep this open in a second window the first few times. After a couple of
features it becomes muscle memory.

---

## 0. Before you touch anything

Two rules that are not optional, and are the most common way this goes wrong
for a new person:

1. **Every command below is run from inside `ai-qa-poc/`.** Not the repo root,
   not `web/`. If a command says "no such file," check your folder first.
2. **Never run `git add` / `git commit` / `git push` yourself.** Ask your lead
   before committing anything, and never commit generated data at all — files
   under `input/`, `intents/`, `missions/`, `runs/`, `reports/`, `knowledge/
   captures/`, `knowledge/observed/`, `thinking/analysis/`. That data is
   supposed to churn constantly as you test things; committing it just fills
   up history with noise nobody needs later. Only engine code (`src/`,
   `scripts/`, `schemas/`, docs) gets committed, and only by your lead.

One-time setup, if nobody has done this on your machine yet:

```bash
cd ai-qa-poc
npm install
npm run browsers          # installs the Chromium browser Playwright drives
cp .env.example .env      # then open .env and check BASE_URL if your lead gave you one
```

---

## 1. The mental model, in one picture

```text
Requirement (a ticket, a doc, whatever you were handed)
        ↓
npm run new-feature        — scaffold the folders for this feature
        ↓
npm run inspect             — look at the real page, if it exists yet
        ↓
npm run think                — build the prompt pack for the Thinker Agent
        ↓  (paste into Claude, save what comes back)
npm run clarify               — answer the questions it raised
        ↓
npm run validate             — check everything is well-formed
        ↓
npm run approve-intent       — GATE 1: you approve the test intent
        ↓
npm run bind --write          — bind the intent to the real page (needs a URL)
        ↓
npm run approve --reviewed   — GATE 1.5: you approve where it points
        ↓
npm run run-mission            — the browser actually runs it
        ↓
npm run report                — read what happened
        ↓
npm run defects                — turn a real failure into a ticket-ready report
        ↓  (you decide: confirmed / rejected)
```

Two things worth knowing before you start:

- **An "intent" and a "mission" are not the same thing.** An intent is what
  you write when the requirement exists but the actual web page might not yet
  — it says *what* should happen with no mention of buttons or screens. A
  mission is the same test *bound* to a real page: it names the actual
  button, the actual link. `npm run bind` is the step that turns one into the
  other. If there's no URL yet, you stop after approving the intent — that's
  a normal, complete stopping point, not a failure.
- **There are three gates, and each one can refuse.** That's not a bug you
  work around — it's the point. See §7 below for what each one is actually
  checking and what to do when it says no.

---

## 2. Step by step: a brand-new requirement

### Step 1 — Scaffold the feature

```bash
npm run new-feature -- --name login --url https://stage.example.com --prefix LG
```

- `--name` — a short lowercase name for this feature (letters, digits,
  hyphens). This becomes the folder name and shows up in every command after.
- `--url` — the real environment this feature lives on. Required — without it
  the Thinker Agent has nothing to look at and will invent UI that doesn't
  exist.
- `--prefix` — 2–4 letters used for every test id in this feature (`LG-001`,
  `LG-002`, ...). **Pick one your lead confirms is not already used** by
  another feature, or your test ids will collide with someone else's.

This creates:

```text
input/feature-login/requirement.md          ← you fill this in next
input/feature-login/documentation.md
input/feature-login/existing-tests.md
knowledge/application-context-login.yaml
```

### Step 2 — Write the real requirement

Open `input/feature-login/requirement.md` and replace the placeholder with
the actual requirement — the ticket text, the acceptance criteria, whatever
you were handed. Be as complete as you have; anything you leave out becomes a
gap the Thinker Agent has to ask you about later, which is fine, just slower.

If there's supporting material (a spec, a Figma link description, API docs),
put it in `documentation.md` in the same folder.

### Step 3 — Look at the real page (skip this if there's no URL yet)

```bash
npm run inspect -- --feature login
```

This opens the real application and records what's actually there — button
names, links, images, what's broken already. If the feature doesn't exist yet
(no front end built), skip this step entirely — the next step handles that
case on its own.

### Step 4 — Generate the thinking pack

```bash
npm run think -- --feature login --prefix LG --copy
```

This does **not** call any AI model itself — it assembles everything the
Thinker Agent needs into one file (the requirement, the schema, the
checklist, what `inspect` saw) and copies it to your clipboard.

Now you need an actual model to read that pack. Two free ways (both explained
in [`docs/NO-EXTRA-COST.md`](NO-EXTRA-COST.md) — read that once, it matters):

- **If you're working in Claude Code already:** just tell it — *"Act as the
  Thinker Agent. Read `thinking/prompts/prompt-login-<date>.md` and follow it
  exactly. Save the analysis and each intent to disk as it says."* It reads
  and writes the files itself. No copy-paste.
- **If you're using claude.ai in a browser:** paste the pack in, save the
  entire reply to a file (say `reply.md`), then run:

  ```bash
  npm run import -- --from reply.md --feature login
  ```

  This pulls out the analysis and every intent, validates each one, and files
  them. Add `--dry-run` first if you want to see what it *would* do before
  committing to it.

There is a third, paid route (`npm run web`) — a browser UI that calls the
API directly and bills you per token on top of any subscription you already
have. Don't use it unless your lead specifically asks you to; it buys nothing
the two routes above don't already give you for free.

### Step 5 — Answer the questions it raised

The model's reply will include a list of gaps — things the requirement never
stated. Check what's outstanding:

```bash
npm run clarify -- --feature login
```

Anything marked `open` is a real question, usually for whoever owns the
requirement (a BA, a PM, sometimes you). Answer it:

```bash
npm run clarify -- --feature login --answer Q-1 --text "Locked for 15 minutes after 5 failed attempts." --by "your name"
```

If nobody can answer it right now and you genuinely can't wait, you can record
an assumption instead — add `--assumed` to the same command. That's allowed,
but it gets stamped onto every test that depends on it, and shows up later in
the report as "this test rests on an assumption, not a confirmed answer" — so
use it sparingly, and flag it to your lead.

### Step 6 — Validate everything

```bash
npm run validate
```

This checks every intent and mission on disk — schema errors are fatal (must
fix), warnings are things worth a second look but won't stop you. Fix
anything red before moving on.

### Step 7 — GATE 1: approve the intent

```bash
npm run approve-intent -- LG-002 --by "your name" --minutes 3
```

`--minutes` is how long the review actually took you — write down the real
number, it's one of the things your lead tracks over time.

**This will refuse** if the intent depends on a question you haven't answered
yet (back to Step 5), or if it fails validation. That refusal is correct
behavior, not a bug — read the message, it tells you exactly what to do.

### Step 8 — Bind it to the real page

Only do this once a front end actually exists and you've run `npm run
inspect` against it (Step 3).

```bash
npm run bind -- --feature login --write
```

This reads every approved intent and the most recent page capture, and tries
to match "submit credentials" to an actual button. It writes:

- draft missions, for whatever it managed to bind
- a **reconciliation report** in `reports/` — read this. It's split into three
  parts: things that bound cleanly, things it needs you to look at, and
  things it couldn't bind at all (which is itself useful information — maybe
  the feature isn't built yet, maybe a button got renamed).

Leave off `--write` first if you just want to see the reconciliation without
touching `missions/draft/` yet.

### Step 9 — GATE 1.5: approve the binding

```bash
npm run approve -- LG-002 --by "your name" --minutes 2
```

If the binder had to guess at anything (an ambiguous button, no stated exact
error text), this **refuses** and shows you exactly what it couldn't settle,
plus what the page actually offers as candidates. Read it, then either fix the
mission by hand or accept it as-is:

```bash
npm run approve -- LG-002 --by "your name" --minutes 4 --reviewed
```

`--reviewed` means "I read the list above and I'm okay with it." Don't add it
reflexively — that defeats the point of the gate.

### Step 10 — Run it

```bash
npm run run-mission -- --feature login LG-002
```

Leave off the test id to run every approved mission for that feature. Add
`--headless` if you don't need to watch the browser (faster, no window pops
up):

```bash
npm run run-mission -- --feature login --headless
```

You'll see live output in the terminal, then a result: `PASS`, `FAIL`,
`BLOCKED`, or `INCONCLUSIVE`. Read §8 below before you panic at a non-PASS —
two of those four are *supposed* to happen sometimes.

### Step 11 — Read the report

```bash
npm run report
```

Writes a Markdown file to `reports/smoke-<timestamp>.md`. Every failure in it
has: the requirement it came from, expected vs. actual, the classifier's
opinion on why it failed, and every evidence file (screenshot, execution log,
Playwright trace, accessibility snapshot). You don't need to re-run anything
to see what happened — it's all in there.

### Step 12 — Turn real failures into tickets

```bash
npm run defects
```

Scans every run and produces one paste-ready report per distinct problem
(re-runs of the same bug get merged into one, not duplicated). List what's
waiting:

```bash
npm run defects -- --list
npm run defects -- --show <fingerprint>
```

**Nothing is filed anywhere automatically.** You read each one and decide:

```bash
npm run defects -- --confirm <fingerprint> --by "your name" --ticket "JIRA-123"
npm run defects -- --reject  <fingerprint> --by "your name" --note "this is expected — see requirement R-3"
```

Confirmed ones are exactly what you paste into your tracker. Rejected ones
are kept, not deleted — so the same non-issue doesn't get raised again next
run.

### Step 13 — (Optional but valuable) look beyond the test cases

```bash
npm run explore -- --feature login
```

This walks the real page hunting for things nobody wrote a test for — broken
images, unlabelled form fields, dead links, what happens if you type garbage
into a field. It never changes any test's PASS/FAIL — it's a separate list of
observations for a human to judge. Turn the real ones into tickets the same
way:

```bash
npm run defects -- --from-exploration --feature login
```

### Step 14 — See the numbers

```bash
npm run metrics
```

One table per feature: how many gaps you found, Gate 2/1.5 review time, how
often the binder needed you, PASS/FAIL/BLOCKED/INCONCLUSIVE counts, the
false-defect rate at Gate 3. Your lead uses this to compare features against
each other — it's worth running after every feature, not just at the end.

### Step 15 — (Later) promote a proven mission to a permanent fast test

Once a mission has passed the same way a couple of times in a row and is
unlikely to change soon, it can be frozen into a real Playwright test that
runs in milliseconds with no model involved at all:

```bash
npm run promote                                       # see what's eligible
npm run promote -- --promote LG-002 --by "your name"
npm run regression                                     # run the frozen suite
```

You won't need this in your first week — your lead will tell you when a
feature is stable enough for it.

---

## 3. Quick command reference

| I want to... | Command |
|---|---|
| Start a brand-new feature | `npm run new-feature -- --name <x> --url <url> --prefix <XX>` |
| Look at the real app before testing it | `npm run inspect -- --feature <x>` |
| Build the pack for the Thinker Agent | `npm run think -- --feature <x> --prefix <XX> --copy` |
| File what the model gave back (browser route) | `npm run import -- --from reply.md --feature <x>` |
| See/answer the open questions | `npm run clarify -- --feature <x>` / `... --answer Q-1 --text "..." --by "you"` |
| Check everything is valid | `npm run validate` |
| Approve an intent (Gate 2) | `npm run approve-intent -- <ID> --by "you" --minutes <n>` |
| Bind intents to the real page | `npm run bind -- --feature <x> --write` |
| Approve a mission (Gate 2.5) | `npm run approve -- <ID> --by "you" --minutes <n> [--reviewed]` |
| Run a mission | `npm run run-mission -- --feature <x> [<ID>] [--headless]` |
| Read what happened | `npm run report` |
| Turn a failure into a ticket | `npm run defects` → `--list` → `--show <fp>` → `--confirm/--reject` |
| Hunt for bugs no test describes | `npm run explore -- --feature <x>` |
| See what's covered / not | `npm run coverage -- --prefix <XX>` |
| See the numbers across features | `npm run metrics` |
| Seed a login session for a role | `npm run auth -- --role <role> --feature <x>` |
| Freeze a proven mission | `npm run promote -- --promote <ID> --by "you"` |

Every command's own `--help`-style usage is at the top of its file in
`scripts/` if you forget an option — read it, it's written for exactly this.

---

## 4. Where everything lives

```text
input/feature-<x>/requirement.md      the requirement, in your own words or pasted
input/feature-<x>/clarifications.yaml the question-and-answer ledger
knowledge/application-context-<x>.yaml what the app looks like: pages, roles, rules
intents/draft/ , intents/approved/     UI-free tests, before and after Gate 2
missions/draft/ , missions/approved/   tests bound to real controls, before/after Gate 2.5
runs/<ID>/<timestamp>/                 every execution's raw evidence
reports/smoke-*.md                     the human-readable run report
reports/defects/                       one file per confirmed/rejected bug
reports/reconciliation-*.md            what the binder could and couldn't match
tests/generated/*.spec.ts              frozen, permanent Playwright tests (Step 15)
```

**None of the above gets committed to git by you.** It's working data — see
§0.

---

## 5. The three gates, plainly

| Gate | Command | What it's actually checking |
|---|---|---|
| **Gate 2** | `approve-intent` | Does this test rest on any unanswered question? Is it otherwise well-formed? |
| **Gate 2.5** | `approve` | Did binding this intent to the real page require a guess? If so, is the guess acceptable? |
| **Gate 3** | `defects --confirm/--reject` | Is this actually a product bug, or an environment/test problem? |

Every one of these can say no. That's not the tool being broken — a refusal
at Gate 2 means a real gap in the requirement got caught before anyone wasted
time testing a guess; a refusal at Gate 2.5 means an ambiguous page control
got caught before it silently tested the wrong thing.

---

## 6. Reading a result without panicking

- **PASS** — the mission ran and every assertion held. Good.
- **FAIL** — something the mission checked for did not hold. Read the report
  (Step 11) — it tells you exactly which assertion, what was expected, what
  was actually there, and gives you the evidence to look at yourself.
- **BLOCKED** — the mission couldn't even get started properly (wrong URL,
  missing test data, a required login session that hasn't been recorded).
  This is almost always an environment problem, not a product bug. Check
  `.env`'s `BASE_URL`, or whether `npm run auth --check --feature <x>` says a
  role needs a session.
- **INCONCLUSIVE** — the system genuinely can't tell you the answer (e.g. a
  first run failed and the deterministic replay disagreed with it). This is
  the system declining to guess rather than reporting something unreliable as
  a fact. It's meant to happen sometimes — a report with zero INCONCLUSIVE
  results ever is more suspicious than one with a few.

---

## 7. If you get stuck

- Run the command with no arguments — most of them print exactly what's
  missing and the command to fix it.
- `npm run validate` first, always, if anything seems off — it catches most
  mistakes before they reach a gate.
- Ask your lead before you `git` anything, and before you assume a refusal is
  a bug rather than the gate doing its job.
