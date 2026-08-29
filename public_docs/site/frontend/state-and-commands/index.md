---
title: Frontend State and Commands
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-state-and-commands-root)=
# Frontend State and Commands

Frontend state is resource-oriented. Reads use versioned resource keys and caches; writes execute
commands or replace canonical resources. Components should not maintain a second hidden simulation
model.

Key invariants:

- drafts are local and isolated until Apply;
- successful writes increment or return a backend revision;
- dependent resources are invalidated explicitly;
- command acceptance, command completion, and scientific qualification are separate states;
- current and latest-successful artifacts are not interchangeable;
- backend errors are shown verbatim or through bounded, non-misleading summaries.

This model is essential for geometry and mesh editing because a small authored change invalidates
all downstream mesh and field identities.
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
