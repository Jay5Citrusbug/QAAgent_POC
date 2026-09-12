# Existing test coverage

> Placeholder for POC-1. List what is already covered — manually or by
> automation — so the Thinking Agent proposes missions that add coverage
> instead of duplicating it.

## Existing automated coverage

None for this feature. That is precisely why it is the POC candidate: there is
no automation to write off, and the AI-driven path costs nothing to compare
against.

## Existing manual coverage

| Scenario | Covered by | Frequency |
|---|---|---|
| Create a WorkPod | Manual smoke | Every build |
| Attach PDF to a comment | Manual smoke | Every build |
| Attach unsupported type | Ad hoc | Rarely |

## Instruction to the Thinking Agent

* Do not propose a mission that duplicates existing automated coverage.
* Do propose a mission that duplicates existing **manual** coverage — replacing
  repetitive manual smoke is the entire point.
* Flag anything here that looks stale.
