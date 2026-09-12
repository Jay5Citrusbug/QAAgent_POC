# AI-Driven QA POC — Vision and Direction

> **Revision 2.** Revision 1 was the original vision. This revision folds in the
> review findings; every change is marked **[R2]** so the delta stays auditable.

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
Requirement / Documentation
          ↓
AI QA Thinking
          ↓
Requirement Analysis
Gap Identification
Risk Analysis
Test Case Generation
Smoke Selection
          ↓
HUMAN REVIEW  (Gate 1)
          ↓
Approved Test Missions
          ↓
AI QA Browser Execution
          ↓
Browser Automation
          ↓
Application
          ↓
Evidence + Replayable Trace             [R2]
          ↓
Failure Classification (separate pass)  [R2]
          ↓
HUMAN REVIEW  (Gate 2)
          ↓
PASS / BUG / BLOCKED
```

The system should eventually reduce the amount of repetitive human QA execution
while preserving human ownership of quality decisions.

---

## 3. Two Logical Agents

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
Phase 1  Requirement analysis + AI test design
Phase 2  AI browser execution
Phase 3  AI failure analysis
Phase 4  New build automatically triggers smoke
Phase 5  Stable AI-validated cases become deterministic Playwright tests
         (fed by the replayable trace, §10a)
Phase 6  AI selects regression tests based on change/risk
Phase 7  AI exploratory testing
Phase 8  Multi-project AI QA orchestration
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
