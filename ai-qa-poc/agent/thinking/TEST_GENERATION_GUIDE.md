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
