---
title: Canonical semantic model
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/problem-ir-v0.md
---

(public-docs-architecture-semantic-model)=
# Canonical semantic model

FullMag uses one semantic flow:

Python or browser authoring → ProblemIR → validation and normalization → capability planning →
runtime execution → fields, observables and artifacts.

The public contract preserves requested intent and resolved execution. Automatic fallback, when
allowed, must be visible in provenance. An explicitly requested GPU path must fail clearly when
its requirements are unavailable.

| Concept | Public meaning |
|---|---|
| ProblemIR | canonical lowered meaning of the physical problem |
| Study | declared execution and analysis intent |
| Session | user-visible execution context |
| Run | one execution attempt |
| Stage | one physical or numerical phase |
| Field | spatial quantity such as magnetization or effective field |
| Observable | scalar, vector or derived quantity exposed for inspection |
| Artifact | reproducible output with provenance |

Detailed authoring constructors and validation contracts are documented under
{doc}`../python-api/problem/index`.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/problem.py` | `Problem.to_ir` | Python-to-IR lowering and validation |
| `crates/fullmag-ir/src/lib.rs` | `ProblemIR` | canonical problem data contract |
| `crates/fullmag-plan/src/lib.rs` | `plan` | validation and capability planning |
