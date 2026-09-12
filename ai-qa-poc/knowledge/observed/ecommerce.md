# Observed application state

Captured from the running application. This is what is **actually there** — use it instead of assuming. If something you were about to assert is not listed below, treat that as evidence it does not exist, and say so as a gap rather than writing a mission against it.

_Captured 2026-09-12T14:16:28.825Z_

## https://buggyqa.vercel.app/

**Title:** Citrusbug QA - E-Commerce Practice
**Landmarks:** <nav> x1, <main> x1, <footer> x1

### Ambiguous names — these MUST be scoped

Each of these names matches more than one element. A target using the name alone is ambiguous, and the executor will refuse it rather than guess. Scope with `within`.

| role | name | matches | regions |
|---|---|---:|---|
| button | Add to Cart | 8 | main |
| link | Products | 2 | nav, footer |
| link | Cart | 2 | nav, footer |
| link | Checkout | 2 | nav, footer |

### Controls present (17 of 17 distinct names)

| role | name | count | region |
|---|---|---:|---|
| button | Add to Cart | 8 | main |
| link | Products | 2 | nav, footer |
| link | Cart | 2 | nav, footer |
| link | Checkout | 2 | nav, footer |
| button | Previous slide | 1 | main |
| button | Next slide | 1 | main |
| button | Go to slide 1 | 1 | main |
| button | Go to slide 2 | 1 | main |
| button | Go to slide 3 | 1 | main |
| button | All | 1 | main |
| button | Electronics | 1 | main |
| button | Fashion | 1 | main |
| button | Books | 1 | main |
| link | Citrusbug QA | 1 | nav |
| link | Hoem | 1 | nav |
| link | **_(no accessible name)_** | 1 | nav |
| link | Home | 1 | footer |

### Headings

  - h2: Find Hidden Bugs
  - h2: Test Responsive Design
  - h2: Think Like a Product owner
  - h2: Shop by Category
  - h2: All Products
    - h3: Wireless Headphones
    - h3: Smart Watch
    - h3: Designer T-Shirt
    - h3: Running Shoes
    - h3: JavaScript Guide
    - h3: Python Mastery
    - h3: Bluetooth Speaker
    - h3: Leather Jacket
    - h3: Citrusbug QA
    - h3: Quick Links
    - h3: Contact

### Images (12 visible, 2 failing to load)

- **BROKEN** alt="Logo" src=https://buggyqa.vercel.app/broken-logo.png
- **BROKEN** alt="Think Like a Product owner" src=https://buggyqa.vercel.app/_next/image?url=https%3A%2F%2Fimages.unsplash.com%2Fphoto-1454165833767-027508992bd

### Not present on this page

Checked explicitly. Do **not** write a mission that depends on any of these — if the requirement implies one should exist, that is a gap to report, not an assertion to write.

- No element with role="status" — no badge, counter or live region exists.
- No element using aria-pressed — toggle state is not exposed this way.
- No element using aria-selected — selection state is not exposed this way.
- No element using aria-current — active-page state is not exposed this way.
- No element using aria-invalid — field validation state is not exposed this way.
- No dialog or modal.
- No <form> element.
- No data-testid attribute anywhere — there are no stable test hooks to target.

### Visible text (sample, verbatim)

Exact strings as they appear — including any typos, which are real and worth noticing.

```
Find Hidden Bugs
Discover critical and UI bugs across the application just like real-world projects.
Test Responsive Design
Check how the website behaves on mobile, tablet, and desktop devices.
Think Like a Product owner
Improve logical thinking by exploring real-life broken features and edge cases.
Shop by Category
All Products
Electronics
Wireless Headphones
High-quality wireless headphones with noise cancellation
$71.99
$79.99
Smart Watch
Feature-rich smartwatch with health tracking
$179.99
$199.99
Fashion
Designer T-Shirt
Premium cotton t-shirt with modern design
$26.99
$29.99
Running Shoes
Comfortable running shoes for daily workouts
$80.99
$89.99
Books
JavaScript Guide
Complete guide to modern JavaScript development
$35.99
```

## https://buggyqa.vercel.app/cart

**Title:** Citrusbug QA - E-Commerce Practice
**Landmarks:** <nav> x1, <main> x1, <footer> x1

### Ambiguous names — these MUST be scoped

Each of these names matches more than one element. A target using the name alone is ambiguous, and the executor will refuse it rather than guess. Scope with `within`.

| role | name | matches | regions |
|---|---|---:|---|
| link | Products | 2 | nav, footer |
| link | Cart | 2 | nav, footer |
| link | Checkout | 2 | nav, footer |

### Controls present (9 of 9 distinct names)

| role | name | count | region |
|---|---|---:|---|
| link | Products | 2 | nav, footer |
| link | Cart | 2 | nav, footer |
| link | Checkout | 2 | nav, footer |
| button | Browse Products | 1 | main |
| link | Citrusbug QA | 1 | nav |
| link | Hoem | 1 | nav |
| link | **_(no accessible name)_** | 1 | nav |
| link | Browse Products | 1 | main |
| link | Home | 1 | footer |

### Headings

  - h2: Your cart is empty
    - h3: Citrusbug QA
    - h3: Quick Links
    - h3: Contact

### Images (1 visible, 1 failing to load)

- **BROKEN** alt="Logo" src=https://buggyqa.vercel.app/broken-logo.png

### Not present on this page

Checked explicitly. Do **not** write a mission that depends on any of these — if the requirement implies one should exist, that is a gap to report, not an assertion to write.

- No element with role="status" — no badge, counter or live region exists.
- No element using aria-pressed — toggle state is not exposed this way.
- No element using aria-selected — selection state is not exposed this way.
- No element using aria-current — active-page state is not exposed this way.
- No element using aria-invalid — field validation state is not exposed this way.
- No dialog or modal.
- No <form> element.
- No data-testid attribute anywhere — there are no stable test hooks to target.

### Visible text (sample, verbatim)

Exact strings as they appear — including any typos, which are real and worth noticing.

```
Your cart is empty
Add some products to get started!
Citrusbug QA
this website is created by Citrusbug QA team for testing perpose
Quick Links
Contact
Email: qa.citrusbug@gmail.com
Phone: +1 (555) 123-4567
© 2026 Citrusbug QA team. All rights reserved. This is a QA practice website with intentional bugs.
```
