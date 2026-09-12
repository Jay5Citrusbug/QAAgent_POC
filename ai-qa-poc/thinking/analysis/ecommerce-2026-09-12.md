# Analysis — E-commerce Practice Platform — 2026-09-12

* **Requirement source:** `input/feature-ecommerce/requirement.md`
* **Model:** Live session (Claude, acting as the Thinking Agent per
  `agent/thinking/SYSTEM_PROMPT.md`) — not yet the API-integrated path.
* **Analyst (human reviewer):** jay.r

**Note on method:** before writing this analysis, the live site
(`https://buggyqa.vercel.app/`) was fetched once (a plain HTTP GET, not a
browser) to ground gaps in fact rather than guesswork wherever a static page
fetch could answer them. This is *not* the Execution Agent's job in the real
architecture (Agent 1 does not touch the browser) — it was a one-off check to
make this test of the Thinking Agent honest. Anything the fetch could not
answer (client-rendered behaviour) is recorded as a real, still-open gap below.

---

## 1. Requirement gaps

| ID | Gap | Resolved? | How |
|---|---|---|---|
| G-1 | No STAGE URL given | **Resolved** | User supplied `https://buggyqa.vercel.app/` |
| G-2 | Is any part of the site behind login? | **Resolved — no** | No login/signin/register markup anywhere on the page. Confirmed anonymous/guest end to end. |
| G-3 | What confirms "Add to Cart" worked — badge, toast, nothing? | **Open, worked around** | The static HTML shows no badge/toast (a `CartProvider` React context exists, so this is rendered client-side and only a live browser could confirm it). Per the human's decision, missions verify success via the `/cart` page instead — a fact the requirement does state — rather than assuming a badge/toast that isn't confirmed to exist. |
| G-4 | Does the cart icon open a page, a dropdown, or a slide-over? | **Resolved — a real page**, `/cart` | Confirmed by the `href="/cart"` on the cart icon link |
| G-5 | Is the struck-through original price shown on every product, or only discounted ones? | **Partially resolved** | All 8 products currently in the catalog show both prices (i.e. all are currently "discounted"). Whether the UI *hides* the original price when there's no discount remains unconfirmed — no non-discounted product exists right now to test that path. |
| G-6 | Is "All" the default-selected category filter? | **Resolved — yes** | The "All" button carries the active-state CSS classes (gradient background, shadow) on page load; Electronics/Fashion/Books do not. |
| G-7 | Checkout functional detail | **Still open, and likely to stay that way** | Zero functional markup beyond the nav link — no fields, no payment UI visible. Not worth writing a mission beyond "the link exists" (covered by EC-001) until the requirement says more. |
| G-8 | No real product data given | **Resolved by observation** | 8 real products exist right now, with stable-looking titles, categories, and prices (see Regression impact — these are hardcoded catalog facts a mission can assert on, but will need updating if the catalog changes). |

## 2. Ambiguities

| ID | Statement | Reading A | Reading B |
|---|---|---|---|
| AM-1 | "Original Price struck-through or adjacent" | Always struck-through when a discount exists (what's observed) | Sometimes just placed next to the price with no strikethrough, for a different visual treatment not currently in use |

## 3. Functional risks — ranked

| Rank | Risk | Why | Covered by |
|---|---|---|---|
| 1 | Category filter shows the wrong products | Core navigation mechanism for the whole catalog; directly affects whether a user can find anything | EC-003 |
| 2 | Add to Cart silently does nothing | The entire commercial purpose of the site; a silent failure here is the worst possible outcome and has no visible fallback signal per G-3 | EC-004 |
| 3 | Cart icon doesn't lead anywhere / 404s | Breaks the only stated way to review a selection | EC-001, EC-004 |
| 4 | Hero carousel dots don't reflect/control slide state | Cosmetic-adjacent, lower business risk than the above | EC-002 |
| 5 | Footer contact info missing or wrong | Support channel for real users if this were shipped for real; low technical risk, easy to check | EC-005 |

## 4. Scenarios considered

| Scenario | Type | Mission | If not, why not |
|---|---|---|---|
| Nav links + cart icon present and correct | positive | EC-001 | — |
| Carousel shows 3 slide-indicator dots | positive | EC-002 | — |
| Filtering to Electronics shows only Electronics products | positive | EC-003 | — |
| Filtering to a category with zero matches | boundary | — | No such category exists in the current catalog to exercise this; revisit if the catalog ever has an empty category |
| Add a product to cart, confirm on Cart page | positive | EC-004 | — |
| Footer shows contact info and quick links | positive | EC-005 | — |
| Add to cart, confirm a visible badge/toast | positive | — | G-3 is unconfirmed; asserting a specific confirmation UI would be inventing behaviour the requirement never described |
| Checkout flow | positive | — | Zero functional detail exists in the requirement (G-7); nothing to test beyond the link existing |
| "Hoem" nav typo | negative/defect | — | Confirmed intentional — the footer states "This is a QA practice website with intentional bugs." Flagged below for a human to note, not turned into a failing assertion. |
| Discount pricing shown only when applicable | boundary | — | Every current product is discounted; no non-discounted product exists to exercise the "no discount" path (G-5) |

## 5. Regression impact

The 5 missions below depend on the current catalog's exact contents (8
products; Electronics = Wireless Headphones + Bluetooth Speaker). If the
catalog is reseeded or products are added/removed, **EC-003's exact-count
assertion (`== 2`) will need updating** — this is the standard trade-off of
asserting on real data rather than a synthetic fixture, and should be reviewed
whenever the catalog changes.

## 6. Smoke set

All 5 missions below are P0, per the human's explicit choice to cover
everything in the requirement rather than narrowing to the shopping loop alone.

## 7. Not worth automating yet

* **Checkout** — no functional detail in the requirement to test against (G-7).
* **Carousel auto-rotation/timing** — EC-002 checks the dots exist with correct
  names, not that the carousel auto-advances on a timer. Timing-based
  assertions are fragile and the requirement doesn't specify a rotation
  interval; revisit if that becomes a real product concern.
* **Discount-absent price display** — no current product lacks a discount
  (G-5); nothing to test until one does.

## 8. Confidence

High on structure (nav, filters, grid, footer, dots) — all grounded in the
actual live markup, not guessed. Lower on G-3 (cart confirmation UI) and G-5
(discount-absent display), both genuinely unconfirmable without a live browser
click, which is the Execution Agent's job, not this analysis's.

## Additional findings (not requirement gaps, but worth a human's eyes)

* **`Hoem` typo** in the primary nav's Home link (footer's own "Home" link is
  spelled correctly) — confirmed intentional per the footer's own disclaimer.
  Not asserted against in any mission, per the human's decision.
* **Footer copyright text renders a mangled character** (`�`) where a `©` or
  similar is presumably intended — same "intentional bugs" caveat applies.
  EC-005 asserts on the surrounding "rights reserved" text, not the symbol
  itself, to avoid encoding-artifact fragility either way.
* **A CSS class literally named `mobile-footer-bug`** sits on the footer's
  copyright container — a strong hint there's a deliberate mobile-responsive
  defect there. Worth a manual look on a narrow viewport; out of scope for an
  automated mission in POC-1 since the requirement gives no spec for what
  "correct" mobile footer layout looks like.
* **The nav links are genuinely duplicated, on purpose** — R-5 states the
  footer's "Quick Links" mirror top navigation, and this is real: "Products",
  "Checkout", and "Cart" each appear as link text exactly twice in the DOM
  (nav + footer). An assertion targeting `role: link, name: "Cart"` with no
  scope would match both and correctly report `BLOCKED` (ambiguous), not a
  false pass — but it would look like a tooling failure rather than the
  intentional-by-requirement duplication it actually is. Every nav-link
  assertion in EC-001 is scoped with `within: { role: "navigation" }` to avoid
  this. Worth remembering for any future mission that targets nav-bar text.
