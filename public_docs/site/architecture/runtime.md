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

## Two-Plane Transport and Live Python Integration

Runtime interaction splits cleanly into two planes served over OpenAPI v2 and companion HTTP/WS channels:

1. **JSON Control Plane & WebSocket Invalidation**: Session lifecycle, authoring mutations fenced by `scene_revision`, readiness checks, solver command queues, and capability/provenance metadata travel as lightweight revisioned JSON resources (`ControlRoomApi`). `RealtimeClient` and `RealtimeInvalidationBridge` emit compact invalidation notifications on state changes without pushing dense field arrays over WebSockets.
2. **Binary Data Plane**: Spatial vector/scalar fields (`FMVP`), FEM topology connectivity and markers (`FMMT`), FDM active/region masks (`FMRM`, `FMBM`), 2D cross-section payloads (`FMCS`, `FMQS`), mesh quality distributions (`FMMQ`), periodic facet maps (`FMPP`), and sampled chart tables (`FMTB`) stream over HTTP range/binary endpoints with typed `ArrayBuffer` validation.
3. **Live Python Client Presence (`fullmag.live`)**: Interactive scripts using `fm.connect()` share the same session API via `LiveSession` (`packages/fullmag-py/src/fullmag/live/_session.py`). Each live script registers a unique `python-<hex>` `client_id` and transmits `10 s` presence heartbeats to `/v2/sessions/current/clients/{client_id}` (`30 s` API expiry TTL), keeping browser tabs and Python scripts synchronized on the active session.

Every published result must make these values inspectable:

- requested backend and runtime,
- resolved backend and runtime,
- capability and qualification status,
- precision and mesh or grid identity,
- device identity when GPU execution is claimed,
- artifact revision and reproducibility metadata.

Compilation on a host is not proof of executed GPU work. Public pages use the strongest evidence
available and label lower-tier evidence explicitly. In the Control Room, session and runtime
provenance are exposed read-only in `RuntimeResourceInspectorPanel` (`Model Explorer -> Runtime`),
`StudyInspectorPanel`, `StatusBarModule`, and the Footer Dock (`Telemetry`, `Engine`, `Operations`,
`Problems`), keeping requested intent (`auto` vs. pinned `cpu`/`gpu`) separate from resolved
execution without silent CPU fallback when GPU is forced.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `crates/fullmag-cli/src/main.rs` | `main` | launcher entry point and script-mode dispatch |
| `packages/fullmag-py/src/fullmag/runtime/loader.py` | `LoadedStage.to_ir` | stage capture lowering and launcher metadata |
| `crates/fullmag-ir/src/plan.rs` | `ExecutionPlanIR` | resolved plan and provenance representation |
