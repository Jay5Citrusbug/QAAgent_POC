# Requirement — WorkPod creation and comment attachments

> Placeholder content for POC-1. Replace with the real STAGE requirement before
> the first real run, and keep it committed: the Thinking Agent runs in a chat
> window, so its reasoning is not durable. This file is what `requirement_ref`
> points at, and without it success criterion 8 ("every result traces back to a
> requirement") is unenforceable.

## R-1 — Create a WorkPod

An Admin can create a WorkPod from the WorkPods area.

* The Admin opens the WorkPods area.
* The Admin starts creating a new WorkPod.
* The Admin enters a name.
* The Admin submits.
* The new WorkPod is created and appears in the WorkPods list.

## R-2 — Attach a file to a comment

An Admin can attach a file to a comment on a WorkPod.

* Supported types: PDF, HTML, PNG, JPG.
* The attachment is visible on the submitted comment.
* Unsupported file types are rejected with a message to the user.

## Known gaps in this requirement

Recorded by the Thinking Agent at Gate 1 for the author of the requirement.
These are questions, not assumptions — the agent must never invent the answers.

* **G-1** Maximum name length for a WorkPod is not stated. Boundary untestable as written.
* **G-2** Duplicate WorkPod names — allowed, or rejected? Not stated.
* **G-3** Maximum attachment size is not stated.
* **G-4** "Rejected with a message" — is the message inline, a toast, or a dialog? The assertion cannot be made specific until this is answered.
* **G-5** Whether an attachment can be removed after the comment is submitted is out of scope here but likely needed.
