# QA Coverage Checklist

The categories every generated mission set is measured against. The Thinking
Agent must consider **all** of them for a feature and say explicitly which ones
do not apply and why — silence is not the same as "not applicable", and an
unconsidered category is how bugs escape.

Each category carries an **execution capability** rating, because proposing a
test case is not the same as being able to run it. The Execution Agent today is
a Chromium browser driver with no API client, no database access, and no visual
comparison of its own (API checks read the XHR/fetch calls the UI makes). A mission in a `manual` category is still worth generating — a human
runs it — but calling it automated coverage would be a lie that hides risk.

| Key | Category | Executable today | Why |
|---|---|---|---|
| `requirement_based` | Traceable to a stated requirement | ✅ automated | Every mission should carry `requirement_ref` |
| `functional` | Core behaviour works | ✅ automated | Click, fill, submit, verify |
| `negative` | Invalid input is refused | ✅ automated | Use `expected_outcome: "blocked"` |
| `input_validation` | Valid / invalid / boundary inputs | ✅ automated | Field-level checks and error messages |
| `navigation` | Links, buttons, transitions, no dead ends | ✅ automated | URL and visibility assertions |
| `edge_case` | Long text, large files, unusual states | ✅ automated | Long text, odd input, network loss and slow responses (`fault`), session expiry (`simulate: "session_expired"`) |
| `ui_ux` | Alignment, spacing, layout, consistency | ⚠️ partial | Structure and presence by DOM; visual changes by screenshot vs an approved baseline (`looks_like_baseline`, and every run); design judgement no |
| `data_integrity` | Data consistent after refresh, sort, filter | ⚠️ partial | UI state, and the stored record read back through the API (`steps[].api` GET); **direct database queries no** |
| `error_handling` | Failures degrade gracefully | ✅ automated | Any API call can be made to fail (`fault`: server_error, not_found, timeout, offline, slow); the test checks what the user is told |
| `security` | Auth, access control, session | ⚠️ partial | Role × page access matrix (`access:` in the app context, `npm run access-matrix`), session expiry, passive checks on every run (cookie flags, security headers, secrets in URLs, mixed content); active attack testing no |
| `api` | Status codes, payloads, contracts | ✅ automated | Calls the UI makes, and direct calls (`steps[].api`): status, body text, JSON fields (`observable: "api_response"`) |
| `integration` | Frontend matches backend | ✅ automated | `observable: "ui_matches_api"` compares what an element shows with an API field; create via API and check in the UI, or the reverse |
| `compatibility` | Cross-browser | ✅ automated | Chromium, Firefox and WebKit (Safari's engine): `browser` on the intent, or the whole run with `--browser` |
| `performance` | Page speed for one user | ⚠️ partial | TTFB, LCP, CLS and load on every run, and `performance_budget` ("loads within 3 seconds"); load testing (many users) no |
| `accessibility` | WCAG A/AA: contrast, names, labels, ARIA, structure | ⚠️ partial | axe-core rules via the `accessible` check, and on every run; keyboard-only use and focus order still need a person |
| `responsive` | Mobile, tablet, desktop | ✅ automated | `viewport` on the intent; the `layout_sound` check finds sideways scroll, cut-off and covered controls, small tap targets |

## The visual blind spot — state it, do not paper over it

DOM assertions cannot see a **white icon on a white background**. On the
practice site the carousel arrows are exactly that: the `<svg>` exists, the
`<path>` exists, the button is visible, and the accessible name is correct.
Every fact a browser automation can read is right, and the control is invisible
to a human.

So a `ui_ux` mission checks structure through the DOM, and *appearance* through
the screenshot comparison: every run compares the page with the baseline a
person approved, and reports what changed and where (the white-on-white icon
is caught this way). A page that must not drift at all gets an outcome like
"the header looks as approved", which binds to `looks_like_baseline`. Whether
a NEW design is right (on-brand, pleasing) is still a person's call.

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
