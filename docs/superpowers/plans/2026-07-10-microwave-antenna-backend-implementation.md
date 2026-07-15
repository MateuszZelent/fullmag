# Microwave Antenna Numerical Backend Implementation Plan

> Supersession note (2026-07-15): regional prescribed-field projection,
> `H_drive`, and its time-domain runtime are governed by ADR 0019, physics note
> 0920, and the 2026-07-15 regional-field implementation plan. This document
> remains canonical for solved antenna field-basis production and consumption.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Tier 1 full-3D quasistatic antenna workflow: mesh a variable-width microstrip/CPW, solve its balanced conduction current, compute and cache a per-ampere magnetic field basis, project it to FDM/FEM targets, apply arbitrary canonical waveforms during LLG, and publish validated field and spectrum artifacts.

**Architecture:** Gmsh creates a versioned conductor-mesh asset with part and terminal markers. Native FEM CPU under `backends/fem` owns the P1/H1 conduction solve, current normalization, adaptive volume-current Biot–Savart integration, and target projection. Rust runner code owns orchestration, ABI transfer, cache identity, artifacts, field-store publication, and provenance only. FDM/FEM CPU/GPU consumers share one resolved field-basis contract but keep separate runtime realizations.

**Tech Stack:** Gmsh Python API, C++17, MFEM/hypre, CUDA, C ABI with Rust FFI, Rust runner and `rustfft`, container-backed `just` recipes, CTest/Cargo/pytest validation.

## Global Constraints

- This is plan 2 of 3. Start only after the contracts/API plan passes and its IR/OpenAPI commits are available.
- The first production field solve is FEM CPU. It may feed an FDM downstream stage only through an explicit artifact transfer with requested/resolved provenance.
- Native FEM builds and runtime proof start with repository `just` recipes. Host CMake, Cargo, direct binaries, and raw Docker are diagnostics only.
- Production numerics live under `backends/fem`; do not add them to `crates/fullmag-runner/src/dispatch.rs`, `mfem_bridge.cpp`, generic `execute.rs`, or `Context`.
- The straight local current axis and piecewise-linear width stations are the schema-v1 geometry. Curved centerlines, harmonic MQS, full-wave Maxwell, impedance, S-parameters, radiation, skin/proximity effects, and dBm are outside scope.
- A microstrip solve requires an explicit return plane. A CPW solve requires balanced signal and return terminal weights.
- Frozen wire names across all three plans are `quasistatic_conduction_biot_savart_3d`, `antenna_field_solution.v1`, `normalization_current_a`, `stage_local`, `H_ant_basis`, `source-spectrum`, `local-k-spectrum`, and `dynamic-structure-factor`; backend artifacts and provenance must use them exactly.
- Store `H_basis` in `(A/m)/A`; runtime `H_ant` is A/m. Preserve vector signs and components. Magnitude is derived for display only.
- No arbitrary near-source distance clipping. Production integration uses the documented volume-current integral and reports quadrature error/refinement.
- GPU field buffers and waveform tables remain resident during accepted stepping. Output readback is cadence-driven.
- Every capability promotion requires both contract tests and managed runtime evidence. Executable is not equivalent to validated.
- Preserve unrelated worktree changes, especially concurrent changes in `backends/fem/CMakeLists.txt`, `justfile`, runner artifacts, and native solver files. Rebase each focused edit onto the live file before applying it.

---

## Task 1: Generate a versioned conductor mesh with terminal markers

**Files:**

- Create: `packages/fullmag-py/src/fullmag/meshing/_gmsh_antenna.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/__init__.py`
- Create: `packages/fullmag-py/tests/test_antenna_meshing.py`

- [ ] **Step 1: Write failing mesh-asset tests**

Create a three-station constricted CPW and assert separate volume markers and six terminal surfaces:

```python
def test_cpw_constriction_mesh_preserves_parts_and_terminals() -> None:
    asset = generate_antenna_conductor_mesh(_cpw_fixture())
    assert asset.schema == "antenna_conductor_mesh.v1"
    assert set(asset.part_markers) == {"signal", "ground_left", "ground_right"}
    assert set(asset.terminal_face_markers) == {
        "signal:inlet", "signal:outlet",
        "ground_left:inlet", "ground_left:outlet",
        "ground_right:inlet", "ground_right:outlet",
    }
    assert asset.terminal_face_areas_m2["signal:inlet"] > 0.0
    assert min(asset.tetra_signed_volumes_m3) > 0.0
```

Add a negative test for self-intersecting loft sections and a mesh refinement test that retains marker identities.

- [ ] **Step 2: Run the focused test and confirm the generator is missing**

Run: `python -m pytest packages/fullmag-py/tests/test_antenna_meshing.py -q`

Expected: import failure for `_gmsh_antenna`.

- [ ] **Step 3: Implement OCC loft construction**

For every conductor part, build planar cross-sections at station positions in the local `(u,v,w)` frame, loft them linearly, apply the rigid transform, synchronize OCC, and fragment touching volumes. Use deterministic physical names for parts and terminal faces.

The generator returns nodes, tetrahedra, element-part markers, boundary triangles, terminal face markers, terminal areas, transform, station signature, mesh policy, and a content hash. It never solves V, J, or H.

- [ ] **Step 4: Validate selector resolution and topology**

Reject zero-area terminals, missing part markers, inverted tetrahedra, disconnected part meshes, and a terminal pair without a topological path. Store the connectivity report in the mesh asset.

- [ ] **Step 5: Run meshing tests**

Run:

```bash
python -m pytest packages/fullmag-py/tests/test_antenna_meshing.py -q
python -m pytest packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_gmsh_generation_smoke.py -q
```

Expected: pass.

- [ ] **Step 6: Commit the mesh producer**

```bash
git add packages/fullmag-py/src/fullmag/meshing packages/fullmag-py/tests/test_antenna_meshing.py
git commit -m "feat(meshing): build antenna conductor assets"
```

---

## Task 2: Define backend-neutral antenna field and ABI contracts

**Files:**

- Create: `backends/fem/core/antenna/antenna_field_contract.hpp`
- Create: `backends/fem/core/antenna/antenna_field_artifact.hpp`
- Create: `backends/fem/core/antenna/antenna_port_mode.hpp`
- Create: `backends/fem/core/antenna/antenna_target_projection.hpp`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Create: `backends/fem/tests/antenna_field_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`

- [ ] **Step 1: Write a failing native descriptor contract test**

The test must construct one conductor mesh, two balanced terminals, and three sample points, then validate ownership and length checks without running MFEM.

```cpp
void antenna_descriptor_rejects_unbalanced_terminal_weights() {
    fullmag_fem_antenna_terminal terminals[2]{};
    terminals[0].current_weight = 1.0;
    terminals[1].current_weight = -0.25;
    fullmag_fem_antenna_port_mode mode{};
    mode.normalization_current_a = 1.0;
    mode.terminals = terminals;
    mode.terminal_count = 2;
    check(
        !fullmag::fem::antenna::validate_port_mode(mode).ok,
        "unbalanced antenna terminal weights must be rejected");
}
```

- [ ] **Step 2: Add versioned C descriptors and result-handle functions**

The C ABI must expose:

- mesh nodes/tetrahedra/part markers/boundary triangles;
- terminal face indices and signed weights;
- per-part conductivity;
- solver and quadrature tolerances;
- field-sampling and target points;
- cancellation callback;
- opaque result handle;
- bounded diagnostics accessors;
- buffer-length queries and copy functions for V, J, H basis, and projections;
- deterministic destroy function.

Every descriptor begins with `struct_size` and `abi_version`. Every copy function validates the requested element count before writing.

- [ ] **Step 3: Mirror the ABI exactly in Rust FFI**

Add `#[repr(C)]` structs and extern declarations. Add size/alignment tests for all public descriptors. Do not wrap raw field arrays in JSON.

- [ ] **Step 4: Run managed native contract build first**

Run:

```bash
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
```

Expected: the new contract test passes inside the managed build.

- [ ] **Step 5: Run Rust FFI tests**

Run: `cargo test -p fullmag-fem-sys --no-fail-fast`

Expected: pass.

- [ ] **Step 6: Commit ABI contracts**

```bash
git add backends/fem/core/antenna native/include/fullmag_fem.h backends/fem/tests/antenna_field_contract.cpp backends/fem/CMakeLists.txt crates/fullmag-fem-sys/src/lib.rs
git commit -m "feat(fem): define antenna field solve ABI"
```

---

## Task 3: Implement terminal constraints and the MFEM conduction solve

**Files:**

- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/conductor_mesh.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/conductor_mesh.cpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/terminal_constraints.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/terminal_constraints.cpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/conduction_solver.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/conduction_solver.cpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/diagnostics.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/diagnostics.cpp`
- Create: `backends/fem/tests/antenna_conduction_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`

- [ ] **Step 1: Write the straight-conductor oracle test**

Use a rectangular conductor with constant conductivity. Apply inlet/outlet constraints and assert linear potential, finite solution, low residual, and conserved cut current.

```cpp
check(relative_l2_error(result.potential_v, analytic_linear_potential) < 1e-8,
      "straight-conductor potential must be linear");
check(result.diagnostics.relative_residual < 1e-10,
      "conduction residual must meet the fixture tolerance");
check(result.diagnostics.relative_current_imbalance < 1e-10,
      "conduction current must be conserved");
```

Add negative tests for zero conductivity, missing terminal faces, a disconnected path, and a singular component after gauge construction.

- [ ] **Step 2: Run the managed native contract and confirm failures**

Run: `just verify-fem-time-domain-native-contract`

Expected: the new conduction test fails because the workflow files are absent.

- [ ] **Step 3: Load and validate the conductor mesh descriptor**

`conductor_mesh.cpp` owns descriptor-to-MFEM mesh construction and marker validation only. It must preserve part and terminal ids and build connected-component metadata. It does not generate the Gmsh geometry.

- [ ] **Step 4: Assemble and solve the P1/H1 conduction problem**

Implement

```text
div(sigma grad(V)) = 0
J = -sigma grad(V)
```

with one gauge condition per disconnected conductor component and terminal constraints consistent with signed port orientation. Publish DOFs, elements, assembly time, solve time, residual, iterations, gauge policy, and finite status.

- [ ] **Step 5: Add cooperative cancellation and partial diagnostics**

Poll only at bounded assembly/solve checkpoints. Cancellation returns a cancelled status and all diagnostics accumulated before the checkpoint; it does not return a ready solution.

- [ ] **Step 6: Run managed native tests**

Run:

```bash
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
```

Expected: pass.

- [ ] **Step 7: Commit the conduction solver**

```bash
git add backends/fem/cpu/mfem/workflows/antenna_field_solve backends/fem/tests/antenna_conduction_contract.cpp backends/fem/CMakeLists.txt
git commit -m "feat(fem): solve antenna conduction current"
```

---

## Task 4: Reconstruct and normalize port currents to one ampere

**Files:**

- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/current_normalization.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/current_normalization.cpp`
- Modify: `backends/fem/cpu/mfem/workflows/antenna_field_solve/conduction_solver.cpp`
- Modify: `backends/fem/tests/antenna_conduction_contract.cpp`

- [ ] **Step 1: Add failing cut-current and constriction tests**

Assert every transverse cut carries its requested signed current after normalization and that a narrower station increases local mean `|J|` while preserving total current.

- [ ] **Step 2: Implement element-current reconstruction**

Compute the P1 element gradient and piecewise-constant vector `J=-sigma grad(V)` in A/m². Integrate normal current over inlet, outlet, and validation cut surfaces with oriented signs.

- [ ] **Step 3: Normalize all terminal groups consistently**

Calculate one scalar normalization factor per port mode so the signal terminal carries exactly `normalization_current_a`. Apply it to V and J. Reject if the realized signal current is zero or if normalized net imbalance exceeds the solver tolerance.

- [ ] **Step 4: Run managed tests**

Run: `just verify-fem-time-domain-native-contract`

Expected: straight and constricted conductor tests pass with imbalance below the fixture tolerance.

- [ ] **Step 5: Commit current normalization**

```bash
git add backends/fem/cpu/mfem/workflows/antenna_field_solve backends/fem/tests/antenna_conduction_contract.cpp
git commit -m "feat(fem): normalize antenna current modes"
```

---

## Task 5: Implement reference and adaptive 3D Biot-Savart evaluators

**Files:**

- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/biot_savart_evaluator.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/biot_savart_evaluator.cpp`
- Create: `backends/fem/tests/antenna_biot_savart_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`

- [ ] **Step 1: Write analytic wire and strip tests**

At far-field points, compare against `H=I/(2*pi*r)`. Add parity tests for a symmetric CPW and convergence points above, beside, and inside a finite-volume conductor.

```cpp
const double expected = 1.0 / (2.0 * std::acos(-1.0) * radius_m);
check(relative_error(norm(result.h_basis_am_per_a[index]), expected) < 2e-3,
      "far-field wire solution must match I/(2*pi*r)");
```

- [ ] **Step 2: Implement the deterministic midpoint oracle**

`reference_midpoint_regularized` uses fixed deterministic element subdivision for small fixtures only. It is labeled reference and cannot be selected as production without an explicit degraded policy.

- [ ] **Step 3: Implement adaptive element-volume quadrature**

Evaluate

```text
H(r) = 1/(4*pi) integral J(r') cross (r-r') / |r-r'|^3 dV'
```

over each tetrahedral volume. Refine using a distance/element-size criterion plus nested quadrature error estimate. Samples inside conductor volume remain legal. Report per-sample refinements, worst error estimate, singularity classification, and finite status.

- [ ] **Step 4: Add deterministic parallel reduction**

Partition targets, keep a stable element order within each target, and use compensated summation for vector components. Results must be stable across thread counts within the declared tolerance.

- [ ] **Step 5: Run managed convergence tests**

Run:

```bash
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
```

Expected: analytic, parity, inside-volume, and quadrature-convergence tests pass.

- [ ] **Step 6: Commit the evaluator**

```bash
git add backends/fem/cpu/mfem/workflows/antenna_field_solve/biot_savart_evaluator.cpp backends/fem/cpu/mfem/workflows/antenna_field_solve/biot_savart_evaluator.hpp backends/fem/tests/antenna_biot_savart_contract.cpp backends/fem/CMakeLists.txt
git commit -m "feat(fem): evaluate 3d antenna field basis"
```

---

## Task 6: Complete the native workflow and target projection

**Files:**

- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/target_projection.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/target_projection.cpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/workflow.hpp`
- Create: `backends/fem/cpu/mfem/workflows/antenna_field_solve/workflow.cpp`
- Modify: `backends/fem/src/api.cpp`
- Create: `backends/fem/tests/antenna_target_projection_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`

- [ ] **Step 1: Write failing target projection tests**

Test direct sampling on FEM nodes, transfer to FDM cell centers, topology-revision mismatch, and an out-of-domain sample policy. Assert a constant/linear manufactured vector field transfers exactly where the interpolation order permits.

- [ ] **Step 2: Implement projection owners**

Support:

- direct evaluation at declared field-sampling points;
- FEM nodal target projection with target topology identity;
- FDM cell-center projection with grid origin/cell size/dimensions;
- optional realization on an analysis box grid.

Every projection records source field signature, target generation, topology hash, indexing, scope, method, and error counters.

- [ ] **Step 3: Implement workflow state transitions**

`workflow.cpp` owns `meshing` verification, `solving_current`, `evaluating_field`, `projecting_targets`, terminal success, cancellation, and failure. It returns the opaque handle only after all requested port modes are finite and accepted.

- [ ] **Step 4: Wire the public C ABI**

`src/api.cpp` validates descriptors and delegates to the workflow. It must contain no conduction or Biot-Savart algorithm.

- [ ] **Step 5: Run managed native tests**

Run:

```bash
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
```

Expected: pass.

- [ ] **Step 6: Commit workflow integration**

```bash
git add backends/fem/cpu/mfem/workflows/antenna_field_solve backends/fem/src/api.cpp backends/fem/tests/antenna_target_projection_contract.cpp backends/fem/CMakeLists.txt
git commit -m "feat(fem): complete antenna field workflow"
```

---

## Task 7: Orchestrate the native solve and write `antenna_field_solution.v1`

**Files:**

- Create: `crates/fullmag-runner/src/antenna/mod.rs`
- Create: `crates/fullmag-runner/src/antenna/native.rs`
- Create: `crates/fullmag-runner/src/antenna/artifact.rs`
- Create: `crates/fullmag-runner/src/antenna/cache.rs`
- Create: `crates/fullmag-runner/src/antenna/stage.rs`
- Modify: `crates/fullmag-runner/src/lib.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Create: `crates/fullmag-runner/tests/antenna_field_stage.rs`

- [ ] **Step 1: Write failing stage and cache tests**

Cover state transitions, cancellation, partial diagnostics, reload equivalence, signature invalidation, and waveform invariance.

```rust
#[test]
fn waveform_change_does_not_invalidate_field_solution() {
    let first = fixture_request_with_waveform(TimeDependenceIR::Constant);
    let second = fixture_request_with_waveform(sinc_fixture());
    assert_eq!(field_solution_signature(&first), field_solution_signature(&second));
}
```

- [ ] **Step 2: Build safe FFI ownership wrappers**

`native.rs` creates descriptors, holds all backing vectors for the call duration, checks status codes, copies buffers after length queries, and destroys the result handle through RAII. No native pointer survives the wrapper.

- [ ] **Step 3: Implement signatures and cache state**

Use canonical normalized JSON plus binary topology/point hashes. Implement `missing`, `queued`, `meshing`, `solving_current`, `evaluating_field`, `projecting_targets`, `ready`, `cancelled`, `failed`, `stale`, and explicitly accepted `degraded`.

- [ ] **Step 4: Write the versioned artifact atomically**

Use a temporary directory and rename only after manifest and all buffers are complete. Publish:

- manifest JSON;
- conductor mesh/topology reference;
- `V_electric` scalar field;
- `J_charge` vector field;
- `H_ant_basis` vector field per port mode;
- target projections;
- diagnostics and provenance;
- requested/resolved execution and signatures.

Failure preserves bounded diagnostics separately and never creates a ready manifest.

- [ ] **Step 5: Connect `solve` stage command orchestration**

The CLI/runtime locates the planned stage, resolves or builds its conductor mesh asset, calls the runner antenna stage owner, publishes progress resources, and updates stage execution. It must not place numerical code in `orchestrator.rs`.

- [ ] **Step 6: Run runner tests**

Run:

```bash
cargo test -p fullmag-runner antenna --no-fail-fast
cargo test -p fullmag-cli antenna --no-fail-fast
```

Expected: pass with a fake native adapter; managed native proof follows in Task 14.

- [ ] **Step 7: Commit orchestration and artifacts**

```bash
git add crates/fullmag-runner/src/antenna crates/fullmag-runner/src/lib.rs crates/fullmag-runner/src/artifacts.rs crates/fullmag-runner/src/types.rs crates/fullmag-runner/tests/antenna_field_stage.rs crates/fullmag-cli/src/orchestrator.rs
git commit -m "feat(runtime): execute antenna field stages"
```

---

## Task 8: Consume solved and regional drives in the FDM CPU reference

**Files:**

- Create: `crates/fullmag-runner/src/antenna/waveform.rs`
- Create: `crates/fullmag-runner/src/antenna/field_basis.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference/tests.rs`
- Modify: `crates/fullmag-engine/src/lib.rs`

- [ ] **Step 1: Write failing linearity and time-origin tests**

Test 0.5 A, 1 A, and 2 A from one stored basis, sinusoid and sinc values at exact times, stage-local reset, absolute time continuity, and artifact reload equivalence.

- [ ] **Step 2: Centralize waveform evaluation**

Move the canonical evaluator out of legacy `antenna_fields.rs` into `antenna/waveform.rs`. It must implement `Constant`, `Sinusoidal`, `Pulse`, `PiecewiseLinear`, and `SincPulse` once for all CPU paths with explicit stage-local or absolute time.

- [ ] **Step 3: Load immutable basis projections**

Validate schema, content hash, port id, target grid identity, component count, unit `(A/m)/A`, and sample count before constructing the FDM plan. Do not recalculate antenna geometry in the FDM solver.

- [ ] **Step 4: Add `H_ant` to every RHS and observable path**

At each RHS evaluation compute each scalar amplitude once, accumulate the active bases into a reusable buffer, and add it to `H_eff`. Apply regional drives through the same `H_ant` buffer after converting B amplitude to H. Update `H_ant`, `H_eff`, torque, and Zeeman-energy observables consistently.

- [ ] **Step 5: Run FDM CPU tests**

Run:

```bash
cargo test -p fullmag-runner fdm::cpu::reference --no-fail-fast
cargo test -p fullmag-engine --no-fail-fast
```

Expected: pass.

- [ ] **Step 6: Commit the CPU reference consumer**

```bash
git add crates/fullmag-runner/src/antenna/waveform.rs crates/fullmag-runner/src/antenna/field_basis.rs crates/fullmag-runner/src/fdm/cpu/reference.rs crates/fullmag-runner/src/fdm/cpu/reference/tests.rs crates/fullmag-engine/src/lib.rs
git commit -m "feat(fdm): apply antenna field basis on cpu"
```

---

## Task 9: Consume solved and regional drives in native FEM CPU

**Files:**

- Create: `backends/fem/cpu/mfem/interactions/antenna_drive/antenna_drive.hpp`
- Create: `backends/fem/cpu/mfem/interactions/antenna_drive/antenna_drive.cpp`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `backends/fem/cpu/mfem/interactions/effective_field.cpp`
- Modify: `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp`
- Modify: `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`
- Create: `backends/fem/tests/antenna_drive_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`

- [ ] **Step 1: Write failing interaction tests**

Assert per-stage amplitude, no allocation during repeated RHS calls, `H_ant` addition to `H_eff`, energy sign, inactive-stage zero field, and a regional uniform-mode FMR fixture.

- [ ] **Step 2: Add a dedicated runtime owner**

`antenna_drive` owns immutable AoS-3 basis vectors, waveform descriptors, stage activation, a reusable instantaneous `H_ant` buffer, and diagnostics. Add it through the explicit interaction subsystem boundary; do not add loose vectors directly to `Context`.

- [ ] **Step 3: Integrate every explicit RK evaluation**

Call antenna accumulation from the shared effective-field path used by Heun, RK4, RK23, and RK45. Evaluate stage-local time consistently at every substage.

- [ ] **Step 4: Add ABI upload/readback functions**

Upload basis descriptors and piecewise-linear samples once before stepping. Expose cadence-driven `H_ant` copy without disturbing the hot loop.

- [ ] **Step 5: Run managed native tests**

Run:

```bash
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
```

Expected: pass for every explicit RK integrator.

- [ ] **Step 6: Commit the FEM CPU consumer**

```bash
git add backends/fem/cpu/mfem/interactions/antenna_drive native/include/fullmag_fem.h crates/fullmag-fem-sys/src/lib.rs backends/fem/cpu/mfem/interactions/effective_field.cpp backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp backends/fem/tests/antenna_drive_contract.cpp backends/fem/CMakeLists.txt
git commit -m "feat(fem): apply antenna field basis on cpu"
```

---

## Task 10: Add the FDM CUDA antenna-drive realization

**Files:**

- Create: `backends/fdm/gpu/cuda/interactions/antenna_drive/antenna_drive.hpp`
- Create: `backends/fdm/gpu/cuda/interactions/antenna_drive/antenna_drive.cu`
- Modify: `native/include/fullmag_fdm.h`
- Modify: `backends/fdm/gpu/cuda/runtime/context.cu`
- Modify: `backends/fdm/CMakeLists.txt`
- Modify: `crates/fullmag-fdm-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Create: `backends/fdm/tests/antenna_drive_contract.cpp`
- Create: `examples/fdm_antenna_drive_runtime.py`
- Create: `scripts/verify_fdm_antenna_drive_runtime.py`
- Modify: `justfile`

- [ ] **Step 1: Write CPU/GPU parity tests**

Use double precision and compare instantaneous `H_ant`, one-step RHS, and short time evolution for constant, sinusoidal, sinc, and piecewise-linear waveforms. Include inactive cells and multiple port modes.

- [ ] **Step 2: Add device-resident ownership**

Allocate basis SoA buffers and waveform tables during plan upload. Reuse one instantaneous field buffer. Reject schema, count, unit, or target-grid mismatch before device allocation.

- [ ] **Step 3: Implement amplitude and accumulation kernels**

Evaluate scalar amplitudes once per mode per RHS substage and accumulate bases into `H_ant`/`H_eff`. Do not copy waveform tables or bases per step.

- [ ] **Step 4: Expose `H_ant` through native observables**

Add a dedicated observable enum and copy path. Do not alias `H_ant` to `H_ext`.

- [ ] **Step 5: Run managed GPU runtime proof**

Add `verify-fdm-antenna-drive-runtime` to `justfile`. It must use the same managed native library packaging and headless path as public FDM GPU execution, run `examples/fdm_antenna_drive_runtime.py`, and validate its artifacts with `scripts/verify_fdm_antenna_drive_runtime.py`.

Run: `just verify-fdm-antenna-drive-runtime`

Expected: native FDM GPU execution with passing double-precision field/RHS parity and no hidden CPU consumer.

- [ ] **Step 6: Commit the FDM GPU consumer**

```bash
git add backends/fdm native/include/fullmag_fdm.h crates/fullmag-fdm-sys/src/lib.rs crates/fullmag-runner/src/fdm/gpu/cuda/native.rs examples/fdm_antenna_drive_runtime.py scripts/verify_fdm_antenna_drive_runtime.py justfile
git commit -m "feat(fdm-gpu): apply resident antenna field basis"
```

---

## Task 11: Add the native FEM CUDA antenna-drive realization

**Files:**

- Create: `backends/fem/gpu/cuda/interactions/antenna_drive/antenna_drive.hpp`
- Create: `backends/fem/gpu/cuda/interactions/antenna_drive/antenna_drive.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.cpp`
- Modify: `backends/fem/gpu/cuda/state/device_memory.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/tests/antenna_drive_contract.cpp`
- Create: `examples/fem_antenna_drive_gpu_runtime.py`
- Create: `scripts/verify_fem_antenna_drive_gpu_runtime.py`
- Modify: `justfile`

- [ ] **Step 1: Extend the native parity fixture to FEM GPU**

Compare FEM CPU/GPU double-precision `H_ant`, RHS, and a short run for every supported explicit RK integrator. Forced GPU must fail clearly if device-resident prerequisites are absent.

- [ ] **Step 2: Add dedicated GPU subsystem memory**

Own basis, waveform, instantaneous field, and activation data below `gpu/cuda/interactions/antenna_drive`; the generic GPU state only references the subsystem owner.

- [ ] **Step 3: Accumulate within the existing dirty-free RK path**

Integrate the kernel into `rk_effective_field` without host readback, per-step allocation, or mandatory stream synchronization.

- [ ] **Step 4: Run managed FEM GPU proof**

Add `verify-fem-antenna-drive-gpu-runtime` to `justfile`. The recipe must call the managed FEM GPU headless path, write `.fullmag/reports/fem-antenna-drive-gpu-runtime/artifacts`, and run the validator below.

Run:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just verify-fem-antenna-drive-gpu-runtime
```

Expected: the managed runtime reports native FEM GPU execution, no hidden CPU field consumer, and passing parity tolerances.

- [ ] **Step 5: Commit the FEM GPU consumer**

```bash
git add backends/fem/gpu/cuda/interactions/antenna_drive backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu backends/fem/gpu/cuda/state backends/fem/CMakeLists.txt backends/fem/tests/antenna_drive_contract.cpp examples/fem_antenna_drive_gpu_runtime.py scripts/verify_fem_antenna_drive_gpu_runtime.py justfile
git commit -m "feat(fem-gpu): apply resident antenna field basis"
```

---

## Task 12: Publish canonical fields through the quantity and field-store pipeline

**Files:**

- Modify: `crates/fullmag-quantities/src/id.rs`
- Modify: `crates/fullmag-quantities/src/catalog.rs`
- Modify: `crates/fullmag-quantities/src/registry.rs`
- Modify: `crates/fullmag-plan/src/quantities.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Test: nearest quantity catalog and field materialization tests

- [ ] **Step 1: Add failing quantity and materialization tests**

Assert global availability and exact units/locations for:

- `H_ant` in A/m on the active magnetic target;
- `V_electric` in V on conductor nodes;
- `J_charge` in A/m² on conductor elements or projected nodes with declared location;
- `H_ant_basis` in `(A/m)/A` on field sampling/target domains;
- `h_perp` in A/m as a derived equilibrium-dependent field.

- [ ] **Step 2: Extend the canonical quantity catalog**

Add stable ids and aliases. Preserve `H_ant`; do not add `B_ext` as an antenna alias. Add display metadata for optional `mu0 H` conversion without changing stored units.

- [ ] **Step 3: Materialize artifact fields globally**

Register artifact-backed fields in the field catalog and make `compute_fields` or equivalent materialization resolve them by field id/domain reference. Do not special-case one UI route.

- [ ] **Step 4: Add on-demand instantaneous `H_ant`**

At an available stage time, derive the field from active basis buffers and waveform amplitudes. Return a structured unavailable state if the drive is not active or the solution is stale.

- [ ] **Step 5: Run quantity tests**

Run:

```bash
cargo test -p fullmag-quantities --no-fail-fast
cargo test -p fullmag-plan quantities --no-fail-fast
cargo test -p fullmag-runner quantity --no-fail-fast
```

Expected: pass.

- [ ] **Step 6: Commit quantity publication**

```bash
git add crates/fullmag-quantities crates/fullmag-plan/src/quantities.rs crates/fullmag-runner/src/artifacts.rs crates/fullmag-runner/src/interactive_runtime.rs crates/fullmag-runner/src/quantities.rs
git commit -m "feat(fields): publish antenna solution quantities"
```

---

## Task 13: Compute source spectra, transverse field, line cuts, and dynamic response

**Files:**

- Create: `crates/fullmag-runner/src/antenna/analysis.rs`
- Create: `crates/fullmag-runner/src/antenna/raster.rs`
- Modify: `crates/fullmag-runner/src/antenna/artifact.rs`
- Modify: `crates/fullmag-runner/Cargo.toml`
- Create: `crates/fullmag-runner/tests/antenna_analysis.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis/antenna.rs`

- [ ] **Step 1: Write manufactured FFT tests**

Use a spatial sinusoid with known wave vector and a spatiotemporal sinusoid with known `(k, omega)`. Assert peak positions, axis units, normalization, window metadata, and sign conventions.

- [ ] **Step 2: Implement source `W_H(k)`**

Project the selected field component or magnitude along an explicit analysis axis/frame, apply the declared window, subtract the declared mean policy, and compute a normalized spatial FFT. Publish component policy, coordinate frame, k axis in rad/m, normalization, source field revision, and port mode.

- [ ] **Step 3: Implement local `W_H(u,k)`**

Use a bounded sliding spatial window along the antenna axis. Store large matrices with a versioned tiled raster descriptor and binary tiles; do not place the matrix in JSON.

- [ ] **Step 4: Implement equilibrium-dependent `h_perp`**

Given an equilibrium magnetization artifact `m0`, derive the vector component perpendicular to `m0`. Its signature includes the field solution and equilibrium identity. Changing equilibrium invalidates `h_perp`, not the base field solution.

- [ ] **Step 5: Implement arbitrary field line cuts**

Sample a requested polyline with explicit interpolation and out-of-domain policies. Publish distance, world coordinates, values, units, field revision, and source domain.

- [ ] **Step 6: Implement `S_m(k,omega)` from time-series artifacts**

Select a magnetization component or transverse projection, apply declared space/time windows, compute the 2D transform, and publish exact k/omega axes, normalization, run/stage/time-window identity, and tiled raster data. Keep this resource distinct from the source spectrum.

- [ ] **Step 7: Run analysis tests**

Run:

```bash
cargo test -p fullmag-runner antenna_analysis --no-fail-fast
cargo test -p fullmag-api antenna --no-fail-fast
```

Expected: pass.

- [ ] **Step 8: Commit analysis producers**

```bash
git add crates/fullmag-runner/src/antenna crates/fullmag-runner/tests/antenna_analysis.rs crates/fullmag-runner/Cargo.toml crates/fullmag-api/src/router_v2/handlers/analysis/antenna.rs
git commit -m "feat(analysis): compute antenna and spin-wave spectra"
```

---

## Task 14: Add managed runtime recipes and validation fixtures

**Files:**

- Create: `examples/fem_antenna_field_runtime.py`
- Create: `examples/fem_antenna_drive_runtime.py`
- Modify: `examples/fdm_antenna_drive_runtime.py`
- Create: `scripts/verify_fem_antenna_field_runtime.py`
- Create: `scripts/verify_fem_antenna_drive_runtime.py`
- Create: `scripts/verify_antenna_constriction_spectrum.py`
- Modify: `justfile`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `docs/specs/capability-matrix-v0.md`

- [ ] **Step 1: Add focused container-backed recipes**

Add:

```just
verify-fem-antenna-field-runtime:
    just ensure-managed-fem-runtime
    python3 examples/fem_antenna_field_runtime.py
    python3 scripts/verify_fem_antenna_field_runtime.py .fullmag/reports/fem-antenna-field-runtime/artifacts

verify-fem-antenna-drive-runtime:
    just ensure-managed-fem-runtime
    python3 examples/fem_antenna_drive_runtime.py
    python3 scripts/verify_fem_antenna_drive_runtime.py .fullmag/reports/fem-antenna-drive-runtime/artifacts
```

Adapt the body to the existing container wrapper style in the live `justfile`; the public recipe names and artifact paths remain as shown.

- [ ] **Step 2: Validate straight conductor and symmetric CPW**

Require residual/current-balance thresholds, expected potential/current parity, far-field behavior, finite values, and convergence across at least three conductor mesh levels and three quadrature tolerances.

- [ ] **Step 3: Validate the constriction trend**

Require increased local `|J|`, localized `H` intensity, and a reproducible shift/broadening of the local source-spectrum peak relative to a constant-width control. Do not compare absolute transduction efficiency to a full-wave paper.

- [ ] **Step 4: Validate runtime consumers**

Require 0.5/1/2 A linearity, artifact reload equality, waveform reuse without a field re-solve, all explicit RK integrators on FEM CPU, and double-precision CPU/GPU parity for implemented lanes.

- [ ] **Step 5: Run authoritative managed proof**

Run:

```bash
just rebuild-fem-runtime
just verify-fem-antenna-field-runtime
just verify-fem-antenna-drive-runtime
```

Also run `just verify-fdm-antenna-drive-runtime` and, after Task 11, `just verify-fem-antenna-drive-gpu-runtime`.

Expected: all runtime reports pass and identify requested/resolved execution without hidden fallback.

- [ ] **Step 6: Promote only proven capabilities**

Update each matrix lane independently:

- FEM CPU field solve only after field runtime proof;
- FDM CPU basis consumer after reference tests;
- FEM CPU consumer after all-integrator proof;
- FDM GPU and FEM GPU only after their managed runtime parity gates;
- source/local spectra and dynamic structure factor only after manufactured and integrated fixtures.

- [ ] **Step 7: Commit validation and promotion**

```bash
git add examples/fem_antenna_field_runtime.py examples/fem_antenna_drive_runtime.py examples/fdm_antenna_drive_runtime.py scripts/verify_fem_antenna_field_runtime.py scripts/verify_fem_antenna_drive_runtime.py scripts/verify_antenna_constriction_spectrum.py justfile docs/specs/capability-matrix-v0.json docs/specs/capability-matrix-v0.md
git commit -m "test(antenna): validate staged field workflow"
```

---

## Task 15: Retire the old production claim without deleting compatibility

**Files:**

- Modify: `crates/fullmag-runner/src/antenna_fields.rs`
- Modify: `crates/fullmag-plan/src/current_transport.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/antenna.py`
- Modify: relevant compatibility tests

- [ ] **Step 1: Route new plans away from the infinite-strip evaluator**

No new `AntennaFieldSolveIR` may call `compute_per_unit_antenna_fields` or `add_rectangular_conductor`. New solutions must come from `antenna_field_solution.v1`.

- [ ] **Step 2: Preserve explicit compatibility behavior**

Keep legacy deserialization and evaluation for old scripts during the compatibility window. Rename internal provenance to `legacy_infinite_strip_biot_savart`, publish its infinite-axis/approximation metadata, and prevent capability promotion.

- [ ] **Step 3: Add a regression search test**

The test fails if a new field-solve plan resolves to `mqs_2p5d_az` or if the UI/API advertises it as a selectable production model.

- [ ] **Step 4: Run compatibility tests**

Run:

```bash
cargo test -p fullmag-runner antenna --no-fail-fast
cargo test -p fullmag-plan antenna --no-fail-fast
python -m pytest packages/fullmag-py/tests/test_current_transport.py -q
```

Expected: new path and compatibility path both pass with distinct provenance.

- [ ] **Step 5: Commit legacy containment**

```bash
git add crates/fullmag-runner/src/antenna_fields.rs crates/fullmag-plan/src/current_transport.rs packages/fullmag-py/src/fullmag/model/antenna.py packages/fullmag-py/tests/test_current_transport.py
git commit -m "refactor(antenna): contain infinite-strip compatibility"
```

---

## Task 16: Backend-plan final verification

- [ ] **Step 1: Run semantic, FFI, and unit suites**

```bash
python -m pytest packages/fullmag-py/tests/test_antenna_meshing.py packages/fullmag-py/tests/test_current_transport.py -q
cargo test -p fullmag-fem-sys --no-fail-fast
cargo test -p fullmag-fdm-sys --no-fail-fast
cargo test -p fullmag-quantities --no-fail-fast
cargo test -p fullmag-plan antenna --no-fail-fast
cargo test -p fullmag-runner antenna --no-fail-fast
cargo test -p fullmag-api antenna --no-fail-fast
```

- [ ] **Step 2: Run authoritative native/runtime suites**

```bash
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
just verify-fem-antenna-field-runtime
just verify-fem-antenna-drive-runtime
```

Run `just verify-fdm-antenna-drive-runtime` and `just verify-fem-antenna-drive-gpu-runtime` when those lanes are implemented.

- [ ] **Step 3: Run numerical acceptance checks**

Verify:

- straight conductor potential and current conservation;
- symmetric CPW current balance and field parity;
- constriction current crowding and source-spectrum trend;
- mesh and quadrature convergence;
- 0.5/1/2 A linearity;
- artifact reload equivalence;
- waveform edit without field-solution signature change;
- `H_ant` inclusion in torque and every supported explicit RK substage;
- requested/resolved provenance for FDM/FEM and CPU/GPU.

- [ ] **Step 4: Check hot-path and ownership invariants**

```bash
rg 'antenna' crates/fullmag-runner/src/dispatch.rs backends/fem/src/mfem_bridge.cpp
rg 'cudaMemcpy|new |malloc|std::vector' backends/fem/gpu/cuda/interactions/antenna_drive backends/fdm/gpu/cuda/interactions/antenna_drive
rg 'mqs_2p5d_az' crates/fullmag-plan crates/fullmag-runner packages/fullmag-py
```

Expected: no numerical antenna algorithm in dispatch/bridge; GPU allocation/copies occur only in setup/readback owners; legacy model appears only in compatibility code.

- [ ] **Step 5: Hand off to the UI plan**

Record exact field ids, domain refs, resource revisions, solution fixture ids, capability statuses, and managed runtime report paths needed by plan 3. Do not begin UI implementation in the backend commit.
