---
name: execute
description: Execution Agent — connect approved test cases to the running build (inspect, bind, verify), run them in Chromium with full evidence, summarise results, and record Gate 2.5 and Gate 3 decisions given in chat. Use when a build/URL is ready, or someone asks to run tests or review defects.
argument-hint: <feature-name> [<test-id> ...]
---

# Execution Agent

Input: `$ARGUMENTS`

Work from inside `ai-qa-poc/`. Follow the gate rules in the root `CLAUDE.md`.

1. **Check readiness:** `npm run status -- --feature <f>`.
   * No approved test cases → Gate 2 is not done; point to `/test-cases`.
   * Build URL not set → ask for the STAGE URL and set `BASE_URL` in `ai-qa-poc/.env`
     (or `base_url` in `knowledge/application-context-<f>.yaml`). Never commit it.

2. **Sessions:** `npm run auth -- --check --feature <f>`. For a missing role, tell
   the person to run `npm run auth -- --role <role> --feature <f>` themselves.
   It opens a browser where *they* sign in. Never handle passwords.

3. **Connect to the app** (only when new test cases were approved or the UI changed):
   `npm run inspect -- --feature <f>` → `npm run bind -- --feature <f> --write`
   → `npm run verify -- --feature <f>`.
   Summarise `reports/reconciliation-<f>-*.md`: clean bindings, and each exception
   with what the page offers.

4. **Gate 2.5.** Only on the person's explicit decision per mission:
   `npm run approve -- <ID> --by "<name>"` for a clean one; for one with
   exceptions, only after they have seen the exceptions: `--reviewed`.

5. **Run in the background:** `npm run execution-agent -- --feature <f>`
   (or specific ids) with `run_in_background`. Options when asked:
   `--headless`, `--viewport mobile|tablet|desktop`, `--browser firefox|webkit`,
   `--no-explore` (skip the exploration that runs at the end), `--regression` (only the
   tests guarding confirmed defects).
   For access control: `npm run access-matrix -- --feature <f>` (rules under
   `access:` in the app context).

6. **Present the result**, in this order: what did NOT run (and why), then
   PASS / FAIL / BLOCKED / INCONCLUSIVE counts, then each non-PASS test in one or
   two lines (expected vs actual, proposed cause), then the automatic findings
   grouped by kind (API, layout, accessibility, visual, security, performance,
   exploration), then healing proposals if any. For a visual change, offer the
   baseline approval only if the person says the change is intended:
   `npm run visual -- --approve <ID> --by "<name>"`.
   Link `reports/EXECUTION-REPORT-<f>.html` and `reports/DEFECT-REVIEW.html`.
   BLOCKED and INCONCLUSIVE are investigations, not defects.

7. **Gate 3.** List the defect candidates (`npm run defects -- --list`) with
   fingerprint, severity and title. Only on the person's explicit decision:
   * confirm: `npm run defects -- --confirm <fp> --by "<name>" --note "<their note>"`
   * reject: `npm run defects -- --reject <fp> --by "<name>" --note "<why>"`
   * after **they** post it to Jira: `npm run defects -- --confirm <fp> --by "<name>" --ticket <KEY>`
   Confirming makes the defect a permanent test (regression list, or a proposed
   draft regression test case): relay what the command says, and route a
   proposed test case to `/test-cases` for Gate 2.
   Never post to Jira yourself. Point them to the Copy buttons on the review page.

8. Healing proposals (`reports/HEALING-<f>.md`) are applied only on the person's
   word: `npm run heal -- --feature <f> --apply H-1 --by "<name>"`.
