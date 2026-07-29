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
