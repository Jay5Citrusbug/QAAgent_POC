# Analysis template

The Thinking Agent produces two things. The missions go to `missions/draft/`.
**This** is the shape of the other half — and it gets committed to
`thinking/analysis/<feature>-<YYYY-MM-DD>.md`.

Why it is committed: the agent runs in a chat window, so its reasoning is not
durable. The gaps it found are often worth more than the missions — they are
questions for the requirement author that nobody else had time to ask. Losing
them to a closed tab is the single cheapest mistake available here.

---

```markdown
# Analysis — <feature> — <YYYY-MM-DD>

* **Requirement source:** <path under input/feature/, or ticket id>
* **Model:** claude-opus-5 (effort high)
* **Analyst (human reviewer):** <name>

## 1. Requirement gaps

Things the requirement does not state. Questions for the author — never
assumptions filled in by the agent.

| ID | Gap | Why it matters | Blocks a mission? |
|---|---|---|---|
| G-1 | | | |

## 2. Ambiguities

Statements that can be read two ways. Give both readings.

| ID | Statement | Reading A | Reading B |
|---|---|---|---|
| AM-1 | | | |

## 3. Functional risks — ranked

Ranked, with a reason. An unranked list is not analysis.

| Rank | Risk | Why | Covered by |
|---|---|---|---|
| 1 | | | SM-00x |

## 4. Scenarios considered

Including the ones deliberately NOT turned into missions, and why — that
judgement is most of the value.

| Scenario | Type | Mission | If not, why not |
|---|---|---|---|
| | positive / negative / boundary / permission | SM-00x | |

## 5. Regression impact

What else might this change break?

## 6. Smoke set

Which missions are P0, and the argument for keeping the set this small.

## 7. Not worth automating yet

Scenarios better left manual for now, with the reason. Saying so is a valid
and useful output — a mission nobody trusts costs more than no mission.

## 8. Confidence

Where the analysis is weak, and what would strengthen it.
```
