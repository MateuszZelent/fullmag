---
name: google-eng-review-practices
description: "Use when reviewing a pull request, commit, branch, patch, or working-tree diff; preparing a PR or commit description; deciding whether a change is too large; writing review comments; or responding to reviewer feedback."
---

# Google-Style Review Practice for Fullmag

Use this skill for review and review-writing work. The user instruction and root `AGENTS.md` take precedence. Reuse any already loaded domain skill and do not read it twice in one turn.

## Review standard

Approve a change when it improves system health and meets the relevant Fullmag correctness, architecture, verification, security, accessibility, and reproducibility gates. Do not block on taste or perfection. Block correctness, maintainability, canonical physics semantics, resource-first API, security, accessibility, or reproducibility regressions.

Technical facts, tests, benchmarks, specs, ADRs, physics notes, and project conventions outweigh personal preference. Label polish as a suggestion or nit.

## Reviewer workflow

1. Read the request, issue, PR description, or diff summary and state the intended behavior.
2. Find main files first; review design and behavior before mechanical files.
3. Read tests early enough to verify that they would fail for the claimed bug or contract break.
4. Review every human-written line in scope, or state the narrower scope explicitly.
5. Evaluate design, functionality, Fullmag invariants, complexity, tests, naming, documentation, and style.
6. Require visual/browser proof for changed UI behavior and OpenAPI/resource checks for changed resource/API behavior.
7. If the size prevents confident review, identify the highest-risk surface and request a split only when the split is necessary for reliable review. A large but coherent change may be reviewed as one unit.

## Comment severity

Use direct labels:

- `Blocker:` must be fixed before merge;
- `Required:` should be fixed in this change unless there is a strong technical reason;
- `Suggestion:` likely improvement;
- `Nit:` polish that should not block;
- `FYI:` context for later.

Comments address code and explain the technical reason where needed.

## Author workflow

Keep changes small and self-contained. Separate behavior changes from broad refactors, generated churn, or formatting sweeps unless the cleanup directly supports the change. Descriptions state what changed, why, tradeoffs, user-visible behavior, tests, and known limits. Do not repeat a passing check without a new change, failure, or unresolved concern.

## Feedback

Understand the reviewer request before changing code. When disagreeing, answer with tradeoffs and evidence, and escalate to the relevant owner, ADR, or spec if consensus stalls.
