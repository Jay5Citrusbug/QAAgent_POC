# AI-Driven QA POC — Vision and Direction

> **Revision 2.** Revision 1 was the original vision. This revision folds in the
> review findings; every change is marked **[R2]** so the delta stays auditable.
>
> **Revision 3.** R1 and R2 both assumed the application already exists when
> tests are written. In practice the requirement arrives before the build does,
> and the most valuable QA work — asking the questions nobody had time to ask —
> happens in that window. R3 restructures the system around that reality:
> clarifications become an artifact, the test separates from the UI it will one
> day touch, and a mapping step reconciles the two when the build lands.
> Changes are marked **[R3]**.
>
> **Revision 4.** R3 promoted mapping and exploration to agents of their own.
> That was an organisation chart, not an architecture: both use the same
> browser and the same element resolution the Execution Agent already has, and
> splitting them implied a separation that does not exist. R4 folds them back
> into Agent 2 as phases, and fixes what R3 got wrong about *when* each one
> runs. Changes are marked **[R4]**.

---

## 1. Problem We Are Solving

The QA team is small:

* 1 QA Lead
* 2 Fresher QAs
* 10+ projects/products

The biggest problem is not lack of test automation alone.

The QA team often receives a requirement/build while other work is already in
progress. Because of limited QA capacity, the team frequently has to:

* quickly understand the requirement
* skip or minimize detailed requirement analysis
* directly start testing
* create test cases under time pressure
* manually execute initial functional smoke testing
* later perform detailed UI/UX, compatibility, regression, and exploratory testing

This creates a risk that requirement gaps, missing scenarios, negative cases,
boundary cases, permission issues, and regression impact are not identified
early enough.

The goal is to use AI as a **QA force multiplier**, not as a replacement for
human QA.

---

## 2. Overall Vision

```text
── Before the build exists ──────────────────────────────────────

Requirement / Story / Documentation
          ↓
AI QA Thinking
          ↓
Requirement Analysis
Gap Identification  ──→  Clarification ledger  [R3]
Risk Analysis                    ↓
Test Intent Generation      HUMAN ANSWERS      [R3]
Smoke Selection                  ↓
          ↓ ←────────────────────┘
HUMAN REVIEW  (Gate 1)      — business intent, no UI
          ↓
Approved Test Intents                          [R3]

── When the front-end URL arrives ───────────────────────────────

Approved Test Intents  +  Live page capture
          ↓
AGENT 2, phase 2a — Bind                       [R4]
          ↓
Draft Missions  +  Reconciliation report       [R4]
          ↓                    ↳ intents with no control
HUMAN REVIEW  (Gate 1.5)       ↳ controls with no intent
  exceptions only              ↳ ambiguous / weak bindings
          ↓
Approved Test Missions
          ↓
AGENT 2, phase 2b ═══╦═══ 2c Explore, CONCURRENT       [R4]
  Execute            ║      ↳ ambient    ┐ share the
          ↓          ║      ↳ sweeps     ┘ mission session
Browser Automation   ║      ↳ build diff ┐ own context
          ↓          ║      ↳ state probe┘ (mutates the page)
Application          ║              ↓
          ↓          ╚═══► Observations (never PASS/FAIL)
Evidence + Replayable Trace             [R2]
          ↓
Failure Classification (separate pass)  [R2]
          ↓
HUMAN REVIEW  (Gate 2)
          ↓
PASS / BUG / BLOCKED  ──→  Jira issue          [R3]
```

The system should eventually reduce the amount of repetitive human QA execution
while preserving human ownership of quality decisions.

---

## 3. Three Logical Agents **[R4 — was five in R3]**

### Agent 1 — QA Thinking Agent

This is the "brain".

Responsibilities:

* understand requirements
* analyze documentation
* identify requirement gaps
* identify ambiguity
* identify functional risks
* identify positive scenarios
* identify negative scenarios
* identify boundary scenarios
* identify role/permission scenarios
* identify regression impact
* generate test cases
* identify P0/P1 smoke scenarios
* produce structured execution missions

Agent 1 does NOT execute the browser.

Agent 1 must NOT generate Playwright code as the primary output.

Its primary output is a structured, reviewable test definition that validates
against `ai-qa-poc/schemas/test-mission.schema.json`. **[R2]**

---

### Agent 2 — QA Browser Execution Agent

This is the "hands".

Responsibilities:

* consume approved test missions
* understand application context
* operate the real staging application
* discover live UI elements when needed
* execute approved actions
* verify expected results
* capture evidence
* **emit a replayable trace of resolved locators and actions** **[R2]**
* return structured results

Agent 2 must NOT redefine the test objective.

Agent 2 must NOT classify *why* a failure happened. It reports what it did and
what it observed. Classification is a separate pass — see §13a. **[R2]**

Agent 2 should execute the approved test mission, not independently decide what
the product should do.

#### Agent 2 runs in three phases **[R4]**

R3 called the first two of these Agent 4 and Agent 5. They are not separate
agents. Binding an intent to a control and finding a control during execution
are the *same operation* against the same live accessibility tree —
[ai-qa-poc/src/discovery.ts](ai-qa-poc/src/discovery.ts) already does it — and a
second resolver would be duplication with two sets of bugs.

```text
2a  Bind      once per build, BEFORE any mission runs
2b  Execute   per mission
2c  Explore   concurrently with 2b
```

**2a — Bind.** Approved intents (§5a) plus a `PageReality` capture in, draft
missions plus a **reconciliation report** out.

| | Meaning |
|---|---|
| Intent binds cleanly to a control | Ready to execute. |
| Intent with no matching control | The feature is missing, the control was renamed, or the intent was wrong. Three different responses — and a finding *before a single test runs*. |
| Control with no intent covering it | A coverage hole. The page has something nobody wrote a case for. |

A QA Lead does exactly this by hand on first receipt of a build, and it takes an
hour. Automating the reconciliation is worth more than automating the clicking.

The binder may **not** edit a `test_objective` or invent an outcome. If an
intent cannot be bound it says so; it never weakens the intent until it fits the
page it found.

> **Why 2a is a phase and not just part of the loop [R4].** The separation that
> matters is temporal, not organisational.
>
> Bind inside the execution loop and the same agent decides what "submit
> credentials" means in UI terms *and* grades whether the result was correct —
> at the same moment. That is the §13a problem one layer down: an agent that
> bound to the wrong control will narrate the failure in terms of the binding it
> chose. Writing the bindings down **before** execution starts puts the decision
> on record ahead of the result, so it cannot be retconned.
>
> It is also the only way the reconciliation report exists at all. Bind at
> runtime and "no control matches this intent" arrives one failure at a time,
> mid-run, after the browser cost has been paid.

Implemented in [ai-qa-poc/src/binder.ts](ai-qa-poc/src/binder.ts), driven by
`npm run bind`. It is deterministic, and therefore honest about its ceiling: the
intent contract forbids naming controls, so the binder infers what it can from
the verb and the accessible names, and turns **everything it cannot settle into
an exception carrying the candidates actually present on the page**. The human
picks from a list rather than authoring from scratch.

That is also the seam a model plugs into later — the same seam `resolveTarget`
leaves in [ai-qa-poc/src/discovery.ts](ai-qa-poc/src/discovery.ts). Until one is
wired in, the exceptions are the honest output rather than a hidden guess.

**2b — Execute.** Unchanged. The approved mission, against the real application.

**2c — Explore.** Concurrent with 2b, never after it. Detailed in §7b, and
driven standalone by `npm run explore`.

---

### Agent 3 — Failure Classifier **[R2]**

A cheap, separate reasoning pass — deliberately not the executing agent.

* **Input:** the structured result, the evidence, the replayable trace, the mission
* **Output:** a proposed classification and a confidence, for the human at Gate 2

Rationale: an agent that just failed is the least reliable narrator of why it
failed. Self-classification lets `AGENT_EXECUTION_FAILURE` quietly mask a real
product defect, and vice versa — which directly defeats success criterion 9.

---

## 4. Human Gates

### Gate 1 — Test Design Approval

```text
Requirement → Thinking Agent → ai-qa-poc/missions/draft/*.json
           → Human QA review
           → ai-qa-poc/missions/approved/*.json
```

**Mechanism [R2]:** approval is a file move from `ai-qa-poc/missions/draft/` to
`ai-qa-poc/missions/approved/`, committed to git, with `approval.approved_by` and
`approval.approved_at` populated. That is the entire approval system for POC-1 —
no tooling to build, and it yields a real audit trail.

Agent 2 MUST refuse to execute any mission that is not in `ai-qa-poc/missions/approved/`
with a populated `approval` block.

### Gate 1.5 — Binding Review, by Exception **[R4]**

```text
Approved intent + live page → Bind (2a) → missions/draft/*.json
                                        → reconciliation report
                                        → EXCEPTIONS ONLY to a human
                                        → missions/approved/*.json
```

R3 made this a gate on every binding. That was wrong, and R3 said so itself:
if the binder is usually right, reviewing every binding is a rubber stamp, and
a rubber-stamp gate is worse than no gate because it manufactures the
appearance of review.

So the binder emits a confidence per binding, and only these reach a human:

* nothing matched the intent
* several things matched (`discovery.ts` already refuses to silently pick)
* the binding resolved by a weak strategy — raw selector, or text alone
* a control exists that no intent covers

Everything high-confidence passes straight through. Review cost then scales
with actual risk rather than with the size of the suite.

What survives from R3 is the reason a human is in this loop at all: the intent
says "submit credentials", the page offers *Sign in* and *Sign in with SSO*,
and a wrong pick tests the SSO path and passes. Ambiguity detection catches
"two things matched"; it does not catch "one thing matched and it was the
wrong one". That is the case worth a human's five seconds.

---

### Gate 2 — Result / Defect Approval

```text
Browser execution → PASS / FAIL / BLOCKED / INCONCLUSIVE
                 → Evidence + trace + proposed classification
                 → Human QA review
                 → Confirmed defect / accepted failure / retry
```

AI should never independently decide that a release is safe.

AI should never automatically create a product defect without human review
during the initial POC.

---

## 4a. Clarifications Are an Artifact, Not a Conversation **[R3]**

§5 hard rule 1 already says the Thinking Agent must report a gap rather than
fill it in. That was prose, and nothing enforced it. Worse, the answers were
given in a chat window and died with the tab — so the same question gets asked
again on the next story.

The ledger lives at `input/feature[-<name>]/clarifications.yaml`:

```yaml
questions:
  - id: Q-1
    question: What happens on the 6th consecutive failed sign-in attempt?
    why: LG-004 and LG-005 assert lockout behaviour the requirement never states.
    status: open          # open | answered | assumed
    answer: null
```

Three rules make it more than a document:

1. **An intent declares what it depends on.** `depends_on_clarifications: ["Q-1"]`.
2. **Approval is refused while any dependency is `open`.** That is how "never
   invent expected behaviour" stops being advice and becomes a gate. The intent
   may exist as a draft — the agent writes the question and the intent together,
   which is the honest order — but it cannot pass Gate 1.
3. **`assumed` is allowed and is stamped.** Sometimes waiting is not an option.
   An assumption is a legitimate answer, but the intent carries
   `assumption: true` into the run report, so nobody mistakes a guess for a
   confirmed requirement when the result comes back.

Answers are hashed the same way requirements are (§16). If an answer changes
later, every intent derived from it is flagged stale rather than silently
testing a rule nobody agreed to any more.

**Why this is the highest-value part of the system.** A gap found at story time
costs a conversation. The same gap found at UAT costs a release. The metric
that justifies this work upward is not test cases generated — it is **gaps
raised per story, and how many changed the requirement before development
finished.**

---

## 5. Shared Language Between the Agents

> Agent 1 and Agent 2 must communicate through a stable, structured Test Mission
> contract.

Agent 1 should not produce an informal paragraph that Agent 2 has to interpret.

The authoritative definition is [ai-qa-poc/schemas/test-mission.schema.json](ai-qa-poc/schemas/test-mission.schema.json).
Fields added in R2, and why each one exists:

| Field | Why it was added **[R2]** |
|---|---|
| `requirement_ref` | Success criterion 8 requires tracing a result back to the *requirement*, not just the test ID. Without it, that traceability claim is aspirational. |
| `assertions[].check` | Free-text assertions mean one LLM interprets, executes **and** grades the test. A structured check makes pass/fail a Playwright expectation rather than a model opinion. |
| `expected_outcome` | Negative missions expect the app to *refuse*. Without this flag the agent reports FAIL on correct behaviour. |
| `cleanup` / `data_policy` | Creation tests litter STAGE. Forty runs means forty orphan WorkPods and a polluted starting state for every later mission. |
| `budget` | §11 asked for token/time control but nothing enforced it. Caps discovery so one confused agent cannot burn the budget. |
| `auth` | "Admin is authenticated" was a precondition with no mechanism — and it decides whether POC-1 runs at all. |
| `evidence_policy` | Named in R1 prose, missing from the R1 contract. |
| `approval` | Makes Gate 1 machine-checkable. |

A worked example lives at [ai-qa-poc/missions/draft/SM-001.json](ai-qa-poc/missions/draft/SM-001.json).

### Assertion structure **[R2]**

Every assertion carries both a human sentence and a machine-checkable form:

```json
{
  "id": "A1",
  "statement": "sample.pdf is visible in the submitted comment",
  "check": {
    "type": "visible",
    "target": {
      "description": "attachment chip labelled sample.pdf",
      "role": "link",
      "name": "sample.pdf",
      "within": {
        "description": "the comment just submitted",
        "role": "article",
        "name": "Comment by Admin"
      }
    }
  }
}
```

`statement` is what the human reviews at Gate 1. `check` is what the executing
agent must turn into a real Playwright expectation. If the agent cannot express
a `check` as an expectation, the outcome is `INCONCLUSIVE` — never PASS.

---

## 5a. Intent and Binding — the Two-Phase Test **[R3]**

The R2 mission mixes *what we are testing* with *where to click*:
`starting_context.page`, `url_hint`, targets carrying `role` and `name`. That
is fine once the application exists. Before it exists, the Thinking Agent has
two options and both are bad: invent the UI, or write something too vague to
run.

It invented. Of seven early missions, two asserted controls that do not exist —
a cart count badge and an `aria-pressed` attribute the page never uses. Giving
the agent eyes (`npm run inspect`) fixed that *for applications that are already
built*. It does nothing for the window this system is most useful in.

So the artifact splits in two.

### Test Intent — written at story time, contains no UI

Authoritative definition: [ai-qa-poc/schemas/test-intent.schema.json](ai-qa-poc/schemas/test-intent.schema.json).

```text
step:     "submit credentials for an account that is locked"
outcome:  "the user is told the account is locked, and is not signed in"
          observable: message_shown
```

No role. No accessible name. No selector. Not because the agent is being
careful, but because **the schema cannot express one** — the failure mode is
designed out rather than warned about.

`observable` is the one concession: it says what *kind* of evidence would
settle the outcome (`message_shown`, `navigation`, `state_change`,
`element_absent`, `element_present`, `data_persisted`, `access_denied`,
`value_equals`). That is enough for the binding phase to know what family of
check to bind, and still says nothing about the UI.

### Mission — the intent bound to a real page

Unchanged from R2, and still what the Execution Agent consumes. Phase 2a
produces it; a human reviews the exceptions at Gate 1.5.

### Why the split earns its keep

* **Gate 1 review gets cheap.** The human reviews business intent — readable by
  the BA who wrote the story. Today they review locator descriptors. VISION §17
  names review cost as the hidden failure mode of Gate 1; this is the direct
  attack on it.
* **Intent survives redesigns.** The login page is rebuilt; the intent is
  untouched and only the binding is regenerated. Under R2 the whole mission was
  rewritten.
* **"We do not know the UI yet" becomes a structural fact** rather than a
  quality problem to apologise for.

### What it costs, stated honestly

An extra artifact, and a binding pass before execution rather than during it.

R3 also added a gate on every binding, and that cost was real: if the binder is
usually right, reviewing all of it is theatre. **[R4]** resolves this by
reviewing exceptions only (§4 Gate 1.5). The exception rate is tracked from the
first build — if it approaches zero, the review disappears on its own; if it is
high, the binder is not good enough yet and that is worth knowing early.

---

## 6. Application Context

The execution agent should not be expected to understand the entire application
from nothing. Provide lightweight application context — see
[ai-qa-poc/knowledge/application-context.yaml](ai-qa-poc/knowledge/application-context.yaml).

This is NOT a complete DOM map. It gives the execution agent enough product
context to start in the correct area.

**Ownership [R2]:** the QA Lead owns this file. It is reviewed whenever a
mission fails as `ENVIRONMENT_FAILURE`, or whenever the agent cannot find a
named module. It is not auto-generated.

---

## 7. How Browser Execution Should Work

Bounded, mission-driven discovery — not a crawl of the application.

```text
Approved Test Mission
        ↓
Known starting context
        ↓
Open required page
        ↓
Check locator cache ──hit──→ use known locator
        ↓ miss
Inspect current page (targeted)
        ↓
Find relevant element
        ↓
Perform action
        ↓
Observe resulting state
        ↓
Verify assertion (as a Playwright expectation)
        ↓
Record resolved locator into the replayable trace   [R2]
        ↓
Continue (until budget.max_steps)                   [R2]
```

The agent should explore only enough of the current application state to
complete the approved mission.

### Rerun and flakiness policy **[R2]**

A single FAIL from an agentic browser run is weak evidence — and weak evidence
is precisely what destroys the trust the KPI depends on.

```text
First run FAIL
      ↓
One deterministic replay from the recorded trace
      ↓
Both runs fail identically  → FAIL
Runs disagree               → INCONCLUSIVE  (never FAIL)
```

`INCONCLUSIVE` is a first-class, respectable outcome. A false defect costs more
human QA time than reporting nothing at all.

---

## 7b. Exploration — Concurrent, Not Sequential **[R3, revised R4]**

A mission answers the one question it was asked. An experienced tester does
more: while testing the cart they notice the logo is broken, the console is
throwing, a request 404'd. Nobody wrote a case for any of it.

This is **phase 2c of the Execution Agent**, and it runs *while* missions run —
not as a pass afterwards. R3 described it as a separate sequential agent, which
was wrong on both counts. Ambient observation already works this way today:
[ai-qa-poc/src/observer.ts](ai-qa-poc/src/observer.ts) is started before the run,
rides the mission's own browser session, and contributes nothing to the verdict.

Its governing rule stays absolute: **findings never change a mission's
PASS/FAIL.** The mission asked one question and deserves one answer; mixing them
makes both untrustworthy.

### What can share the mission's session, and what cannot **[R4]**

| Mode | Shares the session? |
|---|---|
| Ambient — console, network, broken images | **Yes.** Already does. |
| Sweeps — all images load, all controls labelled | **Yes.** Runs against whatever page the mission reaches. |
| Build diff — page capture vs. the last build | **Yes**, in its own context. It does not need the mission at all. |
| **Bounded state probe** — typing into inputs | **No.** |

The last row is a physical constraint, not a preference. The state probe mutates
the page: type 300 characters into the username field while a mission is trying
to sign in and you have broken the mission and manufactured a false failure. It
gets its own browser context — still concurrent in wall-clock terms, still
inside Agent 2, isolated in state.

**1. Sweeps** — one check across every element rather than one element at a
time, so they keep covering things nobody wrote a mission for next week. Already
present: every image loads, every control has an accessible name. To add: every
form field has a label, no duplicate accessible names, no dead links, clean
console and network on load.

**2. Bounded state probe** — for each input found, a small fixed matrix: empty,
whitespace only, max length + 1, unicode, paste, Enter to submit, tab order. It
reports **what the application did**. It does not grade it.

> There is no oracle here. The requirement does not say what a 300-character
> username should do, so the explorer cannot know whether what happened is
> correct. Pretending otherwise manufactures false defects, and a false defect
> costs more human QA time than reporting nothing at all.

**3. Build diff** — snapshot `PageReality` per build and compare.

Implemented in [ai-qa-poc/src/build-diff.ts](ai-qa-poc/src/build-diff.ts), over the
kept captures in `knowledge/captures/` ([ai-qa-poc/src/captures.ts](ai-qa-poc/src/captures.ts)).
The capture series had to come first: `npm run inspect` overwrote its output
every run, so until R4 there was literally nothing to diff against. Renames are
detected rather than reported as an unrelated removal plus an unrelated
addition — "Sign in became Log in" is one fact a human judges in a second, and
the same thing split in two reads as a feature deleted.

```text
"The 'Remember me' checkbox is gone."
"A new 'OTP' field appeared. No intent covers it."
```

Regression detection with zero test cases, at nearly zero cost. It is also the
answer to the question this system gets asked most: *what if something quietly
broke on a page my test cases do not reach?*

---

## 8. Playwright's Role

Playwright is the browser execution technology. It is not the QA reasoning
layer.

Playwright owns: browser control, navigation, clicking, typing/filling,
uploading, assertions/verification, screenshots, tracing, browser state,
cross-browser execution.

POC-1 uses **Playwright CLI**, because current Playwright documentation
positions CLI as the more token-efficient approach for coding-agent workflows.
MCP remains a possible later execution mechanism for more exploratory,
agentic workflows.

### Stating the CLI trade-off honestly **[R2]**

With the CLI approach the agent *does* write Playwright code — ephemeral, one
script per mission, iterated on failure. Success criterion 3 means **no human
writes Playwright first**; it does not mean no code exists. Nobody should later
feel misled on this point.

What CLI costs us: the native inspect → act → observe loop that MCP provides for
free. Under CLI the agent must re-run a script to observe state. We accept that
in exchange for token efficiency, and revisit if discovery proves too slow in
practice.

**Tracing is on from day one** (`trace: retain-on-failure`). The Playwright
trace viewer by itself satisfies most of §12: a human can review a failure
without re-running it.

---

## 9. Why We Do Not Want AI for Every Regression Test

The long-term model is hybrid.

**New / unknown / changing feature** → AI Browser Agent + Playwright.
No automation exists yet, exploration is genuinely useful, and nobody wants to
write automation for something still in flux.

**Stable critical workflow** → convert to deterministic Playwright.

```text
AI discovers and validates flow
        ↓
Human confirms important scenario
        ↓
Replayable trace → generated Playwright test   [R2]
        ↓
Permanent regression test
```

Future executions then run `Build → Playwright → fast deterministic regression`
without spending LLM reasoning on every run.

---

## 10. Locator Strategy

Do not make the Thinking Agent responsible for permanent CSS/XPath locators.

```text
Test intent → semantic description → execution agent
           → live page discovery → Playwright interaction
```

We keep a lightweight cache of known-stable elements at
[ai-qa-poc/knowledge/locator-cache.json](ai-qa-poc/knowledge/locator-cache.json).

Execution order: known locator → otherwise discover from the live page.

**The cache is written, not hand-maintained [R2]:** every PASS contributes its
resolved locators back to the cache, so the system gets faster on its own
instead of depending on someone remembering to update a file.

---

## 10a. The Replayable Trace **[R2]**

Every run — PASS or FAIL — emits the ordered list of *resolved* locators and
actions the agent actually used. See
[ai-qa-poc/schemas/execution-result.schema.json](ai-qa-poc/schemas/execution-result.schema.json).

This costs nothing to produce (the agent already knows those locators) and it is
the highest-leverage artifact in the whole system:

1. it feeds the locator cache automatically (§10)
2. it makes the deterministic replay in §7 possible
3. it turns Phase 5 — conversion to permanent Playwright tests, where the real
   ROI lives — from a re-authoring exercise into a codegen step

Without it, Phase 5 means writing everything again by hand.

---

## 11. Token / Performance Strategy

The system should:

* use targeted page inspection
* avoid full-page snapshots when unnecessary
* use semantic search/find when possible
* reuse known locators
* avoid screenshots after every action
* capture screenshots primarily for failures or visual validation
* avoid exploring unrelated modules
* avoid repeatedly rediscovering the same page structure
* **respect the per-mission `budget` block — `max_steps`, `timeout_ms`,
  `max_discovery_attempts`. Exceeding any of them ends the mission as
  `BLOCKED`, not FAIL.** **[R2]**

The goal is AI reasoning where necessary plus deterministic browser operations
wherever possible — not LLM reasoning for every click.

---

## 12. Evidence Requirements

Minimum, every execution: `test_id`, `status`, steps executed, expected, actual,
and the replayable trace **[R2]**.

For failures: screenshot, execution log, relevant snapshot, **the Playwright
trace** **[R2]**, plus network/console evidence where useful.

The evidence must be sufficient for a human QA to review the result without
re-running the entire test immediately.

---

## 13. Execution Result

Authoritative definition: [ai-qa-poc/schemas/execution-result.schema.json](ai-qa-poc/schemas/execution-result.schema.json).

Status and classification are **orthogonal axes** and must stay that way
**[R2]**: status answers *what happened to the test*, classification answers
*whose fault it was*.

Allowed statuses:

```text
PASS
FAIL
BLOCKED
INCONCLUSIVE
```

Allowed classifications (only on FAIL / BLOCKED / INCONCLUSIVE):

```text
PRODUCT_DEFECT
AGENT_EXECUTION_FAILURE
ENVIRONMENT_FAILURE
TEST_DATA_FAILURE
INCONCLUSIVE
```

**[R2]** R1 used `POSSIBLE_PRODUCT_DEFECT` in its example but `PRODUCT_DEFECT`
in its enum. Resolved: the enum value is `PRODUCT_DEFECT`, and the "possible"
nuance is carried by `confidence` rather than by a second enum value.

---

## 13a. Who Classifies **[R2]**

* **Agent 2 emits:** status, steps executed, expected, actual, evidence, trace.
* **Agent 2 does NOT emit** `classification`.
* **Agent 3 (§3) proposes** `classification` + `confidence` from that output.
* **The human at Gate 2** accepts or overrides — and the override is recorded.

The disagreement rate between Agent 3 and the human is itself a quality metric
worth watching.

---

## 13b. From Failure to Ticket **[R3]**

```text
Run artifacts → defect candidate → Gate 2 (human) → Jira issue
```

**Inbound first, because it is the cheap win.** The story is already in Jira.
Pulling its description and acceptance criteria into
`input/feature/<JIRA-KEY>/requirement.md` removes the copy-paste and makes
`requirement_ref.locator` a real ticket key, which is what §17 criterion 8
actually wanted.

Outbound, three things decide whether the team trusts it:

1. **Fingerprint and deduplicate.** Hash (`test_id` + assertion id + error
   class + normalised message). Forty runs against one real bug must produce one
   ticket with fresh evidence appended — not forty tickets. Skip this and the
   system gets switched off in week two, correctly.

2. **Reproduction steps come from the replayable trace, not the mission.** The
   mission says what we meant to do; the trace (§10a) says what actually
   happened. Only one of those reproduces the bug.

3. **Only `PRODUCT_DEFECT` above a confidence threshold, and only after a human
   confirms** while trust is being built. §13a already separates the classifier
   from the executor for exactly this reason: an agent that just failed is the
   least reliable narrator of why.

Automatic creation without Gate 2 stays forbidden in POC-1 (§4). It is
revisited when the Agent 3 / human disagreement rate is low enough to justify
it — measured, not assumed.

### What exists, and what deliberately does not **[R4]**

Built: [ai-qa-poc/schemas/defect-candidate.schema.json](ai-qa-poc/schemas/defect-candidate.schema.json),
the assembly and fingerprinting in [ai-qa-poc/src/defect.ts](ai-qa-poc/src/defect.ts),
and `npm run defects` — which produces a report complete enough to paste into a
ticket and assign: title, severity, environment and build, the requirement it
violates, preconditions, reproduction steps taken from the replayable trace,
expected, actual, every evidence file, and the classifier's proposal.

**Not built, deliberately: the API call.** No tracker credentials, no
auto-filing. The value here was never the HTTP request — it is the ten minutes
of writing-up per defect that gets skipped when the sprint is tight, which is
how real bugs end up as a line in a report nobody actions. A human reads the
report, agrees it is real, and pastes it.

`npm run defects -- --confirm <fingerprint> --by "<name>" --ticket <KEY>` records
the decision and the tracker key, so the next run links a repeat to the existing
issue instead of raising another. Those decisions are the one part of
`reports/` kept in git: a rejected defect is somebody's judgement, and losing it
means re-raising it forever.

---

## 14. POC-1 Scope

```text
1 project
1 feature
1 staging environment
1 browser: Chromium
1 role: Admin          [R2 — was: multiple roles]
4 smoke missions       [R2 — was: 5]
```

Do NOT initially build: full regression, all browsers, mobile, performance
testing, accessibility testing, CI/CD, automatic defect creation, self-healing,
vector database, RAG, complex multi-agent orchestration, 10+ projects.

POC-1 is only proving the core execution concept.

---

## 15. Recommended POC Feature

`WorkPod comment attachments`, on STAGE.

```text
SM-001  Admin can create a WorkPod            (simplest proof of the loop)
SM-002  Admin uploads valid PDF to a comment
SM-003  Admin uploads valid HTML to a comment
SM-004  Unsupported file type is rejected     (negative — expected_outcome: blocked)
```

**Deferred to POC-2 [R2]:** `SM-005 Guest / unauthorized behaviour`. It needs a
second role, a second account, and possibly separate tenant setup — environment
cost disproportionate to what it proves, since SM-001..SM-004 on a single Admin
role exercises the identical loop. The role matrix is a POC-2 concern.

The first successful execution should prove:

```text
Natural-language mission → AI browser execution → Playwright
→ Application → Verification → Structured result
```

---

## 16. Current Technical Direction

```text
Thinking:   Existing ChatGPT / cloud LLM
                ↓
            Human review (Gate 1, via git)
                ↓
            Test Mission JSON (schema-validated)
                ↓
Execution:  AI/browser-capable coding agent
                ↓
            Playwright CLI → Chromium → STAGE
                ↓
Classify:   Separate cheap pass (Agent 3)
                ↓
            Human review (Gate 2)
```

Do NOT introduce Ollama initially: speed is uncertain, accuracy varies by
hardware, browser tool-calling quality matters, and the POC should prove
functionality before optimizing cost. Local models get benchmarked separately,
later.

**Traceability caveat [R2]:** Agent 1 running in a chat window means its
reasoning is not durable. Whenever a mission is generated, the source
requirement text (or a link plus a content hash) is committed alongside it under
`ai-qa-poc/input/feature/` and referenced by `requirement_ref`. Otherwise success
criterion 8 is unenforceable.

**Authentication [R2]:** roles authenticate via seeded Playwright
`storageState`, refreshed out-of-band — never a UI login per mission.
Credential handling for STAGE is decided before the first run, and no credential
is ever written into a mission file.

---

## 17. POC Success Criteria

1. A real requirement can be converted into useful test missions.
2. A human can review and approve those missions.
3. The execution agent can consume the approved mission without a human writing
   Playwright code first.
4. The agent can operate the real STAGE browser.
5. The agent can complete the critical happy-path smoke scenarios.
6. The agent explicitly verifies expected results as real assertions.
7. Failures produce useful evidence.
8. The final report maps results back to the original test IDs and requirements.
9. Human QA can distinguish product defects from environment/agent failures.
10. The process demonstrates meaningful reduction in human QA effort.

The most important KPI is:

> **Human QA effort required to reach a trustworthy feature-level smoke
> decision.**

Not the number of AI-generated test cases.

### Making the KPI measurable **[R2]**

As written, "reduces human QA effort" cannot be proven. Two baselines are
captured in week one, **before the first agent run**, in
[ai-qa-poc/docs/BASELINE.md](ai-qa-poc/docs/BASELINE.md):

1. **Manual baseline** — the QA Lead's actual wall-clock minutes to smoke this
   feature by hand today.
2. **Mission edit rate** — what fraction of AI-generated missions the human
   edits at Gate 1, and the review minutes spent per mission.

The second matters more. Missions that take twenty minutes each to review are a
net loss even if execution is free. **Review cost is the hidden failure mode of
Gate 1**, and it is the number most likely to kill this approach quietly.

---

## 18. Long-Term Vision

```text
Phase 1  Requirement analysis + clarification ledger + UI-free test intents  [R3]
Phase 2  Agent 2a: bind intents to the real build, reconciliation report      [R4]
Phase 3  AI browser execution
Phase 4  AI failure analysis
Phase 5  Agent 2c: sweeps, state probe, build diff — concurrent with 2b       [R4]
Phase 6  Defect pipeline and Jira, both directions                            [R3]
Phase 7  New build automatically triggers smoke
Phase 8  Stable AI-validated cases become deterministic Playwright tests
         (fed by the replayable trace, §10a)
Phase 9  AI selects regression tests based on change/risk
Phase 10 Multi-project AI QA orchestration

**[R3] Note on ordering.** Phases 1 and 2 do not make generated tests visibly
better on day one. They make the system *truthful about what it does not know*,
which is what stops false defects — and a false defect costs more human QA time
than generating nothing at all. That is the whole bet.
```

```text
                QA ORCHESTRATOR
                       │
         ┌─────────────┼─────────────┐
         ↓             ↓             ↓
    THINKING        EXECUTION     FAILURE
      AGENT           AGENT       ANALYZER
         │             │             │
         └─────────────┼─────────────┘
                       ↓
                    HUMAN QA
                       ↓
                Release Decision
```

---

## 19. Core Principle

> **AI should reduce repetitive QA effort, not reduce QA quality.**

AI can propose. AI can execute. AI can investigate. AI can recommend.

**Human QA approves important decisions.**

Optimize for **speed + coverage + evidence + repeatability + cost efficiency**
without sacrificing correctness.

---

## 20. Validation Questions

Validate every architectural or implementation decision against these:

1. Does this reduce repetitive QA effort?
2. Does this preserve human control?
3. Does Agent 1 produce information that Agent 2 can reliably consume?
4. Does the execution use approved test intent rather than inventing requirements?
5. Can the system execute a new feature without requiring us to write Playwright
   code first?
6. Can successful important flows eventually become deterministic Playwright tests?
7. Are token usage and execution time controlled?
8. Can every result be traced back to a specific test ID and requirement?
9. Can we distinguish a product defect from an agent/automation/environment
   failure?
10. Can this eventually scale from one feature to 10+ projects without
    multiplying QA workload?
11. **Does the human trust the result enough to act on it without re-running the
    test by hand?** **[R2]**

If an implementation decision fails several of these, treat it as a deviation
from the intended POC direction.
