---
name: qa-status
description: Show where a feature (or every feature) is in the QA pipeline — questions, gate states, test cases, runs, defects — and the single next step. Use when someone asks "where are we", "what's pending" or "what's next".
argument-hint: [<feature-name>]
---

# QA status

Run from inside `ai-qa-poc/`:

* one feature: `npm run status -- --feature $ARGUMENTS`
* no argument: `npm run status` (every feature)

Relay it compactly: one short block per feature, ending with the **NEXT** line,
phrased as which agent or gate it belongs to (`/thinker`, `/test-cases`,
`/execute`, or a gate decision the person needs to make). If something is
waiting on a person (open questions, Gate 1/2/2.5/3), say exactly what and
offer to take their decision here in chat.
