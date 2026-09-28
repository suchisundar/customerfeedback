# FlowPilot Triage

A customer feedback app that turns FlowPilot feedback into ranked, evidence-backed product priorities, with evaluation checks and a human review workflow.

Built from the FlowPilot sample prompts (see [docs/sample-prompts.md](docs/sample-prompts.md)): the "Better" prompt's rule that **frequency alone does not determine importance** is the core of the scoring.

## Run it

No install needed. Open `index.html` in a browser.

Or serve it locally:

```bash
npm start        # serves on http://localhost:5173
npm test         # runs the analysis and review-store tests
```

## What it does

- **Priorities.** Groups complaints into issues and scores each on revenue at risk, churn signal, severity, breadth, escalations and momentum. Each issue shows its score breakdown, reasons, a suggested next step, confidence and quoted evidence. A slope chart compares rank by frequency with rank by impact.
- **Inputs.** Switch between the full dataset and the comments-only file, upload your own CSV, filter by segment, plan, source and date, and adjust score weights.
- **Evidence.** Every feedback item with its assigned issue. Move an item to another issue to correct the system.
- **Checks.** Output checks (coverage, evidence, frequency vs impact), input data checks (duplicates, mislabeled product areas, inconsistent contract values, contradictory status fields, high-risk items without action) and review checks.
- **Human review.** Approve a recommendation, change its priority, correct its name or category, and add a note. Decisions go into an append-only review table, show up in the Review history panel (system recommendation vs human decision vs why), carry forward to future runs, and export as a context block for a Custom GPT or other LLM prompt.

## What the sample data shows

| Rank by impact | Issue | Priority | Items | Contract value | Rank by frequency |
|---|---|---|---|---|---|
| 1 | Salesforce sync is unreliable | P0 | 10 | $502k, 4 canceled | 2 |
| 2 | Permissions and admin controls block enterprise rollout | P1 | 8 | $684k | 4 |
| 3 | Mobile login fails after release 3.8 | P1 | 8 | $84k, release regression | 5 |
| 4 | Performance degrades on large workspaces | P1 | 6 | $300k | 6 |
| 5 | Billing is confusing or incorrect | P1 | 5 | $188k | 7 |
| 6 | Setup steps are unclear for new teams | P2 | 4 | $31k | 8 |
| 7 | Dashboard customization is limited | P2 | 24 | $0 (all free plan) | 1 |
| 8 | Users do not know which metrics to report | P2 | 10 | $48k | 3 |

The most-mentioned issue (dashboard customization, 24 comments) comes from free-plan startups with no contract value. With the comments-only file, where ratings, segments and revenue are missing, it climbs to #3. That contrast is the point of the "Better" prompt.

## Data format

Only `feedback_text` is required. Optional columns: `feedback_id, account_id, date, source, customer_segment, plan, annual_contract_value, tenure_months, product_area, rating, usage_level, canceled, churn_risk, support_escalation, release_version, resolution_status, action_taken, outcome_after_action`. Missing signals are dropped from the score and the remaining weights rescaled.

After editing files in `data/`, run `npm run build:data` to refresh the embedded copy used when `index.html` is opened from disk.

## Docs

- [docs/app-spec.md](docs/app-spec.md): the web-app spec, including the review table schema
- [docs/custom-gpt-instructions.md](docs/custom-gpt-instructions.md): the same workflow as a Custom GPT
- [docs/sample-prompts.md](docs/sample-prompts.md): the prompt progression

Reviews are stored in your browser's local storage. Use **Copy as JSON** and **Import JSON** on the Review history tab to share them.
