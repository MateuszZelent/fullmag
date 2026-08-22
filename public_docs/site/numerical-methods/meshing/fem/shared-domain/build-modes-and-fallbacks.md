---
title: FEM Build Modes and Fallbacks
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-shared-domain-build-modes-and-fallbacks)=
# FEM Build Modes and Fallbacks

`build_mode`, `fallbacks_triggered`, and `degraded` are first-class provenance.

Typical distinctions include:

- conformal CAD/OCC shared domain;
- component-aware geometry route;
- bounded mixed-element route;
- algorithm retry that preserves topology;
- concatenated STL fallback that may lose semantic identity.

A fallback may recover a mesh but cannot inherit the scientific claim of the requested mode.
Strict mode rejects any substitution that violates requested topology, airbox shape, selector,
periodicity, or exact-layer semantics.
