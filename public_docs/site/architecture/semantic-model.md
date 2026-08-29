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

Detailed API pages are published only after the corresponding contract and validation scope are
stable enough to publish.
## Control Room crosswalk

This architecture page has no direct authoring screen. Use the object, material, physics, mesh, or stage editor named by the relevant terminal API page; architecture concepts are currently `inspection-only` unless a concrete UI owner is listed. `TODO: frontend support` applies to architecture capabilities without a corresponding control. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

This page documents architecture rather than a standalone Python callable. Exact constructors, arguments, validation, and examples belong to the linked Python API pages; do not infer a public function from an internal architecture term.

## Physics and bibliography scope

No independent physical model is introduced here. Scientific equations are owned by the applicable physics or numerical-methods page. Bibliography: not applicable to this architecture overview; implementation ownership is recorded in the source-code references on the terminal page.
## Source-code index

- No standalone Python callable is introduced by this architecture page. Use the exact source symbol named by the linked API or implementation page; architecture terms alone are not public functions.

