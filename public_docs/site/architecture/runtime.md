---
title: Runtime and provenance
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/runtime-distribution-and-managed-backends-v1.md
---

(public-docs-architecture-runtime)=
# Runtime and provenance

FullMag presents one launcher and one control room even when implementation uses managed runtime
packs. Lightweight CPU paths may be bundled; CUDA FDM and MFEM, hypre and libCEED FEM paths may
require managed runtimes.

Every published result must make these values inspectable:

- requested backend and runtime,
- resolved backend and runtime,
- capability and qualification status,
- precision and mesh or grid identity,
- device identity when GPU execution is claimed,
- artifact revision and reproducibility metadata.

Compilation on a host is not proof of executed GPU work. Public pages use the strongest evidence
available and label lower-tier evidence explicitly.
## Control Room crosswalk

This architecture page has no direct authoring screen. Use the object, material, physics, mesh, or stage editor named by the relevant terminal API page; architecture concepts are currently `inspection-only` unless a concrete UI owner is listed. `TODO: frontend support` applies to architecture capabilities without a corresponding control. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

This page documents architecture rather than a standalone Python callable. Exact constructors, arguments, validation, and examples belong to the linked Python API pages; do not infer a public function from an internal architecture term.

## Physics and bibliography scope

No independent physical model is introduced here. Scientific equations are owned by the applicable physics or numerical-methods page. Bibliography: not applicable to this architecture overview; implementation ownership is recorded in the source-code references on the terminal page.
## Source-code index

- No standalone Python callable is introduced by this architecture page. Use the exact source symbol named by the linked API or implementation page; architecture terms alone are not public functions.

