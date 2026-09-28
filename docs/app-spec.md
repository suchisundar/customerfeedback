# FlowPilot Triage: web app spec

The Custom GPT workflow ([custom-gpt-instructions.md](custom-gpt-instructions.md)) turned into a small web app. This document describes what is built in this repository.

## Users and job

A product manager (and reviewers such as a PM lead or support lead) needs to decide which customer problems to address first, see the evidence behind each recommendation, check that the analysis can be trusted, and record their own decisions.

## Architecture

Static site, no build step, no server. Runs from `index.html` opened directly or from any static host.

| File | Role |
|---|---|
| `js/csv.js` | CSV parser |
| `js/analysis.js` | Classification, scoring, rationale, evidence selection, evaluation checks. Pure functions, tested in Node. |
| `js/reviews.js` | Review table and item-correction table, persisted to `localStorage`, plus CSV/JSON export and the reusable reviewer context. |
| `js/app.js` | UI rendering and events |
| `data/*.csv` | Sample datasets; `data/sample-data.js` embeds them (regenerate with `npm run build:data`) |

## Inputs (left rail, Priorities tab)

- Dataset: full dataset, comments-only dataset, or an uploaded CSV. Only `feedback_text` is required; every other column is optional and the score adapts.
- Filters: segment, plan, source, date range.
- Score weights: six sliders (revenue at risk, churn signal, severity, breadth, escalations, momentum), rescaled to 100. Components with no data in the dataset are disabled.

## Prioritized output (Priorities tab)

- Headline naming the top issue and its strongest reason, plus summary stats.
- Frequency vs impact slope chart: rank by comment count against rank by impact score.
- One card per issue, ranked. System analysis on top: rank, name, category, recommended priority, impact score with a stacked breakdown bar, key facts, reasons, suggested next step, confidence, three evidence quotes and an expandable table of all items.
- Human decision below, visually distinct (violet "Human decision" band versus grey "System analysis" label).
- "What customers value": praise held out of the ranking.

## Evidence (Evidence tab)

Every feedback row with its assigned issue and how it was assigned (product area, keywords, sentiment, reviewer). Reviewers can move any item to another issue.

## Evaluation checks (Checks tab)

- Output: coverage, evidence per issue, uncategorized items, frequency vs impact divergence, praise/complaint separation.
- Input: product-area label vs text, duplicate comments, inconsistent contract value per account, contract value vs segment, status/action/outcome contradictions, high-risk items without action, missing fields.
- Review: all P0/P1 reviewed, stale reviews, override rate.

## Human review workflow

For each issue a reviewer can:

- **Approve** the system recommendation (one click).
- **Change priority** (P0 to P3).
- **Correct the issue name or category.**
- **Add a reviewer note.** Required when anything changes.

### Review table (`reviews`)

Append-only. One record per decision.

| Field | Meaning |
|---|---|
| `id` | Review ID |
| `at` | ISO timestamp |
| `reviewer` | Name from the Reviewer field |
| `datasetId` | Dataset the decision was made on |
| `issueKey` | Stable issue key (e.g. `integrations`) used to carry the decision forward |
| `system` | What the system recommended: `name`, `category`, `priority`, `score`, `rank` |
| `final` | The human decision: `name`, `category`, `priority` |
| `decision` | `approved` or `changed` |
| `changes` | Fields that differ between `system` and `final` |
| `note` | Why |
| `evidenceIds` | Feedback IDs the issue contained at review time |

### Item correction table (`corrections`)

| Field | Meaning |
|---|---|
| `id`, `at`, `reviewer` | As above |
| `feedbackId` | Row that was moved |
| `textKey` | Normalized comment text, used to match the same comment in future datasets |
| `text` | Original comment |
| `fromIssueKey` / `toIssueKey` | System assignment and reviewer assignment |
| `active` | False once undone or replaced by a newer correction for the same text |

### Review history panel

Newest first: when, reviewer, what the system recommended, what the human decided (changed fields highlighted), and why. Copy as CSV or JSON, import JSON from another reviewer, clear all (with confirmation).

### Reusing corrections

1. The latest decision per issue is applied to every new analysis, including a new dataset, and shown as the human decision.
2. If the system's recommended tier has moved since the review, the card and the Checks tab flag the review as stale.
3. Active item corrections are applied during classification, so the same comment lands in the corrected issue on every future run.
4. The Review history tab generates a "Prior human review decisions" text block to paste into the Custom GPT or any LLM prompt.

## Out of scope / next steps

- Shared storage so a team sees one review table (today reviews live in each browser; use export/import to share).
- An LLM pass that proposes issue names and groups for unknown product areas, with the reviewer context in its prompt.
- Authentication for reviewer identity.
