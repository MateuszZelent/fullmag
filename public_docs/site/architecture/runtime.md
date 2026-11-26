---
title: Runtime and provenance
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/runtime-distribution-and-managed-backends-v1.md
---

(public-docs-architecture-runtime)=
# Runtime and provenance

FullMag presents one launcher and one Control Room across bundled CPU solvers and managed CUDA/FEM
container runtimes. Daily development and interactive execution run inside a per-checkout Docker
Compose DEV group (`compose.dev.yaml`) containing two permanent services: `backend` (API server +
incrementally compiled Rust/C++/CUDA solvers) and `frontend` (Next.js Control Room dev server),
with host-configured result storage (`FULLMAG_PROJECT_STORAGE_ROOT`) separated from Docker named
build-cache volumes.

## Two-plane transport and live Python integration

Runtime interaction splits cleanly into two planes served over OpenAPI v2 and companion HTTP/WS
channels:

1. **JSON Control Plane & WebSocket Invalidation**: Session lifecycle, authoring mutations fenced
   by `scene_revision`, readiness checks, solver command queues, persistent session error history
   (`sessionErrorStore`), and capability/provenance metadata travel as lightweight revisioned JSON
   resources (`ControlRoomApi`). `RealtimeClient` and `RealtimeInvalidationBridge` emit compact
   invalidation notifications on state changes without pushing dense field arrays over WebSockets;
   busy performance-endpoint reads are treated as deferred rather than failing the UI.
2. **Binary Data Plane (12 Versioned Codecs)**: Spatial vector/scalar fields (`FMVP` / `FMMI`), FEM
   topology connectivity and markers (`FMMT`), FDM active/region masks (`FMRM`, `FMBM`), FDM planar
   grid overlays (`FMFG`), 2D cross-section payloads (`FMCS`, `FMQS`), mesh quality distributions
   (`FMMQ`), periodic facet maps (`FMPP`), sampled chart tables (`FMTB`), bounded materialized
   dataset slices (`FMDS`), and saved spatial supports (`FMSP`) stream over HTTP binary endpoints
   with typed `ArrayBuffer` validation.
3. **Live Python Client Presence (`fullmag.live`)**: Interactive scripts using `fm.connect()` share
   the same session API via `LiveSession` (`packages/fullmag-py/src/fullmag/live/_session.py`).
   Each live script registers a unique `python-<hex>` `client_id` and transmits 10 s presence
   heartbeats to `/v2/sessions/current/clients/{client_id}` (30 s API expiry TTL), keeping browser
   tabs and Python scripts synchronized on the active session.

## Prepared previews, GPU preflight, and artifact persistence

- **Prepared FDM/FEM field previews**: Both FDM and FEM sessions can evaluate and expose initial
  magnetization and material fields on the built discretization before starting a study run, so
  textures, absorbing boundaries, and masks are inspectable immediately in the 3D/2D viewports.
- **Fail-closed GPU memory preflight**:
  - FDM CUDA queries exact `cufftMakePlanMany` workspace sizes against live `cudaMemGetInfo`
    before allocating (`context_preflight_single_grid_workspace`,
    `context_preflight_multilayer_workspace_v2`), failing atomically with
    `fdm_gpu_workspace_oom_preflight` and zero leaked device buffers on OOM.
  - FEM GPU direct sparse solvers (`cuDSS` Poisson, PBC, FEM/BEM, eigensolve shifts, and driven
    response) query `CUDSS_DATA_MEMORY_ESTIMATES` against the live device budget
    (`check_demag_cudss_factor_fits`) before factorization.
- **Batched Zarr autosave & streaming run attestation**: High-cadence field outputs batch Zarr
  metadata writes (`ZarrFieldMetadataBatch`), and large result bundles stream regular-file
  checksums during run metadata attestation (`hash_regular_file_snapshot`) rather than buffering
  entire result files in RAM.

## Inspectable runtime provenance

Every published result must make these values inspectable:

- requested backend, device, precision, and linear/relaxation solver policy;
- resolved backend, device, precision, and solver realization (plus any fallback reason);
- capability and qualification status;
- realized mesh or grid identity and topology certificate;
- GPU device identity when GPU execution is claimed;
- artifact revision, streaming attestation, and reproducibility metadata.

Compilation on a host is not proof of executed GPU work. Public pages use the strongest evidence
available and label lower-tier evidence explicitly. In the Control Room, session and runtime
provenance are exposed read-only in `RuntimeResourceInspectorPanel` (`Model Explorer -> Runtime`),
`StudyRootInspectorPanel`, `StudyExecutionInspectorPanel`, `StatusBarModule`, and the Footer Dock
(`Telemetry`, `Engine`, `Operations`, `Problems`), keeping requested intent (`auto` vs. pinned
`cpu`/`gpu`) separate from resolved execution without silent CPU fallback when GPU is forced. See
also {ref}`numerical-methods-performance-fem-spectral-multiphysics` for runtime and I/O system
optimizations.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `crates/fullmag-cli/src/main.rs` | `main` | launcher entry point and script-mode dispatch |
| `packages/fullmag-py/src/fullmag/runtime/loader.py` | `LoadedStage` | stage capture lowering and launcher metadata |
| `crates/fullmag-ir/src/plan.rs` | `ExecutionPlanIR` | resolved plan and provenance representation |
| `backends/fdm/gpu/cuda/runtime/context.cu` | `context_preflight_single_grid_workspace`, `context_preflight_multilayer_workspace_v2` | exact cuFFT and multilayer GPU memory preflight |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `check_demag_cudss_factor_fits` | FEM GPU `cuDSS` factor budget preflight |
| `crates/fullmag-runner/src/artifact_pipeline.rs` | `ZarrFieldMetadataBatch` | batched Zarr field metadata persistence |
| `crates/fullmag-workspace-inspect/src/manifest.rs` | `hash_regular_file_snapshot` | streaming run metadata attestation for large results |
