# 01 - Backend Native FEM Frequency-Domain Solver

## Current State

Fullmag has a working semantic and transitional execution path for FEM eigenmodes. That path is not the professional production frequency-domain solver. The production frequency-domain solver is the driven harmonic response solve for `StudyIR::FrequencyResponse`; eigenmodes are the modal companion product used for normal modes, dispersion, mode profiles, linewidths, modal absorption, and validation.

Current implemented pieces:

- `docs/physics/0700-frequency-domain-linearized-llg.md` defines the canonical magnetic linearized-LLG frequency-domain physics note.
- `docs/physics/frequency_domain_solver_physics.md` defines the broader magnetic and magnetoelastic frequency-domain concept surface.
- `docs/physics/0600-fem-eigenmodes-linearized-llg.md` states that the current modal executable path is CPU reference quality and that native MFEM/SLEPc integration is future work.
- `crates/fullmag-ir/src/study.rs` has `StudyIR::Eigenmodes` and `StudyIR::FrequencyResponse`.
- `crates/fullmag-plan/src/fem.rs` can plan `BackendTarget::Fem + StudyIR::Eigenmodes`.
- `crates/fullmag-plan/src/lib.rs` rejects `StudyIR::FrequencyResponse` on FDM and routes supported FEM cases into `FemFrequencyResponsePlanIR`. Active rollout work routes the gamma-point/free-boundary magnetic slice through native MFEM production CPU when available, with dense validation retained only as a validation/reference lane.
- `crates/fullmag-runner/src/fem_eigen.rs` assembles and solves a transitional modal eigen problem.
- `crates/fullmag-runner/src/native_fem/eigen.rs` exposes a small dense GPU cuSolver helper when `fem-gpu` is enabled.
- `crates/fullmag-runner/tests/physics_validation.rs` validates the current FEM eigen reference path against smoke, order-of-magnitude, resolution stability, periodic/Floquet, damping, surface anisotropy, demag, boundary conditions, and v2 dispersion artifacts.
- `external_solvers/tetrax/tetrax/experiments/eigen/solve.py` implements the TetraX eigenmode experiment with a finite-element dynamic-matrix method, k/m sampling, saved mode profiles, linewidths, and absorption postprocessing on `EigenResult`.
- `external_solvers/tetrax/tetrax/experiments/eigen/dynamic_matrix.py` is the local reference for the dynamic-matrix modal formulation.
- `external_solvers/tetrax/tetrax/experiments/eigen/postprocessing/absorption.py` is the local reference for absorption calculated from an eigensystem.
- `external_solvers/tetmag/specs/ProgramSpecs.h` and `external_solvers/tetmag/main/TheLLG.cpp` show RF, pulse, and sweep drives inside time-domain LLG dynamics. This is a useful reference for excitation semantics and validation, but it is not a direct harmonic frequency-domain solve.

Current limitations:

- The production native FEM source tree does not own a dedicated frequency-domain module.
- The current modal runner path is orchestration/reference quality, not the final MFEM/hypre/libCEED/SLEPc production modal backend.
- The dense GPU path is useful for small modal matrices but is not a scalable production modal eigensolver.
- Driven frequency response is executable as dense FEM validation and as a limited native MFEM production CPU slice for gamma-point/free-boundary and k=0 static-periodic magnetic response with exchange, Zeeman, uniaxial anisotropy, interfacial/bulk DMI on supported P1 tetrahedral meshes, and Gilbert damping. Static-periodic response requires validated `mesh.periodic_node_pairs` and is enforced by tangent-space periodic projection. Demag, nonzero-k Floquet/Bloch response, Floquet phase enforcement, magnetoelastic response, and production GPU response remain explicitly unsupported.
- Equilibrium preparation, tangent-space projection, operator assembly, driven solve, modal solve, diagnostics, and artifact writing are not separated into backend-owned contracts.
- `just verify-fem-frequency-domain-runtime` exists as the managed production-CPU runtime smoke and must prove native MFEM production CPU provenance in the managed FEM container before the slice is considered runtime-verified.
- There is no single backend module that can answer: "given this equilibrium and this FEM mesh, assemble the exact linearized operator used for both free modes and driven response."

## Target State

Fullmag must have a native FEM frequency-domain subsystem with these properties:

- It lives under `backends/fem`, which is the canonical native FEM implementation spine.
- It is organized by explicit subsystem contracts, not by adding more cross-cutting state to `Context` or `mfem_bridge.cpp`.
- It exposes one backend-neutral physics contract for magnetic linearized LLG and then separate CPU/GPU realizations.
- It treats direct driven response as the frequency-domain solver.
- It treats eigenmodes and dispersion as a separate modal solver that may share operator assembly but has different outputs, validation, and UI semantics.
- It has CPU production realization based on MFEM/hypre/libCEED and scalable complex linear-solve integration for driven response.
- It has a modal dynamic-matrix/eigensystem path for eigenmodes, dispersion, linewidths, and modal absorption.
- It has GPU production realization only when containerized dependencies prove the full lane. Until then, the GPU dense path remains a reference/qualification tool.
- It writes v2 artifacts directly or through one typed artifact writer shared with the Rust runner.
- It reports solver provenance, residuals, orthogonality, tangent leakage, equilibrium residuals, demag realization, damping policy, phase convention, k sampling, and device/precision reality.
- It has managed container-backed build and verification commands in the repo `justfile`.

## Target Native Source Layout

The implementation should create dedicated frequency-domain subdirectories inside the existing native FEM backend layout. The current `backends/fem` tree uses shared `include/`, `src/`, `core/`, `cpu/`, `gpu/`, and `tests/` directories; do not create a parallel nested `frequency_domain/include` tree with a second header-path convention.

```text
backends/fem/
  include/
    frequency_domain/
      frequency_domain_contract.hpp
      equilibrium_state.hpp
      tangent_frame.hpp
      operator_terms.hpp
      modal_solver.hpp
      driven_response_solver.hpp
      diagnostics.hpp
      artifact_writer.hpp
  src/
    frequency_domain/
      equilibrium_state.cpp
      tangent_frame.cpp
      tangent_projection.cpp
      operator_contract.cpp
      operator_diagnostics.cpp
      response_observables.cpp
      artifact_writer.cpp
  core/
    frequency_domain/
      tangent_projection.cpp
      operator_diagnostics.cpp
      response_observables.cpp
  cpu/
    frequency_domain/
      mfem_operator_context.cpp
      mfem_tangent_space.cpp
      mfem_exchange_operator.cpp
      mfem_demag_operator.cpp
      mfem_zeeman_operator.cpp
      mfem_dmi_operator.cpp
      mfem_surface_anisotropy_operator.cpp
      mfem_driven_response_solver.cpp
      mfem_frequency_sweep.cpp
      mfem_modal_solver.cpp
  gpu/
    frequency_domain/
      cuda_operator_context.cpp
      libceed_exchange_operator.cpp
      libceed_local_terms.cpp
      cuda_driven_response_probe.cpp
      cuda_modal_dense_reference_solver.cpp
  tests/
    frequency_domain/
      frequency_domain_contract_test.cpp
      tangent_frame_test.cpp
      equilibrium_projection_test.cpp
      driven_response_smoke_test.cpp
      modal_operator_smoke_test.cpp
      demag_realization_test.cpp
```

Rules for this tree:

- `core/` owns physics-invariant transformations: tangent basis, projection, residual definitions, observable reduction, schema-compatible metadata, and artifact naming.
- `cpu/` owns MFEM/hypre/libCEED CPU realizations.
- `gpu/` owns CUDA/libCEED GPU realizations and must not mutate CPU-owned state.
- `include/` owns C++ contracts that can be called through a thin FFI boundary.
- `tests/` owns native unit/smoke tests that run inside the managed FEM container.
- `backends/fem/src/mfem_bridge.cpp` is currently a minimal stub of roughly 354 bytes. It may call into the frequency-domain subsystem for FFI routing, but new frequency-domain logic must live in the dedicated `frequency_domain/` subdirectories, not in the bridge file.

## Backend Contract Types

Create a shared linearized operator request plus separate solve requests:

- `FrequencyDomainOperatorRequest`: equilibrium, mesh, material, interactions, demag, boundary, damping, precision, and device intent.
- `DrivenFrequencyResponseRequest`: drive frequencies, excitation field, response observables, output policy, and linear-solve settings.
- `ModalDynamicMatrixRequest`: mode count, target, k/m sampling, branch tracking, mode-profile policy, linewidth/absorption postprocessing requests, and eigensolver settings.

Do not collapse `DrivenFrequencyResponseRequest` and `ModalDynamicMatrixRequest` into one request. They share the operator contract; they are not the same solver.

Required request fields:

- `mesh_asset_id`
- `mesh_generation_id`
- `object_segment_map`
- `material_parameters_si`
- `llg_gamma0_si`
- `llg_alpha`
- `operator_kind`
- `include_demag`
- `demag_realization`
- `energy_terms`
- `equilibrium_source_kind`
- `equilibrium_artifact_path`
- `equilibrium_vector`
- `spin_wave_bc`
- `periodic_node_pairs`
- `floquet_k_vector`
- `k_path_sample`
- `normalization`
- `damping_policy`
- `precision`
- `device`
- `requested_mode_count`
- `target_kind`
- `target_frequency_hz`
- `response_frequencies_hz`
- `excitation_field_a_per_m`
- `requested_observables`

Required result fields:

- `status`
- `resolved_backend`
- `resolved_device`
- `resolved_precision`
- `solver_engine`
- `frequency_units`
- `phase_convention`
- `spectrum`
- `mode_metadata`
- `mode_field_payload_refs`
- `branch_tracking`
- `response_sweep`
- `equilibrium_diagnostics`
- `operator_diagnostics`
- `solver_diagnostics`
- `provenance`
- `artifact_manifest`

## FFI Error Boundary Contract

Native C++ frequency-domain code must not throw exceptions across the Rust FFI boundary.

All native entrypoints used by the Rust runner must return a C-compatible result structure with:

- `status`: `ok | unavailable | validation_error | operator_error | solve_error | artifact_error | interrupted`,
- `error_message`: nullable or empty null-terminated UTF-8 string when `status=ok`,
- `diagnostics_json`: nullable or empty null-terminated UTF-8 JSON string for structured diagnostics,
- `result_json`: nullable or empty null-terminated UTF-8 JSON string for small control-plane result metadata,
- `artifact_manifest_path`: nullable or empty null-terminated UTF-8 path when artifacts were written,
- deallocation function owned by the native library and called by Rust exactly once.

Rust runner rules:

1. Convert every non-`ok` status to a typed runner error or unsupported diagnostic.
2. Preserve `diagnostics_json` in stage diagnostics when parsing succeeds.
3. Never treat `unavailable` as a silent fallback.
4. Map `interrupted` to command cancellation rather than solver failure.
5. Add source-regression tests proving no C++ exception crosses the FFI boundary.

## Implementation Stage B1 - Native Contract Skeleton

Current state:

- Rust IR and planner know modal eigen/frequency-response semantics.
- Native FEM backend does not own a dedicated frequency-domain contract module.

Target state:

- The native FEM backend has a compile-tested frequency-domain contract with no solver implementation yet.
- Rust runner can call a no-op availability probe and receive a structured "not implemented by native production backend" response.

Instructions:

1. Inspect the current `backends/fem` source layout and locate the existing native build registration.
2. Add skeleton files under the existing layout: `include/frequency_domain`, `src/frequency_domain`, and native tests under `tests/frequency_domain`.
3. Define request/result structs in C++ with only SI units and canonical enum strings matching IR values.
4. Add conversion tests for every enum used by eigen and frequency response.
5. Add an FFI availability probe named by capability, not by implementation detail.
6. Return separate explicit unavailable statuses for driven frequency response and modal eigen/dispersion until each solve path is implemented.
7. Do not add frequency-domain fields to a shared mutable `Context` unless a narrow owner contract already exists.
8. Do not change current runner behavior in this stage except to expose the availability probe behind diagnostics.

Verification:

- Native container build: `just ensure-managed-fem-runtime`
- New native test recipe after adding it: `just verify-fem-frequency-domain-native-contract`
- Rust API smoke if the probe is surfaced: targeted `cargo test` inside the managed container recipe, not as final host proof.

## Implementation Stage B2 - Equilibrium And Tangent-Space Module

Current state:

- The transitional runner can work with equilibrium values but the equilibrium/tangent-space contract is not backend-owned.
- Physics notes require `m0 dot delta_m = 0` and equilibrium residual diagnostics.

Target state:

- Native FEM frequency-domain code has a deterministic tangent frame per magnetic DOF.
- Equilibrium import, normalization, projection, and residual diagnostics are reusable by driven response and modal products.

Instructions:

1. Implement `equilibrium_state` to load or receive magnetization in SI-compatible normalized form.
2. Reject missing equilibrium when the plan requests `provided` or `artifact` and no vector can be resolved.
3. For `relaxed_initial_state`, require a resolved relaxation artifact or a solver-owned relaxation pre-step; do not silently substitute the current authored magnetization.
4. Implement `tangent_frame` that maps each unit vector `m0_i` to two orthonormal basis vectors `e1_i`, `e2_i`.
5. Make the tangent frame deterministic near coordinate singularities by using a fixed fallback axis rule.
6. Implement projection operators:
   - full 3-vector to tangent 2-vector,
   - tangent 2-vector to full 3-vector,
   - full 3-vector tangent leakage metric.
7. Compute equilibrium diagnostics:
   - max `||m0|-1|`,
   - max `|m0 x H0|`,
   - RMS `|m0 x H0|`,
   - max tangent leakage of projected vectors,
   - object/material breakdown where object segmentation exists.
8. Emit diagnostics even when solve fails after operator assembly.

Verification:

- Native tangent frame unit tests with vectors aligned to x, y, z, and arbitrary directions.
- Property test: projecting a tangent vector back to full space yields `m0 dot delta_m` below tolerance.
- Regression test: zero equilibrium vector is rejected.
- Artifact test: diagnostics serialize with finite values and SI units.

## Implementation Stage B3 - Linearized Operator Assembly

Current state:

- `FemEigenPlanIR` contains modal operator semantics.
- Transitional assembly lives in runner-side code and is not the production native FEM module.

Target state:

- Native FEM frequency-domain owns a reusable operator assembly for:
  - exchange,
  - Zeeman,
  - demag where supported,
  - interfacial DMI,
  - bulk DMI,
  - surface anisotropy,
  - damping policy.

Instructions:

1. Define the canonical operator form in the native contract as tangent-space blocks.
2. Keep the physical sign convention tied to `docs/physics/0700-frequency-domain-linearized-llg.md`.
3. Assemble local terms through MFEM coefficient/operator objects, not through ad-hoc dense matrices for production.
4. Keep dense matrix extraction only for small validation tests and debugging.
5. Separate demag model families:
   - no demag,
   - Poisson airbox Dirichlet/Robin,
   - PBC-reduced Poisson,
   - future FEM/BEM Fredkin-Koehler,
   - future BEM/FMM,
   - future mapped exterior.
6. Reject Floquet dynamic demag until a documented phase-aware demag model is implemented.
7. Preserve current planner behavior that rejects unsupported energy terms.
8. Add operator diagnostics:
   - assembled DOF count,
   - tangent DOF count,
   - nonzero count where available,
   - symmetry/skew-symmetry checks where applicable,
   - conditioning estimates where available,
   - demag realization,
   - included energy terms,
   - boundary condition realization.

Verification:

- Unit test exchange-only operator on a small mesh.
- Unit test Zeeman-only operator against analytic FMR order-of-magnitude.
- Regression test that `include_demag=true` without a demag term fails before assembly.
- Regression test that Floquet plus dynamic demag fails with the documented error.
- Native/Rust artifact parity test for metadata fields written by current runner.

## Implementation Stage B4 - Production Driven Frequency Response Solver

Current state:

- Python and IR expose `FrequencyResponse`.
- Planner produces `FemFrequencyResponsePlanIR` for supported FEM response cases and rejects unsupported FDM/GPU/precision cases explicitly.
- API can serve `response/magnetic_response_sweep.v1.json` and v2 response resources when artifacts exist.
- The dense validation response writer can emit those artifacts, and the limited native MFEM production CPU response lane now writes the same response/manifest family for its supported slice.

Target state:

- FEM driven frequency response is executable for magnetic-only linearized LLG.
- It solves the harmonic response directly at requested drive frequencies.
- It writes response sweep artifacts consumed by Control Room.
- It is not implemented by first running an eigensolver and postprocessing modes.

Instructions:

1. Add `FemFrequencyResponsePlanIR` in the planner layer only after the native solver contract exists.
2. Define the driven system as the documented harmonic linearized LLG problem.
3. Build the excitation vector from `excitation.field_a_per_m` projected into tangent space.
4. For each frequency, solve the complex linear system with the same sign and phase convention as the physics note.
5. Reuse factorization or preconditioner across frequency points where the backend supports it.
6. Compute observables:
   - `m_complex`,
   - `response_amplitude`,
   - `response_phase`,
   - `susceptibility_tensor`,
   - `absorbed_power_density`.
7. Reject magnetoelastic observables until the magnetoelastic frequency-domain physics note has implementation-ready backend instructions.
8. Write `response/magnetic_response_sweep.v1.json` for compatibility.
9. Add a v2 response artifact when the UI needs frequency-point field payloads:
   - `response/magnetic_response_sweep.v2.json`,
   - `response/frequency_points/{index}.json`,
   - field-like response payload refs for 3D visualization,
   - Zarr-backed response arrays in `response/field_payloads.zarr` by default.
     HDF5/H5 may be used as an alternate backend/export only when the API
     preserves the same field resource contract. Raw `vector.bin` payloads are
     compatibility exports, not the production default.
10. Keep frequency values in Hz externally and angular frequency in rad/s internally where equations require it.
11. Use TetraX absorption only as an optional modal postprocessing reference, not as the implementation of direct driven response.
12. Use Tetmag RF/pulse/sweep semantics as a time-domain validation/reference source, not as the direct solver implementation.

Verification:

- Planner test changes from semantic-only rejection to executable only for the explicitly supported backend/device/precision set.
- Response sweep smoke test writes finite amplitude and phase for at least two positive frequencies.
- Near a known modal resonance, response amplitude increases relative to an off-resonance point in a controlled benchmark.
- Invalid frequency list, unsupported observable, and unsupported magnetoelastic coupling fail before native execution.
- API test proves `magnetic-sweep.v1` is served from a solver-created artifact.
- Optional validation compares a small direct response sweep against modal reconstruction from the modal solver where the assumptions match.

## Implementation Stage B5 - Modal Dynamic-Matrix Eigen/Dispersion Solver

Current state:

- CPU reference eigensolve exists in `crates/fullmag-runner/src/fem_eigen.rs`.
- GPU dense cuSolver helper exists for small matrices.
- The current production-scale native modal solver is missing.
- TetraX provides the local reference shape for dynamic-matrix eigenmodes, dispersion, mode profiles, linewidths, and modal absorption.

Target state:

- Native FEM CPU modal solver supports scalable mode extraction for the planned operator.
- The solver can produce v2 spectrum, branch, diagnostics, and mode metadata.
- Dense reference remains available for small validation cases only.
- Modal absorption and linewidth calculations are explicit postprocessing products, not the direct frequency-domain solver.

Instructions:

0. Before any production modal solver implementation, verify scalable eigensolver availability in the managed FEM container.
   - Run the managed runtime recipe first: `just ensure-managed-fem-runtime`.
   - Inside the managed environment, check the selected solver, for example `slepc-config --version` for SLEPc when PETSc/SLEPc is selected.
   - If SLEPc is unavailable, add it to the managed container build before using it in the implementation plan.
   - If another solver is selected, such as ARPACK, FEAST, MFEM LOBPCG, or MFEM AME, document why it satisfies Fullmag's target scaling, residual, damping, and provenance requirements.
1. Introduce a modal solver interface that accepts the assembled tangent operator and modal target request.
2. Implement CPU production eigensolve with a scalable backend available in the managed FEM container.
3. Support at least:
   - lowest modes,
   - nearest-frequency target through shift strategy,
   - mode count,
   - real undamped eigenvalues,
   - complex damped eigenvalues when the selected backend supports them.
4. Treat damping as a modal solver contract decision:
   - `ignore` produces real spectrum,
   - `include` or `linearized` produces complex frequency metadata,
   - unsupported complex mode solve fails clearly.
5. Emit per-mode diagnostics:
   - residual norm,
   - normalization factor,
   - tangent leakage,
   - orthogonality score,
   - convergence status,
   - iteration count where available.
6. Implement k-path sampling by invoking the same operator assembly per sample with explicit sample metadata.
7. Implement branch tracking after all sample solves, not inside one sample solve.
8. Keep mode identity stable as `{sampleIndex, rawModeIndex, branchId?}`.
9. Write v2 artifacts with the schema names already documented in `docs/specs/frequency-domain-artifacts-v2.md`.
10. Preserve the current runner output names until the v2 UI no longer needs legacy fallbacks.
11. Add explicit modal postprocessing outputs for linewidths and absorption only after the mode-profile contract is stable.

Verification:

- Existing Rust runner tests continue to pass for the reference path.
- New managed native tests compare native CPU production modal results against the current reference solver on small meshes.
- TetraX reference-style dispersion tests are adapted where geometries and interactions match.
- Analytic FMR benchmark stays in the same order-of-magnitude window.
- Mesh-refinement frequency drift is bounded by the threshold defined in validation tests.
- Periodic k=0 equals free within tolerance where the existing test expects it.
- Exchange-only Floquet reciprocal test passes.
- Bulk-DMI Floquet nonreciprocal test passes.

## Implementation Stage B6 - GPU Lane Qualification

Current state:

- A dense GPU path exists as a transitional helper.
- Full production GPU frequency-domain solve is not proven.

Target state:

- GPU frequency-domain support is explicit and gated.
- The UI and provenance can distinguish "GPU reference dense path", "GPU production path", and "CPU production path".

Instructions:

1. Keep `gpu_cusolver_fem_eigen` labeled as small dense/reference unless it becomes scalable.
2. Do not mark `supports_frequency_domain_gpu=true` until the managed container includes the full dependency chain and tests pass inside it.
3. If PETSc/SLEPc GPU support is selected, containerize and validate the exact build flags.
4. If libCEED operator application is selected, validate CPU/GPU numerical parity before exposing UI support.
5. Add device residency diagnostics:
   - operator assembly device,
   - solve device,
   - host/device copy count,
   - peak device memory where available,
   - fallback reason if any fallback is explicitly allowed.
6. Explicit GPU request must fail on unsupported paths; it must not silently fall back to CPU.

Verification:

- Managed GPU recipe: `just fem-gpu-headless ...` remains smoke-level for FEM GPU runtime.
- Current recipe: `just verify-fem-frequency-domain-gpu` runs the native frequency-domain contract and proves explicit production-GPU driven-response requests fail as unavailable without validation fallback. It must be extended to at least one GPU eigen smoke before `supports_frequency_domain_gpu=true`.
- API status exposes requested device and resolved device separately.

## Implementation Stage B7 - Managed `just` Recipes

Current state:

- The `justfile` has managed FEM recipes such as `ensure-managed-fem-runtime`, `rebuild-fem-runtime`, `fem-gpu-headless`, and `verify-fem-relaxation-runtime`.
- `verify-fem-frequency-domain-native-contract` runs the native frequency-domain contract test through the managed FEM container.
- `verify-fem-frequency-domain-runtime` runs the dense FEM validation response smoke through the managed FEM container and verifies the v1/v2 response bundle, progress, diagnostics, field payload, and frequency-domain manifest artifacts.
- `verify-fem-frequency-domain-static-periodic-runtime` runs the k = 0 static-periodic driven-response smoke through the same managed FEM container and requires `static_periodic_*` diagnostics in the response diagnostics and manifest artifacts.

Target state:

- Frequency-domain backend verification is reproducible through repo-owned `just` recipes.

Instructions:

1. Add `just verify-fem-frequency-domain-contract` for contract-only native tests.
2. Add `just verify-fem-eigen-runtime` for current and production eigen tests.
3. Add `just verify-fem-frequency-response-runtime` when driven response becomes executable.
4. Add `just verify-fem-frequency-domain-runtime` as the aggregate recipe used before PR completion.
5. Add `just verify-fem-frequency-domain-static-periodic-runtime` as the explicit k = 0 static-periodic response gate.
6. Ensure recipes run through the same managed FEM container mechanism as existing FEM recipes.
7. Ensure recipes set stable artifact output roots under ignored build/test directories.
8. Document which recipe is required for CPU-only machines and which one needs CUDA.

Verification:

- `just --list` shows the recipes.
- Each recipe fails if the managed runtime is unavailable instead of falling back to host-only builds.
- CI and local docs name the same recipes.

## Backend Acceptance Gate

The backend is implementation-complete only when all of these are true:

- `FrequencyResponse` no longer plans to a semantic-only rejection for supported FEM magnetic-only cases.
- Production native FEM eigen writes v2 artifacts equivalent to the current runner path.
- Production native FEM driven response writes at least `magnetic_response_sweep.v1`.
- The API serves solver-created eigen and response artifacts without manual files.
- CPU reference, CPU production, and GPU-qualified paths have separate provenance.
- Unsupported Floquet demag, unsupported magnetoelastic response, unsupported complex damping, and unsupported explicit GPU fail clearly.
- Managed `just` verification is the documented proof path.
