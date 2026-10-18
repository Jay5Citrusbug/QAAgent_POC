---
name: test-cases
description: Test Case Agent — generate test cases in the team's sheet format from a Gate-1-approved analysis, apply Gate 2 rework requests, and record Gate 2 approve/reject/rework decisions given in chat. Use when someone asks to write, regenerate, review or approve test cases for a feature.
argument-hint: <feature-name>
---

# Test Case Agent

Feature: `$ARGUMENTS`

Work from inside `ai-qa-poc/`. Follow the gate rules in the root `CLAUDE.md`.

1. **Check readiness:** `npm run status -- --feature <f>`. If Gate 1 is not
   approved or questions are open, say what is missing and stop: that is
   `/thinker` work.

2. **Run the agent in the background:** `npm run test-case-agent -- --feature <f>`
   with `run_in_background`. It takes several minutes. It writes new cases,
   rewrites cases with open rework requests, and never touches approved or
   rejected ones.

3. **Run the checks:**
   `npm run verify -- --feature <f>` and `npm run coverage -- --check --drafts`.

4. **Present the result:**
   * counts: new, reworked, skipped, schema failures
   * a compact table of draft cases: ID · title · AC ref · type · priority.
     Read them from `reports/TEST-CASES-<f>.csv`, or from `intents/draft/*.json` for detail.
   * verify / coverage problems and lint warnings, briefly
   * **new questions** the agent raised. These make Gate 1 stale; route them back to `/thinker`.
   * how to decide: here in chat, or in the sheet `reports/TEST-CASES-<f>.csv`
     (Gate 2 Decision column, then `npm run approve-sheet -- --feature <f> --by "<name>"`)

5. **Gate 2 decisions in chat.** Act only on decisions the person states, item by item:
   * "approve LG-001 to LG-010" → `npm run decide -- --by "<name>" --approve LG-001..LG-010 --minutes <n>`
   * "reject LG-011, duplicate of LG-002" → `npm run decide -- --by "<name>" --reject LG-011 --reason "Duplicate of LG-002"`
   * "LG-012 should use 3 attempts" → `npm run decide -- --by "<name>" --rework LG-012 --request "Use 3 failed attempts"`
   One decision kind per command. Report refusals with their reason (e.g. an
   unanswered question). After rework, offer to run this agent again.

6. When every case is decided, run `npm run status -- --feature <f>` and say what
   is next: usually waiting for the build URL, then `/execute`.
