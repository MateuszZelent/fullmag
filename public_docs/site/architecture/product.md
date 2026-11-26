---
title: Product architecture
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/fullmag-application-architecture-v2.md
---

(public-docs-architecture-product)=
# Product architecture

FullMag presents one coherent authoring and inspection product across five tightly coupled layers:

1. **Public Python DSL & Live Client (`packages/fullmag-py`)**: Published as `fullmag` on PyPI,
   supporting both reproducible stage-first batch studies (`fm.study(...)` + `study.stages.add_*`)
   and interactive live control (`fm.connect()`, `fm.transaction()`, `fm.run_until()`, binary
   `FMVP`/`FMTB` readback) over HTTP and WebSocket.
2. **Managed Docker Compose DEV Runtime & CLI (`crates/fullmag-cli`, `crates/fullmag-api`, `compose.dev.yaml`)**:
   Per-checkout two-service groups (`backend` + `frontend`) using isolated Docker named volumes for
   build caches and host-configured storage (`FULLMAG_PROJECT_STORAGE_ROOT`) for durable sessions,
   Zarr bundles, and provenance receipts.
3. **Browser Control Room (`apps/control-room`)**: Unified Next.js 16 / React 19 workspace with
   Start Screen hub, multi-instance tabs, contextual Ribbon, 7-tab Semantic Explorer, 162-route
   declarative Inspector specs, 3D WebGL viewport, 2D planar field map, and ECharts plots.
4. **Canonical IR, Validation & Capability Planner (`crates/fullmag-ir`, `crates/fullmag-plan`)**:
   Lowers authored models into `ProblemIR`, verifies physical/geometric constraints, resolves a
   concrete execution lane (`ExecutionPlanIR`), and rejects unsupported combinations fail-closed.
5. **Compute Backends & Artifact Pipeline (`crates/fullmag-engine`, `crates/fullmag-runner`, `backends/`)**:
   Executes structured FDM CPU (Rust/Rayon/RustFFT) and CUDA GPU (C++17/cuFFT/cuDSS) lanes,
   conforming FEM CPU (MFEM/HYPRE/PETSc/SLEPc/MUMPS) and CUDA GPU (`cuDSS`/HYPRE/custom kernels)
   lanes, full-wave FIT antenna reference solves, and batched Zarr/streaming-attested outputs.

The user authors one physical problem and receives one provenance-preserving result model. Backend
and device choices are execution decisions recorded alongside results—never a second incompatible
physics language.

## End-to-end product flow

```text
Python DSL (fm.study / fm.connect) or Browser Control Room
                       │
                       ▼
          Canonical ProblemIR + Validation
                       │
                       ▼
       Capability Planning -> ExecutionPlanIR
                       │
                       ▼
  Managed Session -> Run -> Ordered Stages (FDM / FEM / Multiphysics)
                       │
                       ▼
  Fields, Observables, Zarr Artifacts, Provenance & Streaming Attestation
                       │
                       ▼
   Control Room (3D / 2D / Charts) & Python Readback (FMVP / FMTB / Zarr)
```

For solver acceleration details across the FDM and FEM compute layers, see
{ref}`numerical-methods-performance`.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder` | stage-first public authoring and capture |
| `packages/fullmag-py/src/fullmag/live/_session.py` | `LiveSession` | interactive live Python HTTP/WebSocket bridge |
| `crates/fullmag-cli/src/main.rs` | `main` | local/container launcher entry point |
| `crates/fullmag-ir/src/lib.rs` | `ProblemIR` | canonical backend-neutral problem representation |
| `crates/fullmag-plan/src/lib.rs` | `plan` | validation and dispatch planning for the physical problem |
| `crates/fullmag-runner/src/artifact_pipeline.rs` | `ZarrFieldMetadataBatch` | batched scientific artifact persistence |
| `apps/control-room/src/kernel/api/ControlRoomApi.ts` | `ControlRoomApi` | typed browser API facade |
