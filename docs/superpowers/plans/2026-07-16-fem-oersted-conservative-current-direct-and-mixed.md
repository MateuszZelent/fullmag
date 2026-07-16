# FEM Oersted Conservative Current, Direct Oracle, and Mixed Solver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the CPU-double FEM Oersted chain OE-T0 -> OE-F1 -> OE-F2: one immutable conservative `RT0/H(div)` current view, a cutoff-free direct tetrahedral Biot--Savart oracle, and the exact-sequence `H_0(curl) x H^1_0` vector-potential solver.

**Architecture:** Current transport remains the sole owner of `J_charge` and publishes a revision/digest-pinned RT0 view. Two separate Oersted modules consume the same view: OE-F1 is a deterministic small-problem direct oracle; OE-F2 is the production-shaped MFEM mixed solver on conductor+closure+airbox. Rust plans/orchestrates and publishes artifacts, but all numerical ownership stays under `backends/fem`; existing cylinder/midpoint paths remain separate compatibility realizations.

**Tech Stack:** C++17, MFEM Nedelec/RT/H1 spaces, hypre AMS/BoomerAMG, C ABI, Rust FFI/ProblemIR/planner/runner/API, Python DSL, React Control Room, container-backed repository `just` recipes.

## Global Constraints

- Canonical physics is `docs/physics/0980-dynamic-current-and-oersted-coupling.md`; changing an equation, sign, unit, gauge, BC, quadrature, or projection requires a new version identifier and publication review first.
- Implement CPU-double only. Do not add, alter, compile, or claim CUDA/GPU OE-T0/OE-F1/OE-F2 execution in this plan.
- `J_c` is signed conventional current density in `A/m^2`; `H_oe` is `A/m`; `B_oe=mu0 H_oe` is `T`; `A` is `T m`; `p` is `A/m`.
- Neither Oersted solver may consume the nodal visualization `J_charge` buffer or recompute `-sigma grad V`.
- Baseline OE-F2 is exactly `A in H_0(curl)` and `p in H^1_0`; no scalar pin or zero-mean substitute is legal.
- The zero-mean `H1/R` formulation is a separate boundary variant and remains fail-closed unless its own tests and capability scope are implemented.
- Nontrivial discrete cohomology is rejected until a versioned harmonic basis/constraint implementation exists.
- Existing legacy cylinder/midpoint rows do not prove canonical OE-F1/OE-F2 capability. Status remains `semantic_only` until every named promotion gate passes.
- Native build/runtime proof starts with repository-owned container `just` recipes. Host `cargo`, `cmake`, direct binaries, and raw Docker are diagnostics only.
- Every milestone receives an independent physics/spec review and an implementation-quality review before the next milestone starts.

## Required reading before implementation

- `docs/physics/0980-dynamic-current-and-oersted-coupling.md` and `docs/specs/spin-transport-runtime-contract-v1.md` for normative semantics.
- `docs/papers/mic_intro.pdf` for Ampere/divergence, `H`/`B`, and external-Zeeman conventions.
- `docs/comsol/Manual_for_Micromagnetics_Module.pdf` for the product workflow that binds electric-current results to magnetization; it is not a discretization oracle.
- MFEM [Example 34](https://docs.mfem.org/html/ex34_8cpp_source.html), [Maxwell notes](https://mfem.org/maxwell-notes/), and Examples 3/4/24. Example 34's own warning about non-divergence-free demonstration current is a mandatory OE-T0 review point.
- Hiptmair, [Finite elements in computational electromagnetism](https://doi.org/10.1017/S0962492902000041), for exact-sequence/cohomology constraints.
- `external_solvers/neuralmag/neuralmag/common/convolution_setup.py`, `convolution_runtime.py`, and `field_terms/oersted_field.py` for comparative regular-grid Oersted semantics only.
- `external_solvers/BORIS/Boris/OerstedTFunc.cpp`, `OerstedKernel.cpp`, `Oersted.cpp`, and `Transport_Charge_Display.cpp` for comparative lifecycle/ownership only.

## File and ownership map

| File | Responsibility |
|---|---|
| `backends/fem/cpu/mfem/transport/conservative_current_view.hpp/.cpp` | OE-T0 RT0 construction, immutable metadata, balance certificate and digest inputs |
| `backends/fem/cpu/mfem/transport/steady_transport.hpp/.cpp` | publish RT0 view alongside existing visualization fields without transferring ownership |
| `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp/.cpp` | OE-F1 singular/near/far tetrahedral integration and deterministic accumulation |
| `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp/.cpp` | OE-F2 exact-sequence spaces, block forms, BC, topology gate, solve and projection |
| `backends/fem/cpu/mfem/interactions/oersted.hpp/.cpp` | typed realization dispatch only; no numerical kernels |
| `native/include/fullmag_fem.h` | new self-describing Oersted ABI family and immutable current-view descriptor |
| `crates/fullmag-fem-sys/src/lib.rs` | exact C ABI mirror and layout assertions |
| `crates/fullmag-ir/src/study.rs`, `spin_transport.rs`, and `plan.rs` | authored policy and resolved source/gauge/quadrature identity |
| `crates/fullmag-plan/src/oersted.rs` | legality, source/closure/topology binding and fail-closed capability resolution |
| `crates/fullmag-runner/src/native_fem/oersted.rs` | ABI orchestration only |
| `crates/fullmag-runner/src/artifacts.rs` | RT0 manifest/data and Oersted field/diagnostic/provenance artifacts |
| `crates/fullmag-api/src/quantity_data_plane.rs` | revisioned `H_oe`/work-snapshot projection through the existing data plane |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | canonical tagged CPU policies and exact script round-trip |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.ts` and `SpinAuthoringInspector.tsx` | current-view/Oersted authoring, capability and inspector projection through typed API |
| `backends/fem/tests/*oersted*` | native independent physics and numerical contracts |
| `justfile` | one managed CPU-double OE-F1/OE-F2 verification recipe |

---

### Task 1: OE-T0 conservative RT0 current-view contract

**Files:**
- Create: `backends/fem/cpu/mfem/transport/conservative_current_view.hpp`
- Create: `backends/fem/cpu/mfem/transport/conservative_current_view.cpp`
- Create: `backends/fem/tests/conservative_current_view_contract.cpp`
- Modify: `backends/fem/cpu/mfem/transport/steady_transport.hpp`
- Modify: `backends/fem/cpu/mfem/transport/steady_transport.cpp`
- Modify: `backends/fem/CMakeLists.txt`

**Interfaces:**
- Consumes: the converged M1 charge potential, conductivity coefficient, tetrahedral mesh, globally completed closure support, source/mesh/topology revisions, stage time.
- Produces:

```cpp
struct ConservativeCurrentBalanceCertificate {
    double max_element_divergence_a;
    double max_internal_face_jump_a;
    double net_outer_flux_a;
    double electrode_balance_relative;
    bool closure_complete;
};

struct ConservativeCurrentIdentity {
    std::string operator_version;
    std::string source_module_id;
    std::string source_state_revision;
    std::string source_field_digest;
    std::string mesh_revision;
    std::string topology_revision;
    std::string geometry_digest;
    std::string closure_revision;
    std::string closure_digest;
    std::string rt0_true_dof_digest;
    double evaluation_time_s;
    uint64_t stage_identity;
};

class ConservativeCurrentView {
public:
    static constexpr const char *operator_version =
        "fem_conservative_current_rt0_view.v1";
    const mfem::FiniteElementSpace &space() const;
    const mfem::GridFunction &field() const;
    const ConservativeCurrentIdentity &identity() const;
    const ConservativeCurrentBalanceCertificate &balance() const;
};
```

- [ ] **Step 1: Write failing native tests for orientation, conservation, identity, and immutability**

Create fixtures for two tetrahedra sharing a face and a closed conductor loop. Assert exact cancellation of the globally oriented shared-face flux, element integrated divergence below `1e-12 A`, closure balance below `1e-12`, and digest changes for each individual source/mesh/closure revision mutation. Add rejection cases for NaN RT0 dofs, an unpaired terminal, stale source revision, non-tetrahedral input, and mutation of the source after view construction.

```cpp
require(view.identity().operator_version ==
        "fem_conservative_current_rt0_view.v1", "wrong operator version");
require(view.balance().max_internal_face_jump_a <= 1.0e-12,
        "RT0 normal trace is not single-valued");
require(view.balance().max_element_divergence_a <= 1.0e-12,
        "RT0 element current is not conservative");
require(view.balance().closure_complete, "current closure is incomplete");
```

- [ ] **Step 2: Run the managed test and confirm RED**

Add `fem_conservative_current_view_contract` to CMake, then run:

```bash
just verify-fem-oersted-oef1-contract
```

Expected: the managed container configures successfully and fails because the new target/API is not implemented; it must not fall through to an existing nodal-current test.

- [ ] **Step 3: Implement conservative RT0 reconstruction**

Use `RT_FECollection(0,3)` and the global true-dof orientation from MFEM. Assemble a constrained flux-equilibration/mixed projection that minimizes the weighted difference from `-sigma grad V` subject to the element divergence and terminal/closure constraints. Do not use `GridFunction::ProjectCoefficient` as proof of conservation. Construct a new immutable view only after both algebraic convergence and the independent integrated balance pass.

The balance calculator must independently integrate outward flux per element and outer/electrode boundary, pair internal faces once, and apply the v1 absolute/relative floors from the runtime contract. Hash canonical little-endian FP64 true dofs plus all identity strings; never hash pointer values or partition-local ordering.

- [ ] **Step 4: Preserve visualization compatibility without semantic aliasing**

Keep `charge_current_density()` as the current nodal visualization quantity. Add `conservative_charge_current()` returning the typed view and state in comments/tests that the two buffers have different contracts. Spin transport may keep its existing coefficient evaluation in this milestone; only OE-F1/OE-F2 are allowed to require the RT0 view.

- [ ] **Step 5: Run focused and steady-transport managed gates**

```bash
just verify-fem-oersted-oef1-contract
just verify-fem-steady-transport-native-contract
```

Expected: all OE-T0 cases pass; existing M1 steady-transport ABI/physics gates remain green.

- [ ] **Step 6: Review checkpoint OE-T0**

Independent physics review must verify Piola/orientation/sign/SI and that every permitted closure has zero unpaired outer flux. Independent architecture review must verify no new current state in generic `Context`, `mfem_bridge.cpp`, runner dispatch, or an Oersted module. Resolve every Critical/Important finding before committing.

- [ ] **Step 7: Commit OE-T0**

```bash
git add backends/fem/cpu/mfem/transport/conservative_current_view.hpp \
  backends/fem/cpu/mfem/transport/conservative_current_view.cpp \
  backends/fem/cpu/mfem/transport/steady_transport.hpp \
  backends/fem/cpu/mfem/transport/steady_transport.cpp \
  backends/fem/tests/conservative_current_view_contract.cpp \
  backends/fem/CMakeLists.txt justfile
git commit -m "feat(fem): publish conservative RT0 current view"
```

### Task 2: OE-T0 ABI, artifact, and provenance bridge

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem/steady_transport.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Test: `backends/fem/tests/steady_transport_abi_contract.cpp`
- Test: `crates/fullmag-fem-sys/src/lib.rs`
- Test: `crates/fullmag-runner/src/lib/tests.rs`

**Interfaces:**
- Consumes: `ConservativeCurrentView` from Task 1.
- Produces: `fullmag.fem.conservative_current_view.v1` descriptor, canonical RT0 binary member, JSON manifest and runner-side `ConservativeCurrentViewRef`.

- [ ] **Step 1: Write failing append-only ABI and artifact tests**

Define a new ABI family rather than changing the size of `fullmag_fem_steady_transport_result_v1`. Test the exact prefix `(abi_version, struct_version, struct_size)`, null/length mismatch rejection, finite dofs, digest verification, and round-trip of every revision. Runner tests must tamper independently with RT0 bytes, source revision, closure digest and mesh revision and observe fail-closed loading.

- [ ] **Step 2: Implement self-describing descriptor and Rust mirror**

```c
typedef struct fullmag_fem_conservative_current_view_v1 {
    uint32_t abi_version;
    uint32_t struct_version;
    uint64_t struct_size;
    const double *rt0_true_dofs;
    uint64_t rt0_true_dof_count;
    const char *operator_version;
    const char *source_state_revision;
    const char *source_field_digest;
    const char *mesh_revision;
    const char *topology_revision;
    const char *geometry_digest;
    const char *closure_revision;
    const char *closure_digest;
    const char *rt0_true_dof_digest;
    double evaluation_time_s;
    uint64_t stage_identity;
} fullmag_fem_conservative_current_view_v1;
```

Mirror this layout exactly in Rust, add compile-time size/offset assertions, and expose a separate getter with caller-owned buffers. Never return an MFEM object pointer across the ABI.

- [ ] **Step 3: Persist canonical data-plane artifact**

Write `current_transport/<id>.rt0.f64le` and `current_transport/<id>.conservative-view.json` atomically. The JSON manifest contains schema/operator versions, count, byte length, SHA-256 digest, SI/component/space tags, all source/mesh/topology/closure revisions, balance certificate, evaluation time and stage identity. On restore, validate the complete manifest before allocating or exposing an Oersted request.

- [ ] **Step 4: Verify and review OE-T0 bridge**

```bash
just verify-fem-oersted-oef1-contract
just verify-fem-steady-transport-native-contract
cargo test -p fullmag-runner conservative_current_view --features fem-gpu
```

The first two commands are authoritative managed proof. The last command is auxiliary Rust contract proof. Review must confirm raw arrays are data-plane artifacts and JSON never embeds the heavy current field.

- [ ] **Step 5: Commit OE-T0 bridge**

```bash
git add native/include/fullmag_fem.h crates/fullmag-fem-sys/src/lib.rs \
  crates/fullmag-runner/src/native_fem/steady_transport.rs \
  crates/fullmag-runner/src/artifacts.rs backends/fem/tests/steady_transport_abi_contract.cpp \
  crates/fullmag-runner/src/lib/tests.rs
git commit -m "feat(fem): persist conservative current-view provenance"
```

### Task 3: OE-F1 deterministic direct tetrahedral oracle

**Files:**
- Create: `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp`
- Create: `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp`
- Create: `backends/fem/tests/oersted_direct_tetra_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`

**Interfaces:**
- Consumes: immutable `ConservativeCurrentView` and magnetic observation/projection spaces.
- Produces: projected nodal `H_oe [A/m]`, `fem_oersted_direct_tetra_quadrature.v1` diagnostics and immutable work-snapshot identity.

- [ ] **Step 1: Write failing analytic and singular quadrature tests**

Cover target points far from, near, inside, on a face of, and on an edge of a current tetrahedron. Verify refinement convergence against a high-depth independent run, no cutoff/self deletion, exact current-sign involution, rigid rotation covariance, deterministic bytes across two runs, and failure when the subdivision limit is reached. Add closed straight-wire/cylinder workloads only with a controlled finite-return geometry.

```cpp
require(relative_l2(h_reversed, -h_forward) <= 1.0e-12,
        "signed-current involution failed");
require(result.diagnostics.unconverged_pair_count == 0,
        "quadrature accepted an unconverged source-target pair");
require(result.identity.source_field_digest == view.identity().source_field_digest,
        "Oersted result is not pinned to its current source");
```

- [ ] **Step 2: Run managed gate and confirm RED**

```bash
just verify-fem-oersted-oef1-contract
```

Expected: OE-T0 remains green and the new OE-F1 target fails at the missing direct solver.

- [ ] **Step 3: Implement far/near/singular integration**

Evaluate the affine physical RT0 field at every quadrature point. Use embedded tetrahedral rules for separated pairs and compare componentwise estimates against `atol_Apm + rtol*max(|H_hi|,|H_lo|)`. Recursively subdivide near pairs in a deterministic child order. For a target on/in a tetrahedron, split it into positive-volume target-vertex sub-tetrahedra and apply a Duffy/Gauss--Jacobi rule; reject zero/negative Jacobians. Accumulate each component with Neumaier compensation in global element order.

- [ ] **Step 4: Implement shared projection and snapshot output**

Place the observation samples into a dedicated coefficient and solve one consistent vector `L2` mass projection to the LLG nodal field space. Return only that projected field as publishable `H_oe`. Compute external Zeeman energy without `1/2`; emit a nonvariational work snapshot instead when source identity includes magnetization dependence.

- [ ] **Step 5: Verify complexity guard and physics**

Reject requests above an explicit source-target pair budget before allocation. Run:

```bash
just verify-fem-oersted-oef1-contract
just verify-fem-time-domain-native-contract
```

Expected: direct tests, existing Oersted observable tests, and the full native time-domain contract pass in the managed container.

- [ ] **Step 6: Review checkpoint OE-F1 and commit**

Physics reviewer checks cross-product order, `1/(4*pi)`, absence of `mu0`, singular integrability, rotation/sign, and energy semantics. Numerical reviewer checks embedded estimator, termination, deterministic ordering and projection. Architecture reviewer confirms direct code is not in aggregate `oersted.cpp` or runner. Then commit:

```bash
git add backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp \
  backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp \
  backends/fem/tests/oersted_direct_tetra_contract.cpp \
  backends/fem/CMakeLists.txt justfile
git commit -m "feat(fem): add direct tetrahedral Oersted oracle"
```

### Task 4: OE-F1 public plan, ABI, artifacts, and fail-closed capability

**Files:**
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/spin_transport.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-plan/src/oersted.rs`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Create: `crates/fullmag-runner/src/native_fem/oersted.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/current_transport.py`
- Test: `crates/fullmag-plan/src/tests.rs`
- Test: `packages/fullmag-py/tests/test_current_transport.py`

**Interfaces:**
- Consumes: public `OerstedField(method="direct_biot_savart")`, a named current source and its conservative-view artifact.
- Produces: resolved CPU-double OE-F1 plan and revisioned field/diagnostic/work artifacts; capability remains `semantic_only` until the final promotion task.

- [ ] **Step 1: Write failing serializer/planner tests**

Test exact Python -> ProblemIR -> canonical Python round-trip for the tagged direct policy. Planner accepts only FEM/CPU/double/strict, globally closed tetrahedral source, complete OE-T0 ref, finite tolerances and pair budget. It rejects FEM GPU, any single precision, missing closure, nodal-only current, stale digest, PBC, pair-budget excess and an attempt to reuse vector-potential Krylov parameters.

- [ ] **Step 2: Add typed resolved policy and dedicated ABI call**

Use these resolved fields without embedding RT0 data in IR:

```text
ResolvedFemDirectTetraOerstedIR = {
  operator_version:"fem_oersted_direct_tetra_quadrature.v1",
  realization_version:"oersted_direct_biot_savart.v1",
  engine:"fem_oersted_direct_tetra_cpu_v1",
  current_view_ref:ConservativeCurrentViewRef,
  quadrature_profile:"fem_tetra_singular_adaptive_fp64.v1",
  relative_tolerance, absolute_tolerance_Apm,
  maximum_subdivision_depth, maximum_pair_count,
  observation_space, projection_version, work_semantics
}
```

Add a separate ABI request/result family; do not append fields to the wide time-domain plan or route numerical work through `dispatch.rs`.

- [ ] **Step 3: Publish exact OE-F1 artifacts**

Persist projected `H_oe`, quadrature diagnostics, consumed current-view digest, operator/realization/engine IDs, observation/projection identity and work snapshot atomically. The field-store/API uses the artifact revision and ETag; it must not expose tentative or rejected-stage results.

- [ ] **Step 4: Verify, review, and commit OE-F1 integration**

```bash
just verify-fem-oersted-oef1-contract
cargo test -p fullmag-plan oersted
cargo test -p fullmag-runner fem_direct_tetra_oersted --features fem-gpu
python -m unittest packages/fullmag-py/tests/test_current_transport.py
```

Review must confirm public semantics do not imply GPU or validated status. Commit only the listed paths with message `feat(fem): wire direct Oersted oracle end to end`.

### Task 5: OE-F2 exact-sequence mixed `H_0(curl) x H^1_0` solver

**Files:**
- Create: `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp`
- Create: `backends/fem/cpu/mfem/interactions/oersted/vector_potential.cpp`
- Create: `backends/fem/tests/oersted_vector_potential_contract.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/oersted.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/oersted.cpp`
- Modify: `backends/fem/CMakeLists.txt`

**Interfaces:**
- Consumes: the same OE-T0 view, closed conductor/lead support, containing airbox and topology certificate.
- Produces: `A`, `p`, projected `H_oe`, curl/div/gauge diagnostics, airbox identity and work snapshot.

- [ ] **Step 1: Write failing exact-sequence and manufactured-solution tests**

Build compatible `ND_FECollection(1,3)`, `H1_FECollection(1,3)` and RT0 source fixtures. Verify `grad(H1_0)` maps into the essential ND space, the discrete `curl*grad` norm is below `1e-13`, every scalar boundary true dof is essential in the baseline, no mean constraint/pin exists, and the block matrix has the specified `C/B/B^T/0` structure. Add manufactured `A`, signed-current, source-digest, current-range, curl/div/gauge, projection and three-airbox fixtures.

Add fail-closed tests for nontrivial topology without harmonic constraints, current support outside airbox, mismatched source mesh, PBC, `mu_r != 1`, and selecting `natural_curl_zero_mean_h1.v1` before that separate variant exists.

- [ ] **Step 2: Run managed gate and confirm RED**

```bash
just verify-fem-oersted-oef2-contract
```

Expected: configuration reaches the new target and fails on missing vector-potential implementation; OE-T0/OE-F1 targets remain green.

- [ ] **Step 3: Assemble exact weak form and essential spaces**

Create ND and H1 spaces on the same airbox mesh. Mark all outer-boundary tangential ND dofs essential and all outer-boundary H1 dofs essential. Assemble

```text
C(A,v)=(mu0^-1 curl A,curl v)
B(p,v)=(grad p,v)
f(v)=(J_RT0,v)
constraint(A,q)=(A,grad q)
```

directly from the RT0 view. Do not project the source to ND first. Validate discrete cohomology before solve and reject nonzero Betti/harmonic count in v1.

- [ ] **Step 4: Solve and independently measure physical residuals**

Use block GMRES with AMS on the ND block and BoomerAMG on the Dirichlet H1 block. Defaults are restart `100`, maximum iterations `2000`, algebraic rtol `1e-10`. Independently compute `rho_curl`, `rho_div`, `rho_gauge`, block residual, essential-boundary residual and harmonic count; library convergence alone is insufficient.

- [ ] **Step 5: Project and publish field/work identity**

Compute `B_oe=curl A` in the compatible H(div) space, divide by `mu0` exactly once, then apply the same consistent nodal `L2` projection/version as OE-F1. Reuse the common energy/work-snapshot builder so direct and mixed paths cannot drift in sign, `mu0`, `1/2`, source identity or rejected-stage behavior.

- [ ] **Step 6: Run cross-oracle and airbox gates**

```bash
just verify-fem-oersted-oef2-contract
just verify-fem-oersted-oef1-contract
just verify-fem-time-domain-native-contract
```

Require at least three geometrically similar airboxes, monotone/asymptotic convergence in the fixed magnetic target domain, and OE-F2-vs-OE-F1 field/energy convergence under mesh refinement. Store numerical tolerances in the fixture, not prose-only assertions.

- [ ] **Step 7: Review checkpoint OE-F2 and commit**

Physics review checks strong/weak form, exact spaces, BC, topology, SI/sign/energy. MFEM review checks AMS prerequisites, true-dof essential elimination, source pairing and projection. Architecture review checks the aggregate only dispatches typed owners and no algorithm enters `Context`/bridge/Rust. Commit with message `feat(fem): solve mixed vector-potential Oersted field`.

### Task 6: OE-F2 end-to-end authoring, runtime, API, UI, and provenance

**Files:**
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/spin_transport.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-plan/src/oersted.rs`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem/oersted.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-api/src/quantity_data_plane.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/current_transport.py`
- Modify: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx`
- Test: `crates/fullmag-plan/src/tests.rs`
- Create: `crates/fullmag-runner/src/native_fem/tests/oersted.rs`
- Test: `packages/fullmag-py/tests/test_current_transport.py`
- Test: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.test.ts`
- Create: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.test.tsx`

**Interfaces:**
- Consumes: public `fem_vector_potential` policy and current source.
- Produces: resolved baseline gauge/BC, native execution request, exact artifact/provenance, resource-first quantity and canonical Python/UI round-trip.

- [ ] **Step 1: Write failing four-path round-trip and capability tests**

Verify Python authoring, serialized ProblemIR, UI edit/export and reload preserve `boundary_gauge_variant`, Krylov policy, harmonic policy, current source and closure byte-for-byte. Empty/default selection normalizes to `tangential_A_h1_0.v1`; explicitly authored zero-mean variant rejects as unavailable rather than silently running baseline. GPU/single requests reject before native construction.

- [ ] **Step 2: Wire typed plans and ABI without generic ownership**

Extend the dedicated Oersted ABI family with the baseline variant and solver fields. Runner loads/validates OE-T0 artifacts, invokes the native owner, and publishes outputs. `dispatch.rs`, generic `execute.rs`, `Context`, and `mfem_bridge.cpp` may only name/call the owner; they may not assemble spaces/forms or store duplicate physics policy.

- [ ] **Step 3: Expose resource-first observability**

Serve the existing `H_oe` quantity from the projected artifact and expose compact diagnostics/provenance: requested/resolved method, operator/engine, source/closure digests, gauge/BC, topology certificate, airbox sizes, iterations/residuals, projection version, work semantics and snapshot identity. Heavy fields remain binary. Inspector labels carry SI units and show `semantic_only`/unsupported states exactly from capability data.

- [ ] **Step 4: Run API/UI gates**

```bash
cargo test -p fullmag-plan oersted
cargo test -p fullmag-runner fem_vector_potential_oersted --features fem-gpu
python -m unittest packages/fullmag-py/tests/test_current_transport.py
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
pnpm --dir apps/control-room test
```

Also run the existing Control Room authoring/browser smoke and verify exact inspector fields, current-view freshness and `H_oe` field selection without WebGL/context errors.

- [ ] **Step 5: Review checkpoint full stack and commit**

One reviewer traces a single source revision from Python/UI through IR, plan, ABI, native result, artifact, API and inspector. A second reviewer attempts stale-digest, unsupported-GPU, zero-mean-substitution and rejected-stage attacks. Commit with message `feat(fem): expose mixed Oersted workflow end to end` only after all findings are resolved.

### Task 7: Qualification, status promotion decision, and durable report

**Files:**
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/physics/0980-dynamic-current-and-oersted-coupling.md`
- Modify: `docs/specs/spin-transport-runtime-contract-v1.md`
- Create: `docs/raports/2026-07-16_fem-oersted-oef1-oef2/IMPLEMENTATION_AND_VALIDATION.md`
- Modify: `justfile`

**Interfaces:**
- Consumes: all OE-T0/OE-F1/OE-F2 code, artifacts and review evidence.
- Produces: one reproducible managed gate, explicit validated scope or an honest retained `semantic_only` status, and a publication-quality evidence report.

- [ ] **Step 1: Freeze managed verification recipes**

Add `just verify-fem-oersted-oef1-contract` and `just verify-fem-oersted-oef2-contract` that configure/build/run the exact native tests and Rust ABI checks inside the managed FEM container. Add one public end-to-end recipe that runs canonical Python authoring, planner, native CPU-double execution, artifact validation and quantity readback.

- [ ] **Step 2: Run complete evidence matrix**

```bash
just verify-fem-steady-transport-native-contract
just verify-fem-oersted-oef1-contract
just verify-fem-oersted-oef2-contract
just verify-fem-time-domain-native-contract
just check
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
pnpm --dir apps/control-room test
```

Record command, commit, managed runtime digest, workload, mesh/airbox sequence, tolerances, result, artifact hashes and wall time. A started container or one green sub-gate is not completion evidence.

- [ ] **Step 3: Decide status from evidence, never intent**

Promote only the exact tuples proven by the named gates. OE-F1 may become `reference_executable` only for FEM CPU/double/strict within its pair-budget and closed tetrahedral circuit scope. OE-F2 may become `reference_executable` or `production_executable` only if public execution plus cross-oracle, exact-sequence, topology-reject, airbox and artifact gates all pass. FEM GPU remains `semantic_only`/unsupported exactly as capability data states; no CPU result can promote it.

- [ ] **Step 4: Final independent review and commit**

Package the complete branch diff. Require no Critical/Important findings, clean `git diff --check`, valid JSON, docs link/lint success and no placeholder/status overclaim. Update the report checklist with every remaining limitation, then commit with message `docs(fem): publish Oersted implementation evidence`.

## Final exit criteria

- OE-T0 publishes one immutable RT0/H(div) field with complete source/mesh/topology/closure revision and digest identity plus independent balance evidence.
- OE-F1 integrates affine RT0 current over physical tetrahedra, including singular target/source pairs without cutoff, and matches analytic/refinement/sign/rotation gates.
- OE-F2 implements baseline `H_0(curl) x H^1_0`, not a zero-mean surrogate, rejects unsupported topology, and converges to OE-F1 across mesh/airbox sequences.
- OE-F1 and OE-F2 publish the same projected LLG field convention and exact energy/work-snapshot identity.
- Python, ProblemIR, planner, ABI, runner, artifact, API and UI preserve requested/resolved semantics and fail closed for unsupported GPU/single/zero-mean variants.
- All authoritative native proof comes from managed `just` recipes; capability rows describe only the evidence actually obtained.
