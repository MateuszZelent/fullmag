---
title: Problem
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-root)=
# Problem

The Problem family describes problem-level authoring: the canonical `Problem`/`ProblemIR` objects,
validation semantics, and Python round-trip behavior. A study lowers into this canonical model;
these pages document the mapping, not a parallel solver API.

```{toctree}
:maxdepth: 1

problem
validation
problem-ir
round-trip
```
## Control Room crosswalk

There is no standalone Problem/ProblemIR authoring route in Control Room. The UI creates supported object and stage drafts which are lowered to the canonical problem representation; direct ProblemIR fields are `TODO: frontend support`. See {doc}`/frontend/capability-register`.

## API and source scope

This index is conceptual and has no independent constructor. The linked pages provide exact Python round-trip examples, validation and failure semantics, bibliography, and source-code references.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
