---
title: Problem
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-root)=
# Problem

The Problem family describes problem-level authoring: the canonical `Problem` aggregate and its
associated `PhysicsGraph`, parameter library (`ParameterDefinition`, `ParameterExpression`,
`ParameterValue`), component/model authoring definitions (`ComponentDefinition`, `ModelDefinition`),
fail-closed validation (`TypedValidationError`), serialized `ProblemIR`, and Python round-trip
lowering behavior. A study lowers into this canonical model; these pages document the mapping, not a
parallel solver API.

```{toctree}
:maxdepth: 1

problem
validation
problem-ir
round-trip
```
