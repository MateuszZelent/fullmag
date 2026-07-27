# Task 2 report: canonical typed topology v2

## Status

DONE_WITH_CONCERNS. Canonical variable-arity FEM topology is implemented through Python meshing data, Rust IR, planner transformations, CLI ingestion, runner payloads, artifacts, and mechanically affected API consumers. Review remediation completed complete family-aware Jacobian sampling, immutable global ordinals, canonical facet references, exact fingerprint-domain ownership, ingress facet roles, and fail-closed legacy FMMT v1 consumers. All applicable focused gates pass. The exact CLI command in the brief cannot run because `fullmag-cli` is a binary-only package; the equivalent binary-target filter passes 13 tests.

The controller-owned `.superpowers/sdd/progress.md` and `.superpowers/sdd/task-1-report.md` remain unstaged; their independent dirty contents were not changed by this slice. No SP4 scenario, C ABI, native FEM implementation, FMMT v2 redesign, OpenAPI redesign, or Control Room file was changed. Existing FMMT v1 API callers were migrated only enough to reject mixed cells/facets with HTTP conflict before fixed-width serialization.

## Contract implemented

- Added the exact canonical wire vocabularies:
  - cells: `tet4`, `prism6`, `pyramid5`, `hex8`;
  - facets: `tri3`, `quad4`;
  - roles: `exterior`, `material_interface`, `periodic_seam`.
- Python `MeshData` now owns only typed flat connectivity and CSR offsets. Rust `MeshIR` and `FemMeshPayload` own only `FemConnectivityIR` / `FemFacetConnectivityIR` plus marker arrays.
- Added typed cell/facet iterators and views carrying canonical type, connectivity, marker/role association, local CSR ordinal, and immutable global ordinal.
- Added strict validation for unknown family strings, CSR start/monotonicity/end/length, family arity, node indices, duplicate local nodes, cell/facet marker drift, role drift, and family-aware positive orientation/Jacobian.
- Preserved tetra SICN/gamma behavior only for tet4. Other supported families expose family-aware scaled-Jacobian validation and are not mislabeled as tetra quality.
- Added explicit legacy tet4/tri3 normalization boundaries for JSON, NPZ, and Rust serde. Legacy inputs are accepted only as a complete `elements` + `boundary_faces` pair when v2 topology is absent; dual truth and partial legacy payloads reject.
- All new writers emit v2 only. Python IR emits nested `cells` / `facets`; saved NPZ uses typed flat arrays; Rust serialization emits canonical fields. Tests assert legacy keys are absent after both v2 construction and legacy normalization.
- Mixed VTK/VTU output uses native VTK codes 10/12/13/14 for tet/hex/wedge/pyramid and does not triangulate scientific cells.
- Planner analysis, grouping, packing, merge, mesh-part slicing, summaries, and artifact payloads carry variable-arity type/connectivity/markers/roles together. Cell face tables dispatch by family instead of taking the first four nodes.
- PBC and tetra-only engine/native consumers fail closed with actionable tet4/tri3 requirements for mixed topology. Existing tet4 periodic behavior remains covered.
- Runner topology fingerprint begins with the exact domain bytes `fullmag:fem-mesh-topology-fingerprint:v2` and includes cell types/offsets/nodes/markers plus facet types/roles/offsets/nodes/markers. Focused tests mutate every required axis independently.
- Planner packing and mesh-part slicing preserve global ordinals. Multi-mesh merge deliberately creates a new canonical namespace with new unique sequential ordinals; `docs/specs/mesh-roundtrip-semantics-v1.md` now records that merged topology is a new realization and identity.
- Canonical interface ownership no longer retains triangle-only face shadows. `SharedInterfaceFace` carries the canonical facet global ordinal, facet type, and adjacent markers; mesh parts and runner/API payloads reference facets by `facet_global_ordinals`, so magnetic/magnetic and air/magnetic quads remain intact.
- The Python Gmsh ingress derives `exterior`, `material_interface`, and `periodic_seam` from adjacency and periodic metadata. Imported-mesh translation changes coordinates only and preserves types, roles, immutable ordinals, periodic metadata, and quality metadata.

## Changed files

Python canonical topology and direct construction sites:

- `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_remesh.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`
- `packages/fullmag-py/src/fullmag/meshing/surface_assets.py`
- `packages/fullmag-py/tests/test_meshing.py`
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`

Rust canonical IR/planner/CLI/runner files and directly affected construction/test sites:

- `crates/fullmag-ir/src/{mesh_hints.rs,mesh_assets.rs}` and `crates/fullmag-ir/tests/ir_tests.rs`
- `crates/fullmag-plan/src/{fem.rs,mesh.rs,oersted.rs,surface_selectors.rs,tests.rs}`
- `crates/fullmag-cli/src/{diagnostics.rs,formatting.rs,live_workspace.rs,main.rs,orchestrator.rs,python_bridge.rs,step_utils.rs}`
- `crates/fullmag-runner/src/{antenna_fields.rs,artifacts.rs,dispatch.rs,fem_eigen.rs,fem_reference.rs,frequency_response.rs,hysteresis.rs,lib.rs,native_fem.rs,preview.rs,quantities.rs,spin_wave_response.rs,spin_wave_sampling.rs,types.rs}`
- `crates/fullmag-runner/src/eigen/orchestrator.rs`
- `crates/fullmag-runner/src/fem/{eigen_operator.rs,runtime_contract.rs}`
- directly affected runner test modules under `src/fem_reference/`, `src/lib/`, and `src/native_fem/`
- `crates/fullmag-engine/src/{fem.rs,fem_error_estimator.rs,fem_goal_estimator.rs,fem_hcurl_estimator.rs,fem_pbc_benchmark.rs,fem_size_field.rs,studies.rs}`

The additional Python generator and Rust engine/runner call sites contain only the constructor migration or explicit tetra guard needed to keep one canonical topology truth; production Gmsh algorithms and the native ABI were not changed.

Review remediation additionally changes mechanically affected files under
`crates/fullmag-api/src/` (payload construction, typed counts/iteration,
facet-ID resolution, fail-closed FMMT v1/cross-section consumers, schemas, and
tests) plus `docs/specs/mesh-roundtrip-semantics-v1.md`. These changes do not
introduce a new API schema or binary format; they keep the already published
v1 fixed-width lanes honest until their separately scoped v2 redesign.

## TDD evidence

Python RED command:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_mixed_element_meshing.py packages/fullmag-py/tests/test_meshing.py -vv
```

Initial result: exit code `1`; `29 failed, 1 deselected`. Failures were the expected missing canonical constructor, validation, typed-view, v2 persistence, and mixed VTK capabilities.

Rust IR RED command:

```text
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target cargo test -p fullmag-ir --test ir_tests fem_topology_enum_wire_strings_are_canonical --no-run
```

Initial result: exit code `101`; compilation failed with 37 expected missing-type/field errors before the canonical enums and CSR structures existed.

Focused Python GREEN before the combined gate: `29 passed, 1 deselected`.

## Final verification

Python combined gate:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_mixed_element_meshing.py packages/fullmag-py/tests/test_meshing.py -vv
```

Result: exit code `0`; `280 passed, 1 skipped` in 177.58 seconds.

The same command was repeated with `PYTHONFAULTHANDLER=1`: exit code `0`; `280 passed, 1 skipped` in 177.62 seconds.

Rust IR gate:

```text
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target cargo test -p fullmag-ir --lib --tests
```

Result: exit code `0`; 49 unit tests and 146 integration tests passed, 195 total.

Rust planner gate:

```text
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target cargo test -p fullmag-plan --lib
```

Result: exit code `0`; `245 passed, 0 failed`.

Rust runner gate:

```text
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --lib fem_mesh
```

Result: exit code `0`; `10 passed, 0 failed, 597 filtered out`. Cargo emitted one pre-existing dead-code warning for `ArtifactRecorder::update_provenance`.

Exact CLI command from the brief:

```text
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target cargo test -p fullmag-cli --lib python_bridge
```

Result: exit code `101`; Cargo reports `error: no library targets found in package fullmag-cli`. No library target was invented to satisfy a mismatched command.

Equivalent binary-target CLI gate:

```text
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target cargo test -p fullmag-cli --bin fullmag python_bridge
```

Result: exit code `0`; `13 passed, 0 failed, 224 filtered out`.

Auxiliary engine compile gate for directly affected tetra guards:

```text
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo test -p fullmag-engine --lib --no-run
```

Result: exit code `0`.

Whitespace gate:

```text
git diff --check
```

Result: exit code `0`, no output.

## Fixed-arity and writer audit

Canonical access scan:

```text
rg -n '\bmesh\.(elements|boundary_faces)|\.mesh\.(elements|boundary_faces)' crates/fullmag-{ir,plan,runner,cli,engine}/src --glob '*.rs'
```

Result: no matches.

No `pub elements: Vec<[u32; 4]>` or `pub boundary_faces: Vec<[u32; 3]>` remains on `MeshIR` or `FemMeshPayload`. Remaining fixed-array signatures are deliberately confined to:

- private legacy input DTOs in IR, runner, and CLI;
- tetra-specific engine topology and sparse/transfer kernels;
- explicitly guarded native FEM and spin-wave adapters;
- unrelated frequency-response DMI element records.

There is no compiling internal call site that treats a prism, pyramid, or hex as the first four nodes of a tetrahedron. Serialization tests prove all new writers omit `elements` and `boundary_faces`.

## Review remediation verification (2026-07-27)

The following results supersede the lower pre-review counts where the same package is listed.
All Rust commands used `CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target`,
`CARGO_INCREMENTAL=0`, and `CARGO_PROFILE_DEV_DEBUG=0` unless noted.

- Python combined Gmsh/periodic/mixed gate with `python3 -X faulthandler`:
  `43 passed, 0 failed`.
- `cargo test -p fullmag-ir --no-fail-fast`: `52` unit plus `147` integration
  tests passed; doc tests passed.
- `cargo test -p fullmag-plan --no-fail-fast`: `247 passed`; doc tests passed.
- `cargo test -p fullmag-runner --lib fem_mesh --no-fail-fast`: `10 passed`.
- Runner quad-interface artifact regression:
  `artifact_node_selection_resolves_quad_interface_by_global_ordinal` passed.
- `cargo test -p fullmag-cli --bin fullmag python_bridge --no-fail-fast`:
  `13 passed`.
- `cargo test -p fullmag-engine --lib --no-run`: compiled the engine test target.
- `cargo check -p fullmag-api`: passed with zero errors after the mechanical
  canonical-topology cutover (the review baseline had 93 errors).
- `cargo test -p fullmag-api --no-run`: compiled all `687` API tests.
- API topology breadth filter: `15 passed`, including canonical hash headers,
  ETag invalidation, scoped topology, and periodic artifact identity.
- Mixed FMMT v1 route regression:
  `mesh_shared_domain_topology_rejects_mixed_cells_for_fmmt_v1` passed and
  asserts HTTP `409` plus an explicit tet4 requirement for `Prism6` input.
- Shared-node scoped-mesh regression:
  `v2_mesh_histogram_bin_elements_preserves_shared_node_indices` passed.
- `git diff --check`: passed.

The first remediation runner gate exposed one stale assertion that equated
`topology_fingerprint` with `mesh_generation_id`. Production already emitted
the correct separate contracts: the former is the exact-domain canonical
`sha256:` v2 topology identity, while the latter is a raw 64-hex solver-mesh
generation signature including periodic realization. The corrected test now
asserts the canonical fingerprint directly and asserts the identities differ;
the existing non-topological mesh-part mutation regression still proves that
partition metadata does not change topology identity.

The first API topology breadth run exposed two real migration defects: API hash
byte decoding still expected unprefixed hex, and two test fixtures associated
facet index `1` with canonical global ordinal `0`. The decoder now requires and
strips the exact `sha256:` prefix, fixture IDs match canonical topology, and the
final breadth rerun is green. The only earlier zero-test invocation used an
incorrect `--exact` filter; it is not counted as evidence and was replaced by
the one-test focused run above.

Final scans show no canonical `mesh.elements` / `mesh.boundary_faces`, no
persistent `surface_faces: Vec<[u32; 3]>`, and no triangle-connectivity field on
`SharedInterfaceFace`. Remaining fixed arrays are explicitly tetra-only API
sampling and engine/native adapter structures reached only through
`require_tet4_elements` / `require_tri3_boundary_faces` guards. The sole FMMT
v1 serializer runs both guards before allocating or flattening fixed-width
records; no FMMT v2 or OpenAPI redesign was added.

A repository-wide workspace test build was not attempted after package gates:
`/tmp` had only about 1.4 GiB free while the task-specific Cargo target already
used about 1.7 GiB. Expanding the feature matrix risked `ENOSPC`; no other
task's cache was deleted. The package gates above cover every changed Rust
crate and the API compatibility surface.

## Runtime observations and concerns

- Two earlier combined Python runs terminated with signal 139 around native Gmsh lifecycle transitions. Per repository instructions, five remedies were evaluated: explicit `gmsh.clear()`, centralized initialization ownership, model removal, subprocess isolation, and ABI/package rebuild. No speculative lifecycle change was made because the exact suspected periodic test then passed, the full 64-test `FieldStack` passed, and two complete 281-case combined runs passed. This is recorded as environment/native-library instability, not hidden as a green-only history.
- The final runner rerun initially failed while writing Cargo incremental cache because `/tmp` was full. Only the recoverable 1.3 GB task-specific directory `/tmp/fullmag-mixed-topology-target/debug/incremental` was removed; the gate then passed with incremental compilation disabled.
- Rust commands are contract/build evidence only. This slice intentionally does not claim native FEM runtime, device, mixed-element solver, or C ABI qualification.

## Commit

The implementation and this report are committed together. The authoritative hash is the Slice 2 commit reported by the agent after commit creation.
