---
title: Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-boundary-conditions-root)=
# Boundary Conditions

Boundary conditions constrain the solution at domain boundaries. This family covers periodic
boundary conditions, Floquet boundary conditions for wave problems, and mechanical boundary
conditions for magnetoelastic studies.

```{toctree}
:maxdepth: 1

periodic-boundary-conditions
floquet-boundary-conditions
mechanical-boundary-conditions
```
## Control Room crosswalk

The category has no standalone editor. Configure supported boundary data through the relevant object or stage editor; the terminal child pages are authoritative for exact fields. `TODO: frontend support` applies to boundary-condition parameters without a matching editor control. See {doc}`/frontend/capability-register` for the current capability register.

## Physics and source scope

This index introduces no independent physical model and no Python constructor contract. Governing equations, exact Python examples, limitations, bibliography, and source-code references are maintained on the linked terminal pages.

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
