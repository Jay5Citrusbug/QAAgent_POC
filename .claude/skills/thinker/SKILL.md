---
name: thinker
description: Thinker Agent — import a user story (Jira key, exported file, or pasted text) and run requirement analysis to find gaps, ambiguities, risks and questions for the BA/PO. Use when someone shares a story to analyse or asks to run the Thinker Agent.
argument-hint: <feature-name> [<JIRA-KEY> | <path-to-story-file>] — or paste the story text after the feature name
---

# Thinker Agent

Input: `$ARGUMENTS`

Work from inside `ai-qa-poc/`. Follow the gate rules in the root `CLAUDE.md`.

1. **Work out the feature and the source.**
   * Feature name: lowercase, one word (e.g. `login`). Test ID prefix: 2–4
     capital letters (e.g. `LG`). If either is missing for a new feature, ask.
   * Source: a Jira key (`--jira KEY`, needs `JIRA_*` in `.env`), a file
     (`--from <path>`), or pasted text. For pasted text, save it unchanged
     to `input/stories/<feature>.txt` and use `--from`.
   * If the feature already has an imported story and nothing new was given,
     skip the import.

2. **Import:** `npm run story -- --feature <f> --prefix <XX> <--jira KEY | --from FILE>`.
   Read `input/feature-<f>/requirement.md` and confirm with the person how many
   acceptance criteria came through. If none did, say so: the agent will ask.

3. **Run the agent in the background:** `npm run thinker -- --feature <f>`
   with `run_in_background`. It takes several minutes. Tell the person it is running.
   If it says the analysis is already approved, report that and suggest `/test-cases`.

4. **Present the result** (don't paste the whole file):
   * the analysis file path, `thinking/analysis/<f>-<date>.md`
   * 2–3 lines on what the story covers and the top 3 risks
   * **every question**, as a numbered list with its Q-id, plus its "why" in one line

5. **Collect answers in chat.** When the person answers ("Q-1: locked for 15 min"),
   record each one in their words:
   `npm run clarify -- --feature <f> --answer Q-1 --text "<their answer>" --by "<name>"`
   Add `--assumed` only if they call it an assumption. `npm run clarify -- --feature <f> --open` lists what remains.

6. **Gate 1.** Only when the person explicitly approves the analysis:
   `npm run approve-analysis -- --feature <f> --by "<name>" --minutes <n>`.
   It refuses while questions are open; relay that. Then suggest `/test-cases <f>`.

If the run fails with "does not support this model", tell them to run
`claude update`, or set `THINKING_MODEL=opus` for now.
