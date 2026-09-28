# FlowPilot sample prompts

The prompt progression this app was built from (from `FlowPilot_sample_prompts.docx`). Useful for teaching: each step shows how fast the work moves and leaves room to improve.

## 1. Basic

> Summarize and rank the most common customer complaints in this dataset

Ranks by frequency. On this data it puts free-plan dashboard requests (24 items, $0 contract value) at the top.

## 2. Better

> You are helping a product manager decide which customer problems to investigate and address first.
> The goal is not merely to summarize the comments. The goal is to make product priorities clearer.
> Use the customer comment, rating, customer segment, product area, and cancellation status when available.
> Do not assume that frequency alone determines importance. Consider severity, affected segment, and possible business impact.

## 3. Migrate to a Custom GPT

> Give me instructions to put this into a custom GPT

See [custom-gpt-instructions.md](custom-gpt-instructions.md).

## 4. Migrate to Cursor

> Convert this Custom GPT workflow into a simple web-app spec for Cursor. The app should expose the inputs, prioritized outputs, evidence, evaluation checks, and feedback controls.

See [app-spec.md](app-spec.md). This repository is that app.

## 5. Add a feedback workflow

> Add a human review workflow to the prioritization tab. For each issue, allow the user to:
> - Approve recommendation
> - Change priority
> - Correct issue name or category
> - Add reviewer note
>
> Store updates in a table.
> Add a "User review History" panel showing what the system recommended, what the human changed, and why.
> Clearly distinguish system-generated analysis and human-reviewed decision.
> Reuse relevant corrections as context in the future.
