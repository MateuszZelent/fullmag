---
title: Current and Excitations
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-root)=
# Current and Excitations

Current and excitation pages cover current transport, prescribed currents, regional field drives,
and radio-frequency or microwave drives such as a microstrip or coplanar waveguide antenna.

```{toctree}
:maxdepth: 1

current-transport
prescribed-current
regional-field-drive
rf-drive
microstrip-antenna
cpw-antenna
```
## Control Room crosswalk

Supported drives are configured from the object or stage authoring flow, not from a category-level screen. Use `Model Explorer -> Objects -> <object> -> Physics` or the applicable stage editor where the child page identifies a live control. `TODO: frontend support` applies to excitation fields without a matching inspector control. See {doc}`/frontend/capability-register`.

## API and source scope

This is a navigation page with no standalone constructor. Each child page owns its exact Python signature, units, failure semantics, bibliography, and source-code index.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
