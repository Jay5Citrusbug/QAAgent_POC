# Running the Thinking Agent without a separate bill

The web UI in `web/` calls the Anthropic API directly, which is metered and
billed per token **on top of** any Claude subscription you already hold. If you
have a Claude seat, you are paying twice for the same model.

Two routes avoid that entirely. Both use a seat you already pay for, and both
produce exactly the same artifacts — the same analysis file, the same mission
JSON, validated the same way. Nothing downstream knows or cares which was used.

---

## Route A — Claude Code (no copy-paste at all)

If you are already working in Claude Code, it can act as the Thinking Agent
directly: it reads the prompt pack from disk and writes the analysis and
missions back to disk itself.

```powershell
npm run inspect -- --feature <name>          # look at the app first
npm run think   -- --feature <name> --prefix XX
```

Then ask Claude Code, in plain words:

> Act as the Thinking Agent. Read
> `thinking/prompts/prompt-<name>-<date>.md` and follow it exactly. Save the
> analysis to `thinking/analysis/<name>-<date>.md` and each mission to
> `missions/draft/<TEST_ID>.json`.

Then carry on as normal:

```powershell
npm run validate
npm run approve -- XX-001 --by "<you>" --minutes 4
npm run run-mission -- --feature <name>
```

**Why this is the better route:** no copying, no truncation risk on a long
reply, and the agent can read the schema and the observed-state capture
straight from the repository.

**What to watch:** the same rules still apply — it must not invent behaviour
the requirement never stated, and every mission still goes through Gate 1. Ask
it to follow the pack rather than improvising, and read what it produces.

---

## Route B — claude.ai in the browser

```powershell
npm run think -- --feature <name> --prefix XX --copy
```

Paste into a Claude conversation. Save the **entire reply** to a file — prose,
analysis and JSON together, no tidying — then:

```powershell
npm run import -- --from reply.md --feature <name>
```

That pulls out every mission, validates each against the schema, lints them,
and files the analysis. An id that already exists is reported and skipped
rather than overwritten; `--overwrite` is opt-in, because silently replacing an
approved mission has destroyed real work here before.

Check first if you like:

```powershell
npm run import -- --from reply.md --feature <name> --dry-run
```

---

## When the web UI is still worth its cost

Keep it only if one of these is true:

* someone needs to generate missions **without a terminal** — a QA who will not
  use a CLI, or a stakeholder you want to hand a URL
* you want the run to happen **unattended** — scheduled, or triggered by a build
* several people generate missions at once and you want one shared entry point

For one QA lead working locally, none of those apply, and the API bill buys
nothing the two routes above do not already give you.

---

## What this does not change

The cost question only touches **who runs the model**. Everything else is
identical either way:

* the same system prompt, schema, coverage checklist and observed-state capture
* the same Gate 1 approval, with the same requirement hash pinned
* the same execution agent, which never used a model at all and costs nothing
  per run beyond the browser

Execution — the part that runs every build — has always been free. The model is
only involved when a requirement is analysed, which happens once per feature,
not once per run.
