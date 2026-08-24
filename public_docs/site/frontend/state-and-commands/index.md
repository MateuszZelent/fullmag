---
title: Frontend State and Commands
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/frontend-v2/03-api-integration-layer.md, docs/specs/frontend-v2/04-state-management.md
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
