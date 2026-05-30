# Mesh System Holistic Audit And Repair Implementation Plan

> **For agentic workers:** Implement this plan task by task. Use isolated exploration or subagents only when the current tool policy allows it. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Fullmag FEM shared-domain meshing logically consistent from Python DSL intent through ProblemIR/runtime metadata, Gmsh realization, mesh build provenance, API v2 resources, and control-room diagnostics.

**Architecture:** Keep one conforming FEM shared-domain solver mesh. Treat universe/airbox, per-object bulk sizing, interface refinement, transition grading, edge/corner refinement, thin-film presets, swept intent, quality metrics, and UI inspection as separate semantic layers that converge into one realized mesh and one resource-first browser contract.

**Tech Stack:** Python `packages/fullmag-py`, Gmsh 4.15, pytest, Rust `crates/fullmag-api`, OpenAPI v2, generated TypeScript transport, `ControlRoomApi`, React/Next `apps/control-room`, Vitest, Playwright/browser smoke checks where viewport behavior changes.

---

## 1. Current-State Summary

The current worktree already contains important mesh fixes:

- airbox grading is centralized in `_airbox_grading.py`,
- production OCC airbox grading uses a farthest-corner distance and rectangular envelope,
- object priority under coarse airbox has targeted tests,
- thin-film intent exists as `mesh_strategy="thin_film_tetrahedral"`,
- frontend mesh diagnostics expose more mesh/quality information than before.

The remaining risk is not a single isolated bug. The risk is cross-layer drift:

- Python DSL can express intent that the Gmsh realization only partially honors,
- mesh build reports can describe intended operations rather than realized operations,
- frontend UI can show aggregate numbers without enough scoped evidence to diagnose airbox/object mesh quality,
- tests cover many planner/configuration contracts but still under-cover realized Gmsh distance-band behavior.

## 2. Non-Negotiable Invariants

1. FEM with `study_universe` produces one final conforming shared-domain solver mesh.
2. Universe/airbox mesh config and per-object mesh config remain distinct.
3. Object sizing must take priority at shared object-air interfaces.
4. Airbox grading must adapt to object/interface/edge/corner features, not coarsen them.
5. Requested intent and realized behavior must both be visible in provenance.
6. UI mesh diagnostics must be scoped enough to distinguish total mesh, magnetic object parts, airbox volume, interface, and outer boundary.
7. Browser data access must stay resource-first: OpenAPI v2, generated types/transport, handwritten facade, resource hooks, codecs, module adapters.

## 3. File Map

### Python DSL And Metadata

- `packages/fullmag-py/src/fullmag/world.py`
  - Public `body.mesh(...)`, `body.mesh.thin_film(...)`, universe mesh controls, and mesh metadata export.
- `packages/fullmag-py/src/fullmag/model/discretization.py`
  - Per-object recipe schema and IR lowering.
- `packages/fullmag-py/src/fullmag/model/problem.py`
  - ProblemIR construction and mesh workflow propagation.
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
  - Python script round-trip/export of mesh controls.

### Python Meshing Core

- `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py`
  - Shared airbox distance and geometric/linear grading helper.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
  - Production conformal OCC shared-domain path.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
  - GEO/OCC airbox helper paths and deprecated single-object airbox path.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
  - Gmsh mesh options, size fields, boundary layer fields, selector application.
- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
  - Runtime metadata to Gmsh field-stack planning.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
  - STL/component-aware fallback generation paths.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
  - Swept/layered/thin-film related meshing helpers.
- `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
  - Requested-vs-realized operation status and build provenance.
- `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`
  - Shared-domain build report schema and serialized diagnostics.
- `packages/fullmag-py/tests/test_meshing.py`
  - Primary Python meshing test suite.
- `packages/fullmag-py/tests/test_api.py`
  - Public Python API and export/round-trip tests.

### API And Frontend

- `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
  - Mesh API v2 resources.
- `crates/fullmag-api/src/openapi_v2.rs`
  - OpenAPI v2 route registration.
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
  - Handwritten frontend API facade.
- `apps/control-room/src/kernel/api/apiPaths.ts`
  - Central path helpers for frontend v2.
- `apps/control-room/src/kernel/resources/*mesh*`
  - Resource hooks and cache/refresh semantics for mesh data.
- `apps/control-room/src/modules/inspector/panels/*Mesh*`
  - Mesh and mesh-quality UI panels.
- `apps/control-room/src/modules/viewport-3d/*`
  - 3D mesh/airbox/object visualization.
- `apps/control-room/src/modules/viewport-2d/*`
  - Cross-section/mesh-section visualization if enabled by current worktree.

## 4. Workstream A - Backend Algorithm Correctness

### Task A1: Fix multi-object OCC mesh-option sanitization

**Problem:** `_gmsh_occ.generate_shared_domain_mesh_via_occ()` sanitizes CSG mesh options against `geometries[0]` only. A multi-object mesh with a lofted `ArchWaveguide` not in first position can keep Delaunay even though the sanitizer knows Delaunay is unsafe for that geometry class.

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`

**Steps:**

- [x] Add a failing test with at least two geometries where the first geometry is not an `ArchWaveguide` and a later geometry is a lofted `ArchWaveguide`; assert sanitized `algorithm_3d` resolves to HXT.
- [x] Replace first-geometry sanitization with all-geometry sanitization.
- [x] Keep the existing single-geometry behavior unchanged.
- [x] Run the focused sanitizer/fallback tests.

**Verification:**

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k "arch_waveguide or conformal_occ or algorithm" -vv
```

### Task A2: Align edge transition semantics with physics note 0102

**Problem:** non-box edge distance fields still inherit surface `transition_distance` when `edge_transition_distance` is absent. The docs say edge/corner spans are distinct so a long surface transition does not over-refine a large airbox.

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- Modify: `packages/fullmag-py/tests/test_meshing.py`
- Check: `docs/physics/0102-airbox-mesh-grading-geometric.md`

**Steps:**

- [x] Update the edge test so `transition_distance` alone does not expand `EdgeDistanceThreshold`.
- [x] Keep `edge_transition_distance` as the only control that expands the edge plume beyond `edge_thickness`.
- [x] Preserve the explicit `edge_transition_distance` test.
- [x] Re-run perimeter refinement tests.

**Verification:**

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k "edge_threshold or corner_threshold or perimeter_refinement" -vv
```

### Task A3: Make non-analytic transition shell grading geometric

**Problem:** analytic box transition fields set `Grading="geometric"`, but generic `TransitionShellThreshold` fields do not pass grading even though `_gmsh_fields.py` supports geometric entity-distance fields.

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` only if needed
- Modify: `packages/fullmag-py/tests/test_meshing.py`
- Update checklist: `docs/physics/0102-airbox-mesh-grading-geometric.md`

**Steps:**

- [x] Add/adjust a test proving component-aware non-box transition fields carry `Grading="geometric"`.
- [x] Ensure `_configure_mesh_size_fields()` passes `Grading` into `_add_component_surface_threshold_field()`.
- [x] Keep explicit `transition_distance=0` disabling behavior.
- [x] Mark the physics-note checklist item complete only after tests pass.

**Verification:**

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k "transition_field or field_stack_component_aware" -vv
```

### Task A4: Report realized boundary-layer status

**Problem:** `_add_boundary_layer_field()` can return `degraded` or `ignored`, but `mesh_build_report.py` derives `boundary_layer.status` from requested parameters and selectors, not the actual Gmsh application result.

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` if report schema needs a field
- Test: `packages/fullmag-py/tests/test_meshing.py`

**Steps:**

- [x] Extend `MeshOptionsApplicationReport` with boundary-layer status, reason, and field id.
- [x] Feed the application report into shared-domain build report construction.
- [x] Update operation status to distinguish `applied`, `degraded`, and `ignored`.
- [x] Add a fake-Gmsh test where `setAsBoundaryLayer` raises and provenance reports `degraded`.

**Verification:**

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k "boundary_layer" -vv
```

## 5. Workstream B - Realized Mesh Validation

### Task B1: Add airbox distance-band regression tests

**Problem:** current tests prove size-field configuration but do not sufficiently prove final realized Gmsh mesh quality distribution in diagonal/corner airbox regions.

**Files:**

- Modify: `packages/fullmag-py/tests/test_meshing.py`
- Possibly add helper: `packages/fullmag-py/tests/meshing_diagnostics.py`

**Steps:**

- [x] Build a small box/cylinder shared-domain mesh with geometric airbox grading.
- [x] Classify airbox tetrahedra by distance band from object bounds/interface.
- [x] Assert every near/mid/far band has nonzero airbox elements.
- [x] Assert characteristic edge size grows monotonically within tolerance from near object to far airbox.
- [x] Assert corner/diagonal bins are populated and not entirely flat at `h_outer`.
- [x] Keep the test small enough for local CI.

**Verification:**

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k "airbox_distance_band or airbox_geometric" -vv
```

### Task B2: Add thin-film arch smoke coverage with realistic defaults

**Problem:** thin-film strategy currently documents a tetrahedral feature-aware preset. It still needs a small, deterministic materialization smoke that proves the preset avoids pathological element counts and preserves through-thickness intent.

**Files:**

- Modify: `packages/fullmag-py/tests/test_meshing.py`
- Check: `examples/arch_waveguide_relax_50nm.py`

**Steps:**

- [x] Add a compact flat `ArchWaveguide` test using `mesh.thin_film(...)`.
- [x] Assert the build report records `thin_film` requested and `feature_aware_tetrahedral` realized.
- [x] Assert object and airbox mesh part summaries are both present.
- [x] Assert edge/corner fields exist only when requested or produced by the preset.

**Verification:**

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k "thin_film or arch_waveguide" -vv
```

## 6. Workstream C - Python DSL, IR, And Round-Trip

### Task C1: Audit and test mesh intent round-trip

**Problem:** mesh correctness is only useful if public Python DSL, ProblemIR/runtime metadata, and script export carry the same semantic intent.

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/world.py` if audit finds missing fields
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py` if metadata lowering is incomplete
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py` if export drops fields
- Modify: `packages/fullmag-py/tests/test_api.py`
- Modify: `packages/fullmag-py/tests/test_meshing.py`

**Steps:**

- [x] Test that `body.mesh.thin_film(...)` exports all resolved mesh controls.
- [x] Test that explicit `edge_transition_distance` and `corner_transition_distance` round-trip.
- [x] Test that boundary-layer selectors round-trip separately from resolved Gmsh tags.
- [x] Test that public DSL export does not flatten airbox controls into per-object controls.

**Verification:**

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_api.py \
  packages/fullmag-py/tests/test_meshing.py \
  -k "mesh or thin_film or boundary_layer or script_builder" -vv
```

## 7. Workstream D - API v2 And Frontend Diagnostics

### Task D1: Prove mesh resources expose scoped counts and statistics

**Problem:** users need to see how many points/nodes/elements belong to the airbox and object regions. The UI must not rely on ambiguous total-node counts when regions share interface nodes.

**Files:**

- Inspect/modify: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
- Inspect/modify: `crates/fullmag-api/src/openapi_v2.rs`
- Inspect/modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Inspect/modify: `apps/control-room/src/kernel/resources/*mesh*`
- Inspect/modify: `apps/control-room/src/modules/inspector/panels/*Mesh*`
- Inspect/modify: `apps/control-room/src/modules/explorer/*mesh*`

**Steps:**

- [x] Confirm API distinguishes total mesh nodes from scoped part nodes and element counts.
- [x] If missing, add a mesh-part summary field for `node_count`, `unique_point_count` naming, `tetra_count`, `boundary_face_count`, and characteristic-size bins.
- [x] Regenerate OpenAPI and generated frontend types if backend schemas change.
- [x] Display scoped airbox/object mesh counts in the inspector without direct component fetches.
- [x] Add tests for facade/resource hook/model builder.

**Verification:**

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test -- src/kernel src/modules/inspector src/modules/explorer
rg "fetch\\(" apps/control-room/src
rg '"/v2/' apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'
```

### Task D2: Keep mesh visualization resource-first

**Problem:** mesh rendering, airbox overlays, cross-sections, and quality panels must consume resource hooks and domain adapters, not hidden preview/bootstrap state.

**Files:**

- Inspect/modify: `apps/control-room/src/modules/viewport-3d/*`
- Inspect/modify: `apps/control-room/src/modules/viewport-2d/*`
- Inspect/modify: `apps/control-room/src/kernel/visualization/*`
- Inspect/modify: `apps/control-room/src/kernel/realtime/*`

**Steps:**

- [x] Search for direct `fetch()` in control-room modules.
- [x] Search for `/v1`, `bootstrap`, `poll`, and legacy preview paths.
- [x] Ensure websocket events invalidate resources rather than carrying full mesh payloads.
- [x] Ensure viewport modules do not rebuild topology when only field buffers or display state changes.
- [x] Add or update focused tests for mesh-resource invalidation and viewport model building.

**Verification:**

```bash
rg "fetch\\(" apps/control-room/src
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src
rg "/v2/" apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
```

## 8. Workstream E - Final Gates

Run these before marking the mesh audit/repair complete:

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m py_compile \
  packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py \
  packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py \
  packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py

env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py -vv

env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_api.py -vv

cargo test -p fullmag-api router_v2 --no-fail-fast

pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test

git diff --check -- \
  packages/fullmag-py/src/fullmag/meshing \
  packages/fullmag-py/tests/test_meshing.py \
  packages/fullmag-py/tests/test_api.py \
  crates/fullmag-api/src \
  apps/control-room/src \
  docs/physics \
  docs/plans
```

For viewport or cross-section rendering changes, also run a browser smoke that proves the canvas is visible, the WebGL context is not lost, and the drawing buffer is nonzero.

## 9. Done Criteria

- [x] Backend mesh algorithms do not have known order-dependent sanitizer behavior.
- [x] Edge/corner/surface transition semantics match physics note 0102.
- [x] Non-box transition shell grading uses the same geometric growth semantics as analytic box transitions.
- [x] Boundary-layer build provenance reports realized Gmsh status, not only requested intent.
- [x] Realized airbox distance-band tests cover near/mid/far/corner regions.
- [x] Thin-film preset has deterministic smoke coverage and clear provenance.
- [x] Python DSL, ProblemIR metadata, runtime metadata, and script export preserve mesh controls.
- [x] API v2 exposes scoped mesh counts/statistics needed for airbox/object diagnosis.
- [x] Control-room mesh UI reads through typed API facade/resource hooks and no direct transport.
- [x] Final Python, Rust API, frontend type/test, and diff hygiene gates pass.

## 10. Current Audit Snapshot - 2026-05-30

This section records the holistic code audit result before implementing the repair workstreams above. The current state is not cleanly wrong end-to-end: many important contracts are implemented and tested. The remaining issues are narrower cross-layer logic gaps and missing realized-mesh coverage.

### What Is Currently Sound

- Airbox grading is centralized in `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py`.
- OCC shared-domain airbox grading uses farthest-corner object-to-airbox distance and a rectangular envelope instead of the old single-axis `DistMax`.
- Object sizing priority under coarse airbox settings is covered by a realized Gmsh regression test.
- Python DSL `body.mesh(...)`, `body.mesh.thin_film(...)`, runtime metadata, and script export preserve the currently implemented mesh controls.
- API v2 exposes scoped mesh parts with `node_count`, `element_count`, `boundary_face_count`, explicit `node_indices`, and part topology endpoints.
- The control-room Airbox Mesh Policy panel can display airbox `Points / nodes`, tetrahedra, boundary faces, surface faces, and the `node_indices` source.
- Direct `fetch(` was not found in `apps/control-room/src`; inspected mesh panels use the typed API facade and resource hooks.

### Findings Requiring Repair

1. **Order-dependent OCC sanitizer.** `generate_shared_domain_mesh_via_occ()` calls `_sanitize_csg_mesh_options(..., geometries[0], ...)`, so multi-object runs only inspect the first geometry when deciding Delaunay-to-HXT fallback behavior. A later lofted `ArchWaveguide` can therefore bypass an existing safety rule.

2. **Edge transition semantics are inconsistent with corner semantics.** For non-box geometry, `EdgeDistanceThreshold` expands with `entry.get("edge_transition_distance") or entry.get("transition_distance")`. Corner refinement already avoids inheriting surface transition distance unless `corner_transition_distance` is explicit. Edge should follow the same independent-control rule.

3. **Generic transition shells omit geometric grading.** The analytic flat-arch box path emits `AxisAlignedBoxDistanceThreshold` with `Grading="geometric"`, but generic component-aware `TransitionShellThreshold` does not. `_gmsh_fields.py` already supports geometric entity-distance fields, so this is a planner/metadata gap rather than a Gmsh capability gap.

4. **Boundary-layer operation status is inferred, not realized.** `_add_boundary_layer_field()` can return `degraded`, but `mesh_build_report.py` reports boundary-layer status from requested values and resolved selectors. Provenance must carry the actual application result from `_apply_mesh_options()`.

5. **Airbox realized distance-band coverage is still too weak.** Existing tests verify field configuration and some realized object-priority behavior, but they do not yet prove near/mid/far/corner airbox bins are populated and grow monotonically with distance.

6. **UI selection semantics are overloaded.** `airbox.mesh` currently selects both "Airbox Mesh Policy" and "Airbox Quality" tree nodes. The panel shows useful diagnostics, but the semantic split between editing policy and inspecting realized quality should be made explicit.

### Verification Evidence From This Audit

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py -vv
# 155 passed, 1 skipped

env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  packages/fullmag-py/tests/test_api.py \
  -k "airbox or transition_field or edge_threshold or corner_threshold or boundary_layer or conformal_occ or thin_film or swept or mesh_part or mesh_workflow" -vv
# 48 passed, 262 deselected

pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/ScopedMeshQualityPanels.test.tsx \
  src/modules/inspector/inspectorRegistry.test.tsx \
  src/modules/explorer/builders/buildModelTree.test.ts
# 3 files passed, 21 tests passed

cargo test -p fullmag-api subset_part_mesh_uses_explicit_node_indices_for_shared_airbox_nodes
# 1 passed

git diff --check -- docs/plans/active/mesh-system-holistic-audit-and-repair-plan-2026-05-30.md
# passed
```

The broader command `pnpm --dir apps/control-room test -- ...` invoked the full Vitest suite and failed in `src/design/styles/designStyles.test.ts` on a Catppuccin token-location assertion. That failure is unrelated to mesh logic, but it means the current frontend-wide test gate is not green.

## 11. Repair Completion Snapshot - 2026-05-30

The repair workstreams above have been implemented and verified in the current worktree.

### Implemented Repairs

- Multi-object OCC sanitizer now evaluates all geometries before choosing the realized 3D algorithm, so a later lofted `ArchWaveguide` cannot bypass the unsafe-Delaunay guard.
- Non-box edge refinement no longer inherits surface `transition_distance`; only explicit `edge_transition_distance` expands the edge plume beyond `edge_thickness`.
- Generic component-aware `TransitionShellThreshold` fields now carry geometric grading metadata, matching the analytic box transition path.
- Boundary-layer provenance now reports the realized Gmsh application result (`applied`, `degraded`, or `ignored`) instead of inferring status only from requested intent.
- Realized Gmsh airbox coverage now has a distance-band regression that checks near/mid/far and diagonal airbox bins.
- Thin-film flat `ArchWaveguide` materialization now has deterministic smoke coverage for provenance, partitioning, and bounded element count.
- Airbox mesh policy and airbox mesh quality selections are distinct in the control-room tree/inspector model.
- Full frontend quality gates were made green by aligning the design-token test with the current `tokens.css`/`theme.css` split and removing a lint-blocking synchronous state update in the 2D viewport theme-color effect.

### Final Verification Evidence

```bash
env PYTHONPATH=packages/fullmag-py/src python3 -m py_compile \
  packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py \
  packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py \
  packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py
# passed

env PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_api.py \
  packages/fullmag-py/tests/test_meshing.py -vv
# 313 passed, 1 skipped

cargo test -p fullmag-api router_v2 --no-fail-fast
# 246 passed

pnpm --dir apps/control-room generate:api
# passed

pnpm --dir apps/control-room lint
# passed

pnpm --dir apps/control-room typecheck
# passed

pnpm --dir apps/control-room test
# 184 files passed, 1006 tests passed

CONTROL_ROOM_URL=http://localhost:3100/workspace \
  pnpm --dir apps/control-room smoke:cross-section-workflow
# Cross-section workflow smoke passed: viewport-2d=webgl requests=37

git diff --check -- \
  packages/fullmag-py/src/fullmag/meshing \
  packages/fullmag-py/tests/test_meshing.py \
  packages/fullmag-py/tests/test_api.py \
  crates/fullmag-api/src \
  apps/control-room/src \
  docs/physics \
  docs/plans
# passed
```

The Playwright cross-section smoke had to be rerun outside the sandbox because sandboxed Chromium failed at startup with `sandbox_host_linux.cc:41 shutdown: Operation not permitted`.
