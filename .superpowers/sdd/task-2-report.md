# Task 2 report: canonical typed topology v2

## Status

DONE_WITH_CONCERNS. Canonical variable-arity FEM topology is implemented through Python meshing data, Rust IR, planner transformations, CLI ingestion, runner payloads and artifact writers. All applicable focused gates pass. The exact CLI command in the brief cannot run because `fullmag-cli` is a binary-only package; the equivalent binary-target filter passes 13 tests.

The controller-owned `.superpowers/sdd/progress.md` and `.superpowers/sdd/task-1-report.md` remain unstaged and unchanged by this slice. No SP4 scenario, C ABI, native FEM implementation, FMMT/API codec, or Control Room file was changed.

## Contract implemented

- Added the exact canonical wire vocabularies:
  - cells: `tet4`, `prism6`, `pyramid5`, `hex8`;
  - facets: `tri3`, `quad4`;
  - roles: `exterior`, `material_interface`, `periodic_seam`.
- Python `MeshData` now owns only typed flat connectivity and CSR offsets. Rust `MeshIR` and `FemMeshPayload` own only `FemConnectivityIR` / `FemFacetConnectivityIR` plus marker arrays.
- Added typed cell/facet iterators and views carrying canonical type, connectivity, marker/role association, and stable global ordinal within the canonical sequence.
- Added strict validation for unknown family strings, CSR start/monotonicity/end/length, family arity, node indices, duplicate local nodes, cell/facet marker drift, role drift, and family-aware positive orientation/Jacobian.
- Preserved tetra SICN/gamma behavior only for tet4. Other supported families expose family-aware scaled-Jacobian validation and are not mislabeled as tetra quality.
- Added explicit legacy tet4/tri3 normalization boundaries for JSON, NPZ, and Rust serde. Legacy inputs are accepted only as a complete `elements` + `boundary_faces` pair when v2 topology is absent; dual truth and partial legacy payloads reject.
- All new writers emit v2 only. Python IR emits nested `cells` / `facets`; saved NPZ uses typed flat arrays; Rust serialization emits canonical fields. Tests assert legacy keys are absent after both v2 construction and legacy normalization.
- Mixed VTK/VTU output uses native VTK codes 10/12/13/14 for tet/hex/wedge/pyramid and does not triangulate scientific cells.
- Planner analysis, grouping, packing, merge, mesh-part slicing, summaries, and artifact payloads carry variable-arity type/connectivity/markers/roles together. Cell face tables dispatch by family instead of taking the first four nodes.
- PBC and tetra-only engine/native consumers fail closed with actionable tet4/tri3 requirements for mixed topology. Existing tet4 periodic behavior remains covered.
- Runner topology fingerprint begins with the exact domain bytes `fullmag:fem-mesh-topology-fingerprint:v2` and includes cell types/offsets/nodes/markers plus facet types/roles/offsets/nodes/markers. Focused tests mutate every required axis independently.

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

## Runtime observations and concerns

- Two earlier combined Python runs terminated with signal 139 around native Gmsh lifecycle transitions. Per repository instructions, five remedies were evaluated: explicit `gmsh.clear()`, centralized initialization ownership, model removal, subprocess isolation, and ABI/package rebuild. No speculative lifecycle change was made because the exact suspected periodic test then passed, the full 64-test `FieldStack` passed, and two complete 281-case combined runs passed. This is recorded as environment/native-library instability, not hidden as a green-only history.
- The final runner rerun initially failed while writing Cargo incremental cache because `/tmp` was full. Only the recoverable 1.3 GB task-specific directory `/tmp/fullmag-mixed-topology-target/debug/incremental` was removed; the gate then passed with incremental compilation disabled.
- Rust commands are contract/build evidence only. This slice intentionally does not claim native FEM runtime, device, mixed-element solver, or C ABI qualification.

## Commit

The implementation and this report are committed together. The authoritative hash is the Slice 2 commit reported by the agent after commit creation.
