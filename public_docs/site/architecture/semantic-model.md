---
title: Canonical semantic model
status: draft
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/problem-ir-v0.md
---

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

Detailed API pages are published only after the corresponding contract and validation scope are
stable enough to publish.
