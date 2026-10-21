# Thorough Test Generation Guide

This guide controls the depth of the Thinker Agent output. A checklist pass is
not enough: a category with one shallow mission does not prove the requirement
is covered.

## Minimum suite size

Every requirement must produce at least **25 meaningful test cases** across its
user stories and acceptance criteria. This is a floor, not a reason to create
duplicates: if fewer than 25 distinct cases are justified, record the reason
in the analysis and add manual or exploratory cases for the remaining risks.
After generation, run `npm run test-cases` so the complete suite is also
available as one consolidated Markdown catalog.

## Required decomposition

For every user story, acceptance criterion, and named business rule:

1. Create at least one traceable scenario. The scenario must cite the exact
   requirement sentence in `requirement_ref`.
2. Add a positive scenario for the normal successful path.
3. Add a negative scenario where invalid, missing, empty, duplicate, or refused
   input is relevant. Use `expected_outcome: "blocked"` only when refusal is the
   expected behavior.
4. Add a boundary or state-transition scenario where relevant: empty state,
   first item, last item, refresh, back navigation, repeated action, quantity
   change, calculation boundary, or submission state.
5. Add a data-integrity scenario when state crosses a page, refresh, filter,
   sort, or checkout boundary.
6. Add a navigation scenario for every important destination and return path.
7. Add a responsive scenario for requirements mentioning mobile, tablet,
   desktop, overlap, clipping, or accessibility. Mark it manual when the
   executor cannot control viewports.
8. Add a manual scenario for API, cross-browser, visual appearance, database,
   or server-failure behavior when that risk matters but the executor cannot
   verify it.

## Test design techniques: mandatory, and shown

Coverage comes from technique, not from volume. For every input, rule and
workflow in the requirement, apply the technique that fits and record it in
the analysis (section "Test design"):

| Technique | Use it for | What it produces |
|---|---|---|
| **Equivalence partitioning** | Any input with valid and invalid classes (email, quantity, country) | One row per class: a valid representative and each invalid class |
| **Boundary value analysis** | Any stated limit (length 8–64, quantity 1–10, date ranges, prices) | min-1, min, max, max+1 (and min+1 / max-1 where cheap) |
| **Decision table** | Rules that combine conditions (discount if member AND total > 100) | One row per combination that changes the outcome |
| **State transition** | Anything with statuses (order: placed → paid → shipped → cancelled) | Each valid transition, and the invalid ones that must be refused |
| **Pairwise** | Several independent options (size × colour × delivery) | The smallest set of rows covering every pair, not every combination |
| **Error guessing** | Where bugs usually live | Empty, whitespace only, very long, special characters, duplicates, double submit, back button, refresh mid-flow |

**Write these as ONE data-driven intent with `examples`, not as many intents.**
"Password must be 8 to 64 characters" is one intent with four rows:

```json
"steps": [{ "id": "S1", "actor_intent": "Enter {data.password} as the new password and submit" }],
"outcomes": [
  { "id": "O1", "statement": "The password is accepted", "observable": "message_shown" },
  { "id": "O2", "statement": "The user is told the password must be 8 to 64 characters", "observable": "message_shown" }
],
"examples": [
  { "name": "min-1 (7 chars)",  "data": { "password": "Abcdef1" },  "expected_outcome": "blocked",  "outcome_ids": ["O2"], "note": "BVA: below minimum" },
  { "name": "min (8 chars)",    "data": { "password": "Abcdef12" }, "expected_outcome": "succeeds", "outcome_ids": ["O1"], "note": "BVA: minimum" },
  { "name": "max (64 chars)",   "data": { "password": "<64 chars>" }, "expected_outcome": "succeeds", "outcome_ids": ["O1"], "note": "BVA: maximum" },
  { "name": "max+1 (65 chars)", "data": { "password": "<65 chars>" }, "expected_outcome": "blocked",  "outcome_ids": ["O2"], "note": "BVA: above maximum" }
]
```

Write real values, never placeholders: count the characters. Each row runs
separately, with its own verdict, and the sheet shows "Fail (1 of 4 examples)"
when one boundary is wrong. Never invent a limit the requirement does not
state: a missing limit is a question for the analysis.

## Depth rules

- Split a large flow into bounded missions with one objective each. A complete
  purchase may need separate missions for product selection, cart calculation,
  checkout validation, submission state, and confirmation.
- Do not collapse multiple acceptance criteria into one assertion merely to
  reduce the mission count.
- Do not create duplicate missions that differ only in wording. Each scenario
  must vary the state, input, risk, expected outcome, or evidence needed.
- Prefer a small set of meaningful scenarios per criterion over a fixed arbitrary
  number. For a complex story, 4-8 missions is normal; for a simple criterion,
  one is enough.
- Use sweep missions for properties across a collection, such as every product
  image, every required control, every category, or every navigation link.
- Every mission needs a machine-checkable assertion. If the executor cannot
  check it, create a manual mission and explain why.
- Before finishing, audit the generated set against the requirement line by
  line and the full coverage checklist. The set is incomplete if any criterion
  has no scenario or any checklist category has no mission, intent, or explicit
  not-applicable decision.

## Required final audit in the analysis

Include a table with:

- requirement sentence or acceptance criterion
- mission IDs covering it
- scenario kind: positive, negative, boundary, state, navigation, exploratory,
  or manual
- automation status
- uncovered risk or reason it does not apply

Then run:

```powershell
npm run validate
npm run test-cases
npm run coverage -- --check --drafts
```

Do not request Gate 2 approval while either command reports a blocking failure.
