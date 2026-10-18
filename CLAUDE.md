# QAgents — operating the QA platform from chat

This repo is an AI-assisted QA platform (`ai-qa-poc/`). People use it by
chatting with Claude Code here instead of typing npm commands. Run every
command from inside `ai-qa-poc/`. The full process is in
`ai-qa-poc/docs/USER-GUIDE.md`.

## The three agents

| Agent | Skill | Engine command | Does |
|---|---|---|---|
| **Thinker Agent** | `/thinker` | `npm run story`, `npm run thinker -- --feature X` | Story → analysis: gaps, ambiguities, risks, questions for the BA/PO |
| **Test Case Agent** | `/test-cases` | `npm run test-case-agent -- --feature X` | Approved analysis → test cases in the team's sheet format |
| **Execution Agent** | `/execute` | `inspect`, `bind`, `execution-agent` | Approved test cases → runs in Chromium → evidence, results, defect candidates |

`/qa-status <feature>` (`npm run status -- --feature X`) says where a feature
is and what is next. Use it whenever someone asks "where are we".

The Thinker and Test Case agents call Claude Code headless and take several
minutes. **Run them with `run_in_background`** and wait for the completion
notification; never block a foreground call on them.

## The gates are human decisions

| Gate | Decision | Command it maps to |
|---|---|---|
| Gate 1 | answer questions, approve the analysis | `npm run clarify -- --feature X --answer Q-n --text "..." --by "<name>" [--assumed]` · `npm run approve-analysis -- --feature X --by "<name>" --minutes N` |
| Gate 2 | approve / reject / rework test cases | `npm run decide -- --by "<name>" --approve ID ID ID..ID [--minutes N]` · `--reject ID --reason "..."` · `--rework ID --request "..."` · or the sheet: `npm run approve-sheet -- --feature X --by "<name>"` |
| Gate 2.5 | approve bound missions | `npm run approve -- ID --by "<name>" [--reviewed]` |
| Gate 3 | confirm / reject defects, record Jira key | `npm run defects -- --confirm FP --by "<name>" [--note "..."] [--ticket KEY]` · `--reject FP --by "<name>" --note "..."` |

Rules. These are not negotiable, whoever asks:

1. **Record a gate decision only when the person states it in their own
   message**, naming what is decided ("approve LG-001 to LG-010", "reject
   LG-011, duplicate", "approve the analysis"). "All" is fine when it refers
   to a list you have just shown them ("approve all 6 clean missions"): repeat
   the ids back as you run it. Never infer a decision, never decide one
   yourself, never widen "all" beyond what was shown. If a request is ambiguous
   ("looks good"), ask which items it covers before running anything.
2. **`--by` is the person's own name**, never "Claude". Ask once per
   conversation which name to record (suggest `git config user.name`), then reuse it.
3. **Answers to questions come from the person.** Record their words with
   `clarify`. Use `--assumed` only when they say it is an assumption.
4. **Reject needs a reason and rework needs a request.** Ask for them if missing.
5. **Ask for review minutes** at each gate (`--minutes`). They are the time-saved
   evidence; if the person declines, run without.
6. **Never post anything to Jira.** Gate 3 produces `reports/DEFECT-REVIEW.html`;
   the person posts by hand and tells you the key.
7. **When a command refuses** (open questions, stale gate, schema errors), show
   the reason and the fix. Never work around a refusal (no `--skip-verify`, no
   editing approval stamps, no hand-moving files between `draft/` and `approved/`).

## Presenting results in chat

Summarise; don't paste raw files. After each agent:

* **Thinker:** two or three lines on the story, the top risks, then the
  questions as a numbered list with their Q-ids so they can be answered inline.
* **Test Case Agent:** counts, then a compact table (ID · title · AC ·
  type · priority), then lint warnings and any new questions. Offer chat
  decisions or the sheet (`ai-qa-poc/reports/TEST-CASES-<feature>.csv`).
* **Execution:** what did NOT run first, then PASS/FAIL/BLOCKED/INCONCLUSIVE
  counts, then each failure in a line or two, then the defect candidates.
  Link `reports/EXECUTION-REPORT-<feature>.html` and `reports/DEFECT-REVIEW.html`.

## Repository rules

* Never commit or push without the person's approval.
* Generated data is never committed: `intents/`, `missions/`, `runs/`, `reports/`,
  `thinking/`, `input/feature-*/`, `knowledge/captures/`. Only engine code and docs.
* Runtime AI is Claude Code on the subscription only. No API keys, no other LLMs.
* `ai-qa-poc/web/` is on hold. Don't use it to run the pipeline.
