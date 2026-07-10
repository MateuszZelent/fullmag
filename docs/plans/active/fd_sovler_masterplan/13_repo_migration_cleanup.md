---
title: FEM frequency-domain documentation migration policy
version: COMSOL-aligned v5.1 decision-complete
status: supporting
scope: documentation lifecycle
---

# Documentation migration policy

## Active-root policy

The active masterplan root contains current documents only. Historical diaries,
superseded plans, and append-only evidence records are forbidden in the active
root. Preserve those bodies under `old/` with the required historical header.

## Canonical discovery

Start with `00_README_CANONICAL_FULL_READ.md` and
`documentation_manifest.json`. Apply the documented authority hierarchy before
using any document as a design, implementation-order, validation, or status
source.

## Generated full pack

`fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md` is currently a disabled stale
generated snapshot, with `full_pack_generated=false` and
`full_pack_status=stale_disabled` in the manifest. Its preserved V5 body is
`old/fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5_legacy_2026-07-10.md` under the
standard historical-exclusion header.

Task 10 alone may regenerate the active full pack from manifest entries whose
`include_in_full_pack` value is true, and only after every manifest-declared
canonical input is complete and every transitional document is promotion-ready.
The regenerated pack remains non-authoritative, must not be hand-edited, and
cannot override the active source documents or the manifest. Historical
snapshots, the PDF, the readiness-matrix JSON body, and the full pack itself
are excluded from generated input.

## Status handling

Status and readiness documents record evidence scope. They cannot promote a
runtime lane from source inspection alone. Production proof requires the
applicable runtime gates and their artifacts.

Every production claim must carry the manifest-required `implementation_state`,
`validation_state`, and non-empty `validated_scope`. A production-executable
claim is not production-qualified, and narrow validation cannot promote a
broader capability.
