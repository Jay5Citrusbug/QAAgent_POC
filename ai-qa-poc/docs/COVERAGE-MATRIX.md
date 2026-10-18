# Coverage Matrix

What the platform tests today, what it does partly, and what it does not do
yet. Updated each time a capability lands. The Test Case Agent reads the same
ratings from `agent/thinking/COVERAGE_CHECKLIST.md`, so the two must agree.

**✅ Yes**: tested automatically · **⚠️ Partial**: some of it automatically,
the rest is written as manual test cases · **❌ No**: manual test cases only

*Last updated: 2026-10-18, after Step 9 (exploration on every run). All planned steps done.*

---

## 1. Testing types (designed test cases)

| Testing type | Status | What runs automatically | Still manual / missing | Closes it |
|---|---|---|---|---|
| Requirement-based | ✅ | Every test cites its acceptance criterion; `verify` checks the quote is real | — | — |
| Functional | ✅ | Click, fill, submit, verify outcome | — | — |
| Negative | ✅ | Refusals checked: the action is blocked, and the user is told | — | — |
| Input validation | ✅ | Field errors, boundary values, required fields | Very large files | — |
| Navigation | ✅ | Destinations, links, return paths | — | — |
| **API** | ✅ | Calls the UI makes **and direct calls with no UI**: status code, body text, JSON fields | Auth by token header (cookie sessions only today) | — |
| **Integration** | ✅ | **What the screen shows compared with the API value; create via API → check UI; act in UI → read back via API** | — | — |
| **Edge cases** | ✅ | Long text, unusual input, repeated actions, refresh, network loss, slow responses, **session expiry mid-flow** | Very large file uploads | — |
| **Error handling** | ✅ | **Any API call made to fail on purpose (500, 404, timeout, offline, slow); the test checks what the user is told and that nothing hangs** | — | — |
| Data integrity | ⚠️ | Data visible after refresh, sort, filter; **stored record read back through the API** | Direct database queries | — |
| **Security** | ⚠️ | **Every role × every protected page (leaks and wrong refusals); session expiry; passive checks on every run: cookie flags, security headers, secrets in URLs, mixed content** | Active attack testing (SQL injection, XSS fuzzing): use a dedicated scanner (OWASP ZAP) | — |
| **UI/UX** | ✅ | Elements present, right text, right place; **how every page looks, compared with a person-approved baseline (catches white-on-white, missing icons, broken styling)** | Judging a new design (on-brand, pleasing) is a person's call | — |
| **Responsive** | ✅ | **Any test at mobile, tablet or desktop size (per test, or `--viewport` for the whole run); layout check for sideways scroll, cut-off and covered controls, small tap targets** | Real device emulation (touch events, mobile user agent) | — |
| **Compatibility** | ✅ | **Chromium, Firefox and WebKit (Safari's engine): per test case, or the whole run with `--browser`** | Real devices, old browser versions | — |
| **Accessibility** | ⚠️ | **WCAG 2.0/2.1/2.2 A and AA rules via axe-core: contrast, alt text, form labels, page language, ARIA, structure, on every run and as a check** | Keyboard-only use, focus order, meaningful alt text (manual test cases) | — |
| **Performance** | ⚠️ | **Every run: server response (TTFB), main content (LCP), layout shift (CLS), full load against Core Web Vitals; budgets per test ("loads within 3 s"); slow API calls** | Load testing (many users at once): a dedicated tool such as k6 or JMeter | — |

## 2. Automatic bug detection (no test case needed)

These run during every test and are reported as a **separate bug list**. They
never change a test's PASS/FAIL.

| Detector | Status | Catches |
|---|---|---|
| Console errors | ✅ | JavaScript errors logged by the page |
| Page crashes | ✅ | Uncaught exceptions in the running app |
| HTTP errors | ✅ | 4xx/5xx responses, with the URL |
| Failed requests | ✅ | Calls that never got a response |
| Broken images | ✅ | Images that loaded no pixels |
| Unlabelled controls | ✅ | Buttons and fields screen readers cannot name |
| **Hidden API errors** | ✅ *new* | A 200 response whose body says `error`, `success: false`, `status: "failed"` |
| **Broken JSON** | ✅ *new* | Responses that claim JSON but do not parse |
| **Slow API calls** | ✅ *new* | Calls over 3 s (`API_SLOW_MS` to change) |
| **Page scrolls sideways** | ✅ *new* | The page is wider than the screen, naming the element that causes it |
| **Controls cut off or covered** | ✅ *new* | A button or link off the screen edge, or under a banner or overlay |
| **Small tap targets** | ✅ *new* | Controls under 24×24px on touch-size screens (WCAG 2.5.8) |
| **Slow pages** | ✅ *new* | TTFB, LCP, CLS or load over Core Web Vitals limits (`PERF_*_MS` to change, `PERF=off` to skip) |
| **Insecure session cookies** | ✅ *new* | Session cookies readable by scripts, sent without Secure, or without SameSite |
| **Missing security headers** | ✅ *new* | Clickjacking protection, CSP, nosniff, HSTS (on HTTPS); once per site |
| **Secrets in URLs** | ✅ *new* | Passwords, tokens, keys in query strings (value never recorded) |
| **Mixed content** | ✅ *new* | HTTP content on an HTTPS page |
| **Visual changes** | ✅ *new* | The page looks different from its approved baseline: pixels changed, where, and a diff image (`VISUAL=off` to skip) |
| **WCAG violations** | ✅ *new* | Every axe-core A/AA rule at moderate impact or worse, once per rule per page (`A11Y=off` to skip) |
| **Input probe** | ✅ | Empty, spaces, very long, special characters, Enter on every field of every listed page; observations, never verdicts. Every run (`--no-explore` to skip) |
| **Page sweeps** | ✅ | Every image loads, every control and field labelled, no duplicate names, no dead links, on every listed page. Every run |
| **Build diff** | ✅ | Controls renamed or removed, images newly broken, pages gone, between the last two `inspect` captures. Every run |

## 3. Roadmap

| Step | Capability | Moves | Status |
|---|---|---|---|
| 1 | API checks on the calls the UI makes, plus automatic API health | API ❌→⚠️, Integration ❌→⚠️ | ✅ **Done** (2026-10-18) |
| 2 | Simulated server failures (500, timeout, offline) | Error handling ⚠️→✅, Edge cases | ✅ **Done** (2026-10-18) |
| 3 | Screen sizes: mobile, tablet, desktop | Responsive ❌→✅ | ✅ **Done** (2026-10-18) |
| 4 | Accessibility rules with axe-core | Accessibility: rules automated, keyboard still manual | ✅ **Done** (2026-10-18) |
| 5 | Screenshot comparison between builds | UI/UX ⚠️→✅ | ✅ **Done** (2026-10-18) |
| 6 | Firefox and Safari engines | Compatibility ❌→✅ | ✅ **Done** (2026-10-18) |
| 7 | Role × page access matrix, session expiry, passive security | Security: access control and sessions automated; Edge cases ⚠️→✅ | ✅ **Done** (2026-10-18) |
| 8 | Page speed: Core Web Vitals and budgets | Performance: single-user speed automated | ✅ **Done** (2026-10-18) |
| 9 | Exploration (probe, sweeps, build diff) inside every `/execute` | Automatic detection ⚠️→✅ | ✅ **Done** (2026-10-18) |
| 1b | Direct API calls without the UI; UI-vs-API value checks | API, Integration ⚠️→✅ | ✅ **Done** (2026-10-18) |

---

## Changelog

**2026-10-18 · Step 9: exploration on every run**
- `run-mission` / `execution-agent` now ends by exploring every page listed in
  the application context: sweeps, the input probe and the build diff, in its
  own browser so it can never disturb a test. Its findings go straight to the
  defect review page; the full report is `reports/EXPLORATION-REPORT-<feature>.md`.
  `--no-explore` or `EXPLORE=off` skips it.
- Verified: from one trivial "home page shows" test, exploration found a dead
  link, an unlabelled field on a page the test never visited, and a broken
  image (merged with the run's own finding), all as Gate 3 candidates.

**2026-10-18 · Step 8: performance**
- Every run measures the page it ends on: server response (TTFB), main
  content (LCP), layout shift (CLS), full load; over Core Web Vitals limits it
  is a finding ("needs improvement" low, "poor" medium). `PERF_TTFB_MS`,
  `PERF_LCP_MS`, `PERF_CLS`, `PERF_LOAD_MS` adjust the limits for STAGE.
- New check `performance_budget`; the binder reads "loads within 3 seconds"
  (load) and "appears within 2.5 s" (LCP). New testing category `performance`.
- Verified on a slow page: 1.01 s server response and 0.135 layout shift
  flagged, a 2 s budget failed at 4.04 s, a fast page passed. Found and fixed
  during testing: engines without layout-shift support (Firefox, WebKit) were
  reporting CLS as 0; it is now "not measurable", and a budget that needs it is
  INCONCLUSIVE rather than a false pass.

**2026-10-18 · Step 7: security**
- `npm run access-matrix -- --feature X`: every role (seeded session, or
  anonymous) against every page listed under `access:` in the application
  context, each in a fresh browser context. Reports leaks (opened, must not)
  and wrong refusals, with screenshots, and files both as Gate 3 candidates.
  Denial is recognised by 401/403/404, a redirect to a sign-in page, or refusal
  text (configurable with `access_denied:`).
- New step `expire_session` (test cases: `"simulate": "session_expired"`):
  cookies and web storage cleared mid-flow, as a timeout would.
- Passive checks on every run: session cookies without HttpOnly/Secure/
  SameSite, missing security headers, secrets in URLs, mixed content.
- Verified on an app with planted bugs: the matrix found exactly the customer
  leak into /admin and the customer refused /orders, with the other 7 cells
  correct; an expired session was sent to sign-in; the token in a URL, the
  script-readable session cookie and 3 missing headers were all reported.
- Security stays ⚠️ on purpose: active attack testing is a different tool.

**2026-10-18 · Step 6: Firefox and Safari engines**
- Tests run in Chromium, Firefox or WebKit (Safari's engine): per test case
  (`browser`), or the whole run with `--browser firefox` / `--browser webkit`
  (`safari` accepted). One run can switch engines between tests.
- Every result records the engine and version; a defect lists every browser it
  reproduced in ("Firefox 155.0 + WebKit 26.6"), so a fix covers all of them.
  Visual baselines are kept per engine, since each renders differently.
- `npm run browsers:all` installs all three engines.
- Verified with a classic compatibility bug (a Chromium-only API): Chromium
  passed; Firefox and WebKit failed, each finding showing that engine's own
  error message, and the merged defect named both browsers.

**2026-10-18 · Step 5: visual comparison**
- Every test screenshots the page it ends on (animations frozen, caret hidden,
  `data-visual-ignore` elements masked) and compares it pixel by pixel with the
  baseline a person approved for that test and screen size.
- A difference is a finding with a diff image (changes in red), the number of
  changed pixels and where; not a FAIL, since most visual changes are intended.
  `looks_like_baseline` is the strict check for pages that must not drift.
- Baselines are approved by a person: `npm run visual -- --approve <ID> --by
  "<name>"` or `--approve-new`; `--list` shows the state. They live in
  `baselines/` (gitignored: generated per environment).
- Verified on the exact blind spot: a menu icon turned white on white. The DOM
  check still PASSED; the visual comparison reported "144 pixels changed in the
  area at 28,31 (24×18px)" (the icon) and the strict check FAILED. Same build
  again: 0 pixels, live clock masked. Found and fixed during testing: a
  percentage-only threshold missed the icon (0.01% of the page); changes now
  also count by absolute pixels (default 25, `VISUAL_MIN_PIXELS`).

**2026-10-18 · Step 4: accessibility**
- axe-core 4.14 (the standard open-source engine) runs WCAG 2.0/2.1/2.2 A and AA
  rules: as the `accessible` check (page or region; fails at a chosen impact,
  default serious), and on every test as a bug detector (moderate or worse, one
  finding per rule per page; `A11Y=off` skips it).
- New testing category `accessibility`, so the Test Case Agent plans for it on
  its own instead of folding it into UI/UX. It stays ⚠️: keyboard-only use,
  focus order and meaningful alt text need a person.
- Verified: a page with four planted bugs (low contrast, no alt text, no page
  language, unlabelled field) failed on all four, and all four appeared as
  findings; the clean page passed with zero. Found and fixed during testing:
  field-label rules were being suppressed on the wrong assumption that the
  older detector covered them; it only covers buttons and links.
- Note: `npm audit` reports one moderate issue in `fast-uri` (pulled in by the
  schema validator), unrelated to this step.

**2026-10-18 · Step 3: screen sizes**
- Tests run at `mobile` (390×844), `tablet` (820×1180), `desktop` (1440×900) or
  an exact size, set per test case (`viewport`) or for a whole run with
  `--viewport mobile`. The size is restored afterwards, since the browser is
  shared with the next test.
- New check `layout_sound`, and the same layout sweep on every test as a bug
  detector: sideways scroll (naming the element causing it), controls cut off
  at the edge, controls covered by another element, tap targets under 24×24px
  on touch-size screens. Carousels, inline text links and hidden elements are
  excluded on purpose.
- Verified on a page with planted mobile bugs: all three found (table forcing
  sideways scroll, cookie banner over Pay, 16px close button), none of the
  three decoys flagged; desktop clean; size restored for the next test;
  `--viewport tablet` applied to a whole run.
- Also synced the coverage gate (`coverage.ts`) with Steps 1, 1b and 2: API,
  Integration and Error handling now count as automatable there too.

**2026-10-18 · Step 1b: integration testing**
- New check `ui_matches_api`: compares what an element shows with a field of
  an API response. Numbers compare as numbers ("$1,299.00" = 1299, "Qty: 2" = 2),
  text by containment; lists and masked secrets are undecidable, never failed.
- New step `api_request`: calls an endpoint directly as the logged-in browser
  session, recorded with the page's own traffic so every API check and API
  health applies to it. `save` keeps response fields as `{saved.<name>}`, usable
  in any later URL, value, expected text or body.
- Test cases can have API steps (`steps[].api`) and `ui_matches_api` outcomes;
  the binder reads `METHOD /path`, path parameters and the backticked field.
- Verified on a local app: badge and price agreed with the API (formatting
  ignored); a badge bumped without the server was caught ("The UI shows 2 but
  the API says 1"); an order created via API was opened by its saved id and read
  back; a step using a value nobody saved came out INCONCLUSIVE, not a defect.

**2026-10-18 · Step 2: simulated server failures**
- New step `fail_requests`: makes matching API calls answer 500/404, time out,
  drop as if offline, or respond slowly, for the rest of that test. It is set
  up before the page opens, so calls made on page load are covered too.
- Test cases can carry a `fault` (`server_error`, `not_found`, `timeout`,
  `offline`, `slow`); the binder turns it into the first step. Without a named
  endpoint, Gate 2.5 picks the call.
- Injected failures are never reported as bugs: the observer, API health and
  `api_no_errors` all skip them. Faults are removed when each test ends, and the
  replay after a FAIL injects the same fault again.
- Verified on a local app: a properly handled 500 passed; an unhandled timeout
  failed on both counts (no message, spinner stuck forever) and the replay
  agreed; an offline failure during page load was intercepted; a normal test
  straight afterwards passed, proving cleanup.

**2026-10-18 · Step 1: API testing**
- New check types `api_response` (method + URL, status code or class, body text,
  JSON field) and `api_no_errors` (no 5xx or dropped call during the test).
- Test cases can state API outcomes (`observable: "api_response"`). The binder
  reads `POST /api/cart returns 201` from the statement; when no endpoint is
  named, Gate 2.5 picks it from the first run's network log.
- Every run now flags hidden API errors, broken JSON and slow calls.
- Network traffic is recorded on every run. Secrets are masked; masked fields
  are never compared (the check is reported undecidable instead).
- Verified against a local app with deliberate API bugs. The headline case:
  the UI showed "Added!", the test passed, and the run still reported the
  "out of stock" error hidden in the 200 response.
