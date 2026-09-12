# QA Coverage Checklist

The categories every generated mission set is measured against. The Thinking
Agent must consider **all** of them for a feature and say explicitly which ones
do not apply and why — silence is not the same as "not applicable", and an
unconsidered category is how bugs escape.

Each category carries an **execution capability** rating, because proposing a
test case is not the same as being able to run it. The Execution Agent today is
a Chromium browser driver with no API client, no database access, and no visual
comparison. A mission in a `manual` category is still worth generating — a human
runs it — but calling it automated coverage would be a lie that hides risk.

| Key | Category | Executable today | Why |
|---|---|---|---|
| `requirement_based` | Traceable to a stated requirement | ✅ automated | Every mission should carry `requirement_ref` |
| `functional` | Core behaviour works | ✅ automated | Click, fill, submit, verify |
| `negative` | Invalid input is refused | ✅ automated | Use `expected_outcome: "blocked"` |
| `input_validation` | Valid / invalid / boundary inputs | ✅ automated | Field-level checks and error messages |
| `navigation` | Links, buttons, transitions, no dead ends | ✅ automated | URL and visibility assertions |
| `edge_case` | Long text, large files, unusual states | ⚠️ partial | Long text and odd input yes; network loss and session expiry no |
| `ui_ux` | Alignment, spacing, layout, consistency | ⚠️ partial | Structure and presence yes; **visual defects no** (see below) |
| `data_integrity` | Data consistent after refresh, sort, filter | ⚠️ partial | UI-visible state yes; **database truth no** |
| `error_handling` | Failures degrade gracefully | ⚠️ partial | UI error messages yes; **inducing server failure no** |
| `security` | Auth, access control, session | ⚠️ partial | Direct-URL access control yes; session expiry and masking partly |
| `api` | Status codes, payloads, contracts | ❌ manual | No HTTP client in the executor |
| `integration` | Frontend matches backend | ❌ manual | Needs API + UI in one assertion |
| `compatibility` | Cross-browser | ❌ manual | POC-1 is Chromium only |
| `responsive` | Mobile, tablet, desktop | ❌ manual | No viewport matrix yet |

## The visual blind spot — state it, do not paper over it

DOM assertions cannot see a **white icon on a white background**. On the
practice site the carousel arrows are exactly that: the `<svg>` exists, the
`<path>` exists, the button is visible, and the accessible name is correct.
Every fact a browser automation can read is right, and the control is invisible
to a human.

So a `ui_ux` mission may only claim what it can actually check — an element is
present, has the right text, is in the right container. Anything about how it
*looks* belongs in a manual mission, or waits for visual review.

## Sweeps beat per-element missions for whole classes

Some categories are better served by one mission checking a property across
every element than by many missions naming elements one at a time:

* every image loads → `all_images_loaded`
* every control is labelled → `all_controls_have_accessible_name`

A sweep keeps covering elements added next week that nobody wrote a mission
for. Prefer one where the category is a property rather than a behaviour.

## What "good coverage" means here

Not "a mission in every category". It means:

1. Every **automatable** category that applies has at least one mission.
2. Every category that does **not** apply is named, with the reason.
3. Every category that applies but **cannot be automated** is listed as manual
   work for a human, so it is scheduled rather than forgotten.

A mission set that quietly omits `security` reads identically to one where
security was considered and ruled out. The third point is what makes the
difference visible.
