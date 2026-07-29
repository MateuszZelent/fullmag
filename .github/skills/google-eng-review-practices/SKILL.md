---
name: google-eng-review-practices
description: Use when reviewing a pull request, commit, branch, patch, or working-tree diff; preparing a PR or commit description; deciding whether a change is too large; writing review comments; or responding to reviewer feedback. Adapts Google's Engineering Practices code review guidance to Fullmag.
---

# Google-Style Review Practice for Fullmag

Source and attribution: adapted from Google's public Engineering Practices documentation:

- <https://google.github.io/eng-practices/review/reviewer/>
- <https://google.github.io/eng-practices/review/developer/>

Keep this skill procedural. Do not paste long excerpts from the source docs into review output.

## Review Standard

Approve a change when it clearly improves the health of the system and meets Fullmag's correctness, architecture, and verification gates. Do not block on perfection. Do block changes that degrade correctness, maintainability, canonical physics semantics, resource-first API contracts, security, accessibility, or reproducibility.

Technical facts, tests, benchmarks, specs, ADRs, physics notes, and existing project conventions outweigh taste or personal preference. If a point is polish rather than required, label it as a nit or suggestion.

## Reviewer Workflow

1. Start with the change intent: read the PR/commit description, issue, user request, or diff summary. If the change should not exist, say that before line-by-line review and explain the better direction.
2. Find the main files first. Review design and behavior there before spending time on mechanical or peripheral files.
3. Read tests early enough to understand expected behavior, but verify that the tests would fail for the bug or contract break they claim to cover.
4. Review every human-written line in the requested scope. If reviewing only part of a change, state the scope explicitly.
5. Evaluate in this order: design, functionality, Fullmag invariants, complexity, tests, naming, comments/docs, style, consistency.
6. For UI changes, require visual or browser verification when behavior or layout changes. For resource/API changes, require OpenAPI/resource-hook/API hygiene checks where applicable.
7. If the change is too large to review confidently, ask for a split or review only the highest-risk design surface first so the author can act quickly.

## Comment Severity

Use direct labels so authors know what must change:

- `Blocker:` must be fixed before merge.
- `Required:` should be fixed in this change unless there is a strong technical reason not to.
- `Suggestion:` likely improvement, author may choose another sound approach.
- `Nit:` polish or local consistency; should not block.
- `FYI:` context for later, not required in this change.

Write comments about the code, not the author. Explain the technical reason when it is not obvious. Prefer asking for clearer code over accepting a review-thread explanation that future readers will not see.

## Author Workflow

Keep changes small and self-contained. A change should do one thing, include the related tests, leave the system working after merge, and carry enough context in its description for reviewers and future readers.

Separate behavior changes from broad refactors, file moves, generated churn, or formatting sweeps unless the local cleanup is small and directly supports the requested change.

For PR or commit descriptions:

- First line: short imperative summary of what changed.
- Body: why the change exists, key tradeoffs, user-visible behavior, tests/verification, and any known limits.
- Avoid vague descriptions such as "fix bug", "update files", or "phase 1".

## Handling Feedback

First make sure you understand the reviewer request. If it points to unclear code, improve the code or add a targeted code comment rather than only explaining in the review thread.

When disagreeing, answer with tradeoffs and evidence: explain why the current approach serves the goal better, what alternative was considered, and which assumption the reviewer may want to change. If consensus stalls, escalate to the relevant owner, maintainer, ADR, or project spec instead of letting the review drift.
