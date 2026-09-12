# Requirement — E-commerce practice platform (core storefront)

> Captured verbatim from the requirement given in chat on 2026-09-12. This is
> the second feature in the POC, kept separate from WorkPod under
> `input/feature-ecommerce/` per the user's choice — both can be worked
> independently without one overwriting the other.

The e-commerce practice platform is designed to include the following core
functional components:

## R-1 — Global Navigation

* A top navigation bar containing the brand logo and links to core pages
  (Home, Products, Cart, Checkout).
* A dedicated shopping cart icon to display or navigate to user selections.

## R-2 — Hero Carousel/Banner

* A dynamic banner section designed to display multiple promotional or
  informational slides (e.g., "Find Hidden Bugs", "Test Responsive Design",
  "Think Like a Product Owner") with navigation indicators (dots).

## R-3 — Product Filtering & Categorization

* A "Shop by Category" section with interactive buttons to filter products by:
  All, Electronics, Fashion, and Books.

## R-4 — Product Grid & Display

A product listing area ("All Products") where each item card displays:

* Product Image
* Category Tag (e.g., Electronics, Fashion, Books)
* Product Title and Brief Description
* Pricing (Current/Discounted Price in bold, Original Price struck-through or
  adjacent)
* An actionable "Add to Cart" button.

## R-5 — Global Footer

* A platform description statement.
* Redundant "Quick Links" mirroring top navigation.
* Contact information including an email address and a support phone number.
* Copyright information and a system disclaimer.

## Known gaps in this requirement

Recorded by the Thinking Agent at Gate 1 for the author of the requirement.
These are questions, not assumptions — the agent must never invent the answers.

* ~~**G-1** No STAGE URL was given.~~ **Resolved:** `base_url` is set to
  `https://buggyqa.vercel.app/` in
  `knowledge/application-context-ecommerce.yaml`.
* **G-2** No authentication/login flow is mentioned anywhere. Missions assume
  the entire storefront (browsing, filtering, add-to-cart) is anonymous/guest
  accessible. If checkout requires an account, that is undocumented here.
* **G-3** No cart confirmation mechanism is stated — no item counter/badge, no
  toast, no visible running total. "Add to Cart" is only described as
  "actionable"; what happens after clicking it is unspecified.
* **G-4** No cart *contents* view is described — only that the cart icon can
  "display or navigate to user selections." Whether that means an inline
  dropdown, a slide-over panel, or a full Cart page is unstated.
* **G-5** Discount logic is unstated: is the struck-through original price
  shown on every product, or only discounted ones? "Adjacent" vs
  "struck-through" for the original price sounds like two different states,
  not clearly distinguished by requirement.
* **G-6** Whether the "All" category button is the default selected state on
  load is not stated.
* **G-7** Checkout flow has no functional detail at all beyond being a nav
  link — no fields, no payment mechanism, no confirmation state.
* **G-8** No product data (real titles, prices, category counts) is given, so
  assertions here target structure and behaviour, not specific content.
