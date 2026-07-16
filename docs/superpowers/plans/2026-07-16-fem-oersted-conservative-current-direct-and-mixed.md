# FEM Oersted Conservative Current, Direct Oracle, and Mixed Solver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the CPU-double FEM Oersted chain OE-T0 -> OE-F1 -> OE-F2: one immutable conservative `RT0/H(div)` current view, a cutoff-free direct tetrahedral Biot--Savart oracle, and the exact-sequence `H_0(curl) x H^1_0` vector-potential solver.

**Architecture:** Current transport remains the sole owner of `J_charge` and publishes a revision/digest-pinned RT0 view. Two separate Oersted modules consume the same view: OE-F1 is a deterministic small-problem direct oracle; OE-F2 is a production-oriented MFEM mixed solver on conductor+closure+airbox whose status remains bounded by this plan's evidence. Rust plans/orchestrates and publishes artifacts, but all numerical ownership stays under `backends/fem`; existing cylinder/midpoint paths remain separate compatibility realizations.

**Tech Stack:** C++17, MFEM Nedelec/RT/H1 spaces, hypre AMS/BoomerAMG, C ABI, Rust FFI/ProblemIR/planner/runner/API, Python DSL, React Control Room, container-backed repository `just` recipes.

## Global Constraints

- Canonical physics is `docs/physics/0980-dynamic-current-and-oersted-coupling.md`; changing an equation, sign, unit, gauge, BC, quadrature, or projection requires a new version identifier and publication review first.
- Implement CPU-double only. Do not add, alter, compile, or claim CUDA/GPU OE-T0/OE-F1/OE-F2 execution in this plan.
- `J_c` is signed conventional current density in `A/m^2`; `H_oe` is `A/m`; `B_oe=mu0 H_oe` is `T`; `A` is `T m`; `p` is `A/m`.
- Neither Oersted solver may consume the nodal visualization `J_charge` buffer or recompute `-sigma grad V`.
- Baseline OE-F2 is exactly `A in H_0(curl)` and `p in H^1_0`; no scalar pin or zero-mean substitute is legal.
- The zero-mean `H1/R` formulation is a separate boundary variant and remains fail-closed unless its own tests and capability scope are implemented.
- FEM v1 OE-F2 accepts only a volumetrically meshed `closed_geometry` or `external_lead_extension` closed by `fem_closed_current_extension.v1`; `analytic_return_path` is an OE-F1-only additive field and is rejected for OE-F2.
- Nontrivial discrete cohomology is rejected until a versioned harmonic basis/constraint implementation exists.
- Existing legacy cylinder/midpoint rows do not prove canonical OE-F1/OE-F2 capability. Status remains `semantic_only` until every named promotion gate passes.
- Native build/runtime proof uses repository-owned managed CPU-only `just` recipes linked to a prebuilt CPU MFEM/hypre runtime. The recipes must contain no GPU feature, CUDA configure, GPU image/profile, or GPU runtime dependency. Host `cargo`, `cmake`, direct binaries, and raw Docker are not acceptance evidence.
- This implementation plan can promote OE-F1/OE-F2 at most to `reference_executable`. Production status requires the separate scaling/envelope gate in Task 8.
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
| `backends/fem/cpu/mfem/transport/conservative_constraint_rank.hpp/.cpp` | backend-owned deterministic exact-integer incidence rank analysis, typed inconsistency rejection and rank certificate |
| `backends/fem/cpu/mfem/transport/conservative_current_view.hpp/.cpp` | OE-T0 RT0 construction, immutable metadata, balance certificate and digest inputs |
| `backends/fem/cpu/mfem/transport/steady_transport.hpp/.cpp` | publish RT0 view alongside existing visualization fields without transferring ownership |
| `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp/.cpp` | OE-F1 singular/near/far tetrahedral integration and deterministic accumulation |
| `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp/.cpp` | OE-F2 exact-sequence spaces, block forms, BC, topology gate, solve and projection |
| `backends/fem/cpu/mfem/interactions/oersted/oersted_c_api.hpp/.cpp` | bounded C ABI validation/copy adapter only; no quadrature or mixed assembly |
| `backends/fem/cpu/mfem/interactions/oersted.hpp/.cpp` | typed realization dispatch only; no numerical kernels |
| `native/include/fullmag_fem.h` | new self-describing Oersted ABI family and immutable current-view descriptor |
| `crates/fullmag-fem-sys/src/lib.rs` | exact C ABI mirror and layout assertions |
| `crates/fullmag-authoring/src/spin_transport.rs`, `validation.rs`, `adapters.rs`, and `builder.rs` | canonical scene schemas, validation, API adapters and scene construction |
| `crates/fullmag-ir/src/study.rs`, `spin_transport.rs`, and `plan.rs` | ProblemIR and resolved source/gauge/quadrature identity |
| `crates/fullmag-plan/src/oersted.rs` | legality, source/closure/topology binding and fail-closed capability resolution |
| `crates/fullmag-runner/src/native_fem/oersted.rs` | ABI orchestration only |
| `crates/fullmag-runner/src/artifacts.rs` | RT0 manifest/data and Oersted field/diagnostic/provenance artifacts |
| `crates/fullmag-api/src/quantity_data_plane.rs` | revisioned `H_oe`/work-snapshot projection through the existing data plane |
| `crates/fullmag-api/src/schemas/authoring.rs`, `router_v2/handlers/model/authoring.rs`, and `openapi_v2.rs` | resource-first authoring schemas/routes/OpenAPI |
| `packages/fullmag-py/src/fullmag/model/current_transport.py`, `energy.py`, `problem.py`, `runtime/scene_document.py`, `runtime/script_builder.py`, and `world.py` | canonical tagged policies and exact four-path script/scene round-trip |
| `apps/control-room/src/kernel/api/generated/*`, `ControlRoomApi.ts`, and `kernel/resources/spinAuthoringResources.ts` | generated transport, typed facade and resource hooks |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.ts` and `SpinAuthoringInspector.tsx` | current-view/Oersted authoring, capability and inspector projection through typed API |
| `backends/fem/tests/*oersted*` | native independent physics and numerical contracts |
| `justfile` | managed CPU-only steady-transport, time-domain, OE-T0 standard, OE-T0 TSan, OE-F1 and OE-F2 verification recipes plus configuration audit |

---

### Task 0: Prerequisite managed CPU-only verification lane

This task is a hard prerequisite for Tasks 1--7. Existing native steady-
transport and time-domain recipes are not admissible because they select a
GPU-backed build/profile. Do not invoke them anywhere in this plan.

**Files:**
- Modify: `justfile`
- Modify: the managed FEM CPU container/build configuration selected by `justfile`
- Test: the recipe configuration audit added beside the managed FEM recipes

- [ ] Add `verify-fem-steady-transport-cpu-only-contract` and
  `verify-fem-time-domain-cpu-only-contract`, plus the OE-T0/OE-F1/OE-F2 CPU
  recipes named below. Every recipe must create or select a managed runtime whose
  configure evidence records `CUDA=OFF` and `FEM_GPU=OFF`, links only the
  prebuilt CPU MFEM/hypre library, enables no Rust GPU feature, and selects no
  GPU image, compose profile or device runtime.
- [ ] Make each recipe fail before build if its CMake cache, Rust feature list,
  container image/profile or linked FEM library is not demonstrably CPU-only.
  Persist this configuration audit with the test result.
- [ ] Add this documentation guard to CI/review (the split regexes avoid
  matching the guard itself):

```bash
plan=docs/superpowers/plans/2026-07-16-fem-oersted-conservative-current-direct-and-mixed.md
if rg -n 'verify-fem-(steady-transport|time-domain)-native-contract|fem[-]gpu|(?i:gpu[-_ ]profile)' "$plan"; then
  exit 1
fi
```

- [ ] Run each new CPU-only recipe once and retain configure output proving the
  above invariants. At Task 0, steady-transport and time-domain must pass;
  OE-T0, OE-F1 and OE-F2 must pass the repository/runtime audits and configure,
  then fail RED on their still-missing milestone-specific target. Passing one
  of those three by running a legacy Oersted target is a contract failure. No
  later task may substitute a legacy/native recipe whose transitive build
  configuration is accelerator-backed.

### Task 1: OE-T0 conservative RT0 current-view contract

**Files:**
- Create: `backends/fem/cpu/mfem/transport/conservative_constraint_rank.hpp`
- Create: `backends/fem/cpu/mfem/transport/conservative_constraint_rank.cpp`
- Create: `backends/fem/cpu/mfem/transport/periodic_charge_potential.hpp`
- Create: `backends/fem/cpu/mfem/transport/periodic_charge_potential.cpp`
- Create: `backends/fem/cpu/mfem/transport/conservative_current_view.hpp`
- Create: `backends/fem/cpu/mfem/transport/conservative_current_view.cpp`
- Create: `backends/fem/tests/conservative_current_view_contract.cpp`
- Modify: `backends/fem/cpu/mfem/transport/steady_transport.hpp`
- Modify: `backends/fem/cpu/mfem/transport/steady_transport.cpp`
- Modify: `backends/fem/CMakeLists.txt`

**Interfaces:**
- Consumes: the converged M1 charge potential, conductivity coefficient,
  straight affine tetrahedral mesh, explicit stable `u64` vertex identities,
  classified boundary faces, terminal/source-cut constraints, globally
  completed closure support, source/mesh/topology revisions and digests,
  envelope revision/digest, evaluated envelope multiplier, evaluation time and
  stage identity. `closed_geometry` requires an explicit
  `periodic_potential_drop` from the same current module or certified imported
  closed RT0 field; the closure object alone cannot author a drive.
  `external_lead_extension` participates in the coupled solve.
- Produces:

```cpp
struct ConservativeCurrentBalanceCertificate {
    double max_element_divergence_a;
    double max_internal_face_jump_a;
    double net_outer_flux_a;
    double electrode_balance_relative;
    double max_closure_interface_mismatch_a;
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
    std::string face_record_payload_sha256;
    std::string canonical_face_digest;
    std::string balance_certificate_digest;
    std::string view_identity_digest;
    std::string envelope_revision;
    std::string envelope_digest;
    double evaluated_envelope_multiplier;
    double evaluation_time_s;
    uint64_t stage_identity;
};

enum class ConservativeConstraintRankRowKind : uint8_t {
    Generic = 1,
    ClosedComponentDivergence = 2,
};
enum class ConstraintOmissionReason : uint8_t {
    ClosedComponentDivergenceDependency = 1,
    ConsistentLinearDependency = 2,
};
struct ConservativeConstraintRankRow {
    std::string constraint_id;
    ConservativeConstraintRankRowKind kind;
    std::array<uint64_t, 4> closed_component_anchor_element;
    std::array<uint64_t, 4> row_element_key;
    std::vector<uint64_t> canonical_column_ids;
    std::vector<int64_t> incidence_coefficients;
    double rhs_a;
};
struct ConstraintRankOmittedRow {
    std::string constraint_id;
    ConstraintOmissionReason reason;
    double residual_a;
    std::array<uint64_t, 4> closed_component_anchor_element;
};
struct ConstraintRankCertificate {
    uint64_t rows_before;
    uint64_t rank;
    std::vector<ConstraintRankOmittedRow> omitted_rows;
};
class InconsistentDependentConstraint : public std::runtime_error {
public:
    const std::string &constraint_id() const noexcept;
    double residual_a() const noexcept;
};
class ConstraintRankResourceLimitExceeded : public std::runtime_error {};
struct ResourceCounts {
    uint64_t rows;
    uint64_t distinct_columns;
    uint64_t total_nonzeros;
    uint64_t maximum_nonzeros_per_row;
    uint64_t maximum_intermediate_nonzeros;
    uint64_t intermediate_storage_bits;
    uint64_t bareiss_work_units;
    uint64_t maximum_intermediate_bit_length;
};
class ConservativeConstraintRank {
public:
    static constexpr std::size_t kMaximumRows = 1u << 20;
    static constexpr std::size_t kMaximumDistinctColumns = 1u << 20;
    static constexpr std::size_t kMaximumNonzeros = 1u << 24;
    static constexpr std::size_t kMaximumColumnsPerRow = 4096;
    static constexpr uint64_t kMaximumIntermediateNonzeros = uint64_t{1} << 24;
    static constexpr uint64_t kMaximumIntermediateStorageBits = uint64_t{1} << 31;
    static constexpr uint64_t kMaximumBareissWorkUnits = uint64_t{1} << 32;
    static constexpr uint64_t kMaximumIntermediateBitLength = uint64_t{1} << 20;
    static void ValidateResourceCounts(const ResourceCounts &counts);
    static ConstraintRankCertificate Analyze(
        const std::vector<ConservativeConstraintRankRow> &rows,
        double physical_absolute_gate_a = 1e-18,
        double physical_relative_gate = 1e-10);
};

class ConservativeCurrentView {
public:
    using Ptr = std::shared_ptr<const ConservativeCurrentView>;
    static constexpr const char *operator_version =
        "fem_conservative_current_rt0_view.v1";
    static Ptr Build(const ConservativeCurrentBuildRequest &request);
    static Ptr Import(const ConservativeCurrentImportRequest &request);
    const mfem::FiniteElementSpace &space() const;
    const mfem::GridFunction &field() const;
    const ConservativeCurrentIdentity &identity() const;
    const ConservativeCurrentBalanceCertificate &balance() const;
    const ConstraintRankCertificate &constraint_rank_certificate() const;
    const std::vector<CanonicalFaceFluxRecord> &
        canonical_face_flux_records() const;
    const std::vector<uint8_t> &
        canonical_balance_certificate_bytes() const;
    bool canonical_face_flux_records_are_global_and_broadcast() const;
private:
    ConservativeCurrentView();
};
```

The concrete class uses pImpl and owns immutable deep copies of the mesh
snapshot, RT collection, finite-element space, grid function, globally sorted
and rank-broadcast canonical records, metadata and complete certificate bytes.
Construction is private and the static factories are the only creation path.
`Build` and `Import` must route every `[B;C]` row through the backend-owned
`ConservativeConstraintRank`; neither may run an implementation-local floating
rank heuristic. Column IDs are strictly increasing canonical stable IDs,
coefficients are exact signed integers and constraint IDs are nonempty/unique.
Generic rows carry zero anchor and row-key sentinels. Closed-component
divergence rows carry four strictly increasing nonzero IDs in both fields with
`anchor<=row_element_key`; row keys are unique within a component and exactly
one equals the component anchor. Reject missing/duplicate candidates,
duplicate row metadata and unknown kind codes. The analyzer derives omission
reason/anchor only from these fields, never ID parsing/postprocessing. Process
all generic and closed non-candidates before unique anchor candidates, with ID
tie-breaking inside each class, so the exact anchor row is omitted even when
its ID sorts first. Physical B assembly must populate both keys. Enum wire
values are frozen and asserted.
Canonical-ID processing of `r1=[1,0], r2=[0,1], r3=[1,1]` with RHS `(1,1,2)`
must retain r1/r2 and omit/certify exactly r3; RHS `(1,1,3)` throws typed
`InconsistentDependentConstraint` for r3. Persist `rows_before`, `rank`, sorted
omitted IDs, reason, residual and the stable closed-component anchor.
Implement coefficient rank with fraction-free Bareiss over
`boost::multiprecision::cpp_int`; fixed-width/floating rank decisions are
forbidden. Check before allocation: rows `<=2^20`, distinct columns `<=2^20`,
total nonzeros `<=2^24`, and row nonzeros `<=4096`. Add a negative table for
empty/duplicate IDs, unsorted/duplicate columns, length mismatch, stored zero
coefficients, nonfinite RHS and cap overflow. Test RHS dependence with the
frozen current absolute/relative physical gate and persist the ampere residual.
Implement public/internal `ResourceCounts` plus mandatory
`ValidateResourceCounts`; `Analyze` uses it with checked counters and throws
typed `ConstraintRankResourceLimitExceeded`. Bound legal pathological
fill/storage/work at `2^24` intermediate nonzeros, `2^31` aggregate
intermediate storage bits, `2^32` Bareiss work units and `2^20` bits per
intermediate. Test every limit and
limit+1 without allocating huge fixtures. Add the exact witness
`M=4,000,000,000`, `C=-2,446,744,073,709,551,616`, rows `[M,1]`,
`[C,M]`, and their sum; prove with `cpp_int` that `M*M-C=2^64`, rank is two
and the sum row is omitted. Add separate represented-residual cases inside/outside both
absolute and relative branches of
`abs(residual)<=max(abs_gate,rel_gate*max(abs(rhs),1e-30))`.
The transport owner stores only `ConservativeCurrentView::Ptr`; readers use
`std::atomic_load` and the owner atomically replaces it after full acceptance.
Freeze the owner name and surface as
`ConservativeCurrentViewOwner(mfem::GridFunction &nodal_visualization)` plus
`ConservativeCurrentViewOwner::{conservative_charge_current(),
charge_current_density(),publish_accepted(Ptr)}`. The first method atomically
loads the accepted RT0 pointer; the second returns separate nodal visualization
storage. Failed Build, Import or publication retains the previous accepted
pointer and the two fields must never alias. The nodal argument is a non-owning
borrow: its mesh, space and `GridFunction` outlive the owner. Delete all owner
copy/move construction and assignment. Add a four-reader/one-writer stress test
that alternates two accepted pointers and proves readers see only either whole
pointer; the rejected-build path must leave the previous pointer unchanged.
Document and run a dedicated ThreadSanitizer qualification build with
`-fsanitize=thread -fno-omit-frame-pointer`; any race report is failure.

- [ ] **Step 1: Write failing native tests for orientation, conservation, identity, and immutability**

Create fixtures for two tetrahedra sharing a face, a layered-conductivity series
conductor, a volumetrically meshed closed loop with explicit source cut and a
device with volumetric external leads. Assert exact cancellation of the
globally oriented shared-face flux, element integrated divergence below
`1e-12 A`, closure balance below `1e-12`, and correct uniform/series current.
Each source/mesh/closure revision mutation must change `view_identity_digest`
and cache identity; `canonical_face_digest` must remain unchanged when geometry
and physical record bytes are unchanged, and must change when either changes. Add
rejection cases for NaN/Inf, an unpaired terminal, incomplete lead join, stale
source revision, duplicate or inconsistent stable IDs, non-tetrahedral or
curved input, degenerate faces, singular constraints and mutation of the source
after view construction. Repeat an exactly imported RT0 fixture with reversed
element order, permuted local face/RT DOF order and different MFEM numbering.
Run a real `mpiexec -n 1`/`-n 2` ParMesh fixture; the canonical records and
digest must be byte-identical.

The closed-loop source-cut fixture is authored through
`periodic_potential_drop`. It first proves the periodic H1 potential jump and
paired weak flux, then exercises RT reconstruction; it must fail if only
`closed_geometry` is provided without a current-module drive.
For `sigma=4 S/m` on the unit cube, independently check every P1 node and
quadrature value against `V=0.5-x V`, every physical gradient against
`(-1,0,0) V/m`, and each signed cut-face flux against
`sigma grad(V).n`. Independently assemble
`integral sigma grad(V).grad(phi_i) dV`, combine the two cut-side entries of
each periodic quotient test function, and require every combined/interior
residual below `1e-12 A`. Do not use a snapshot residual getter as this oracle.

Add a positive Import integration fixture made from two disconnected periodic
unit cubes, with the second translated in y, disjoint stable face identities,
unique cut IDs and uniform `J=(4,0,0) A/m^2`. A test-side exact integer
oracle must materialize canonical free RT0 face columns after insulating-outer
elimination, signed element/outward-face B rows and exact authored source-cut
pair C rows. Run `cpp_int` Bareiss on the actual `D=[B;C]`; prove B-only full
row rank, D nullity two, and full row rank after removing exactly the minimum
stable-anchor divergence row per component. The accepted
`ConstraintRankCertificate` has `rows_before-rank=2` and exactly two omitted
divergence rows, one for each lexicographically minimal stable component anchor,
both with `ClosedComponentDivergenceDependency` and residual `<=1e-12 A`.
The balance decoder consumes this variable omitted set; it never hardcodes one.
A duplicated physical source cut is a separate multiple-pairing rejection and
must not be presented as the rank-revealing oracle.

```cpp
require(view->identity().operator_version ==
        "fem_conservative_current_rt0_view.v1", "wrong operator version");
require(view->balance().max_internal_face_jump_a <= 1.0e-12,
        "RT0 normal trace is not single-valued");
require(view->balance().max_element_divergence_a <= 1.0e-12,
        "RT0 element current is not conservative");
require(view->balance().closure_complete, "current closure is incomplete");
```

- [ ] **Step 2: Run the managed test and confirm RED**

Add `fem_conservative_current_view_contract` to CMake, then run:

```bash
just verify-fem-oersted-oet0-cpu-contract
just verify-fem-oersted-oet0-tsan-cpu-contract
```

Expected before production: both managed containers configure successfully and
fail because the new rank/current target API is not implemented; neither may
fall through to an existing nodal-current test. The TSan recipe uses scenario
`oersted-oet0-tsan`, its own build directory, CMake
`FULLMAG_OET0_TSAN=ON`, compile/link flags
`-fsanitize=thread -fno-omit-frame-pointer`, only the serial contract CTest,
no MPI launcher, and `TSAN_OPTIONS=halt_on_error=1:exitcode=66`. In this mode
skip the MFEM MPI probe, explicit MPI link and MPI CTests; define
`FULLMAG_OET0_DISABLE_MPI=1` and guard MPI code/CLI with
`MFEM_USE_MPI && !FULLMAG_OET0_DISABLE_MPI`. A transitive MPI dependency of the
shared MFEM library is allowed but does not authorize Fullmag MPI code/tests.
Conditionally add `conservative_constraint_rank.cpp`,
`periodic_charge_potential.cpp` and `conservative_current_view.cpp` directly to
the instrumented test target: none means RED, partial existence is CMake FATAL,
all three means target sources. Audit their object list/flags after GREEN and
never source them from unsanitized `fullmag_fem`.
The pre-build message says only that generated compile/link instrumentation
rules passed audit; it must not claim that any translation unit already
compiled or linked. Actual compile/link and runtime success are reported only
after the target build and serial CTest complete.
After GREEN, `just verify-fem-oersted-oet0-cpu-contract` must run the serial
contract, real `mpiexec -n 1`, real `mpiexec -n 2`, and the byte-identity
comparison; directly invoking only the serial executable is not standard-lane
qualification. `just verify-fem-oersted-oet0-tsan-cpu-contract` remains
strictly serial-only after GREEN and runs only the instrumented owner contract;
it must never register or launch the MPI tests.

- [ ] **Step 3: Implement conservative RT0 reconstruction**

Implement `periodic_charge_potential.hpp/.cpp` as part of Task 1, then add
`fem_charge_h1_periodic_jump.v1` to the current-transport owner. Build
the paired periodic H1 quotient space from the resolved stable face pairing,
apply an affine lift whose plus/minus trace jump equals the authored `drop_V`,
remove the remaining constant gauge explicitly, solve the charge equation and
independently certify the paired weak flux. The RT stage consumes this accepted
potential; its `Cj=d` equations do not impose voltage. A failed periodic solve
publishes neither potential nor conservative current.
The periodic request and immutable snapshot carry exact source module,
source-state and source-field identities, evaluation time, stage identity,
envelope revision/digest and evaluated multiplier. RT reconstruction rejects
any source/time/envelope mismatch.

Use `RT_FECollection(0,3)` and a discontinuous elementwise constant multiplier.
Assemble the KKT system `[M B^T C^T; B 0 0; C 0 0]`, where `M` is weighted by
`sigma^{-1}`, `B` is the RT0--L2 divergence operator and `C` contains terminal
current sums, paired source-cut equations and closure-interface flux
constraints. Eliminate zero insulating normal-flux and other pointwise
prescribed RT traces as essential DOFs first. Minimize the weighted difference
from `-sigma grad V` subject to `Bj=q` and `Cj=d`. Apply a deterministic
rank-revealing analysis to `[B;C]`; remove exactly one dependent divergence row
per closed connected component when appropriate and remove any other redundant
constraint explicitly rather than accepting a singular system. Independently
validate every omitted balance. Do not use `GridFunction::ProjectCoefficient`
as proof of conservation. Construct a new immutable view only after both
algebraic convergence and the independent integrated balance pass.

The balance calculator must independently integrate the physical Piola-mapped
field by quadrature: outward flux per element and outer/electrode/source-cut
boundary, shared-face trace jump and every closure-interface pair. It must not
reuse a KKT residual. Apply the v1 absolute/relative floors from the runtime
contract and retain complete diagnostics.

The certificate test decodes the whole binary for both Build and positive
Import. It constructs the exact
`boundary_element -> stable face key -> (role,circuit_id)` map, requires every
circuit key to be a one-sided physical boundary, compares source-cut and
external-lead rows to the exact authored ordered pairs, and compares terminal
and outer rows as complete key sets. Any internal-face substitution fails.
Every family count passes a pre-allocation `<=2^31-1` guard and every LP string
passes a `<=4096` byte, shortest-form UTF-8/no-NUL validator. Direct negative
fixtures cover excessive count/length and invalid UTF-8.

Build
`fem_rt0_canonical_face_digest.v1` records from a canonical global face
identity: sort stable mesh-vertex identities, derive the canonical normal from
the coordinates in that ID order, reject ID/coordinate disagreement, convert
every local RT sign, normalize negative zero, globally sort
`(face_key,flux_A)`. Define `LP(x)=u64le(byte_length(x)) || UTF8(x)` and freeze
the sole composite preimage as
`SHA256(LP("fem_rt0_canonical_face_digest.v1") ||
LP("fem_conservative_current_rt0_view.v1") ||
LP("stable_vertex_lexicographic_normal.v1") || LP(geometry_digest) ||
u64le(record_count) || decode_hex_32(face_record_payload_sha256))`.
The physical record bytes participate only through the nested raw-payload
hash. Never hash pointer values, MFEM true-dof numbers, element order or
partition-local ordering.

`closed_geometry` either imports an already certified closed volumetric RT0
field or reconstructs one from the same current module's authored
`periodic_potential_drop`; it does not define a source by itself;
a single-valued electrostatic potential alone cannot drive a nonzero closed
loop. `external_lead_extension` tetrahedralizes the authored leads and includes
them in the same coupled minimum-dissipation solve so lead impedance feeds back
on the device; prove equal/opposite flux on every join face. Reject
`analytic_return_path` and never fake closure by setting terminal flux to zero.
The positive reference uses disjoint volumes: left lead `[-1,0]`, device
`[0,1]`, right lead `[1,2]`, true joins at `x=0,1`, lead conductivity different
from device conductivity and an outer-electrode voltage drive. It must match
`I=Delta V/sum_i(L_i/(sigma_i A))`; changing lead conductivity must change the
device current and prove impedance feedback in one coupled solve.
Place device and lead stable IDs in disjoint namespaces even where join
coordinates coincide. Preserve the two one-sided canonical interface keys;
combine mesh vertices in device-then-lead order and concatenate the authored
ID vectors in the same order. Coordinate-based ID recomputation or join-face
identity collapse is a contract failure.

Represent a resolved v1 source cut as two bijectively paired sets of stable
triangular face keys, a declared minus-to-plus transform/orientation and the
authored `potential_jump [V]`. Periodic H1 reconstruction uses an affine lift
or equivalent duplicated traces with `V_plus-V_minus=drop_V`; RT reconstruction
requires equal/opposite paired flux. Reject unmatched faces, multiple pairing,
geometry/orientation mismatch and any independently invented cut excitation.

For the v1 reference executable, gather the canonical affine mesh,
coefficients and constraints, reconstruct in deterministic canonical order on
rank zero, and broadcast the records/accepted field. This deliberately favors
byte-identical MPI qualification over scalability. A distributed solver needs
a separately versioned deterministic reduction or quantization contract.

- [ ] **Step 4: Preserve visualization compatibility without semantic aliasing**

Keep `charge_current_density()` as the current nodal visualization quantity. Add `conservative_charge_current()` returning the typed view and state in comments/tests that the two buffers have different contracts. Spin transport may keep its existing coefficient evaluation in this milestone; only OE-F1/OE-F2 are allowed to require the RT0 view.

- [ ] **Step 5: Run focused and steady-transport managed gates**

```bash
just verify-fem-oersted-oet0-cpu-contract
just verify-fem-oersted-oet0-tsan-cpu-contract
just verify-fem-steady-transport-cpu-only-contract
```

Expected: standard serial/MPI/byte identity and serial TSan owner stress all
pass; existing M1 steady-transport ABI/physics gates remain green.

- [ ] **Step 6: Review checkpoint OE-T0**

Independent physics review must verify Piola/orientation/sign/SI and that every permitted closure has zero unpaired outer flux. Independent architecture review must verify no new current state in generic `Context`, `mfem_bridge.cpp`, runner dispatch, or an Oersted module. Resolve every Critical/Important finding before committing.

- [ ] **Step 7: Commit OE-T0**

```bash
git add backends/fem/cpu/mfem/transport/conservative_constraint_rank.hpp \
  backends/fem/cpu/mfem/transport/conservative_constraint_rank.cpp \
  backends/fem/cpu/mfem/transport/periodic_charge_potential.hpp \
  backends/fem/cpu/mfem/transport/periodic_charge_potential.cpp \
  backends/fem/cpu/mfem/transport/conservative_current_view.hpp \
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
- Create: `backends/fem/cpu/mfem/interactions/oersted/oersted_c_api.hpp`
- Create: `backends/fem/cpu/mfem/interactions/oersted/oersted_c_api.cpp`
- Create: `backends/fem/tests/oersted_abi_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem/steady_transport.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Test: `backends/fem/tests/steady_transport_abi_contract.cpp`
- Test: `crates/fullmag-fem-sys/src/lib.rs`
- Test: `crates/fullmag-runner/src/lib/tests.rs`

**Interfaces:**
- Consumes internally: `ConservativeCurrentView` from Task 1.
- Native-to-Rust export: a new combined conservative-transport solve/export
  entry point writes caller-allocated output buffers during the call; it never
  returns a native or MFEM pointer.
- Rust-to-native import: OE-F1/OE-F2 receive a separate const input descriptor;
  `oersted_c_api.cpp` validates and deep-copies it before the solver retains it.
- Produces: `fullmag.fem.conservative_current_view.v1` input/output descriptor
  family, canonical RT0 binary member, JSON manifest and runner-side
  `ConservativeCurrentViewRef`.

- [ ] **Step 1: Write failing append-only ABI and artifact tests**

Define a new ABI family rather than changing the size of
`fullmag_fem_steady_transport_result_v1`. The export function takes the existing
steady request/result plus a conservative-current build request and a mutable
output descriptor; the import descriptor is a separate const type. Test the
exact prefix `(abi_version, struct_version, struct_size)`, every
pointer+capacity/written-length and pointer+length null/zero/mismatch
combination, arithmetic overflow before allocation/copy, finite fluxes, stable
face keys, digest verification, bounded byte tags, and round-trip of every
revision. Runner tests must tamper independently with face records,
`source_module_id`, SI/component/FE tags, every balance-certificate field,
source revision, closure digest and mesh revision and observe fail-closed
loading. An import lifetime test destroys/reuses caller buffers after the call
and proves retained native state owns a deep copy.
Add explicit short-buffer tests proving that all required lengths plus only the
accepted-generation token are published, payloads/written lengths/other scalars
remain untouched, retry with that token performs no second solve, and another
token returns stale-result. Test byte-buffer lengths as bytes and typed-buffer
lengths as elements, including multiplication overflow. Import must reject any
mismatch between the summary struct and independently decoded canonical
certificate bytes; export must derive the summary struct from those same bytes.

- [ ] **Step 2: Implement self-describing descriptor and Rust mirror**

```c
typedef struct fullmag_fem_bytes_view_v1 {
    const uint8_t *data;
    uint64_t len;
} fullmag_fem_bytes_view_v1;

typedef struct fullmag_fem_current_balance_certificate_v1 {
    double max_element_divergence_a;
    double max_internal_face_jump_a;
    double net_outer_flux_a;
    double electrode_balance_relative;
    uint32_t closure_complete;
    uint32_t reserved_zero;
} fullmag_fem_current_balance_certificate_v1;

typedef struct fullmag_fem_conservative_current_view_input_v1 {
    uint32_t abi_version;
    uint32_t struct_version;
    uint64_t struct_size;
    const uint64_t *canonical_face_vertex_ids;
    uint64_t canonical_face_vertex_ids_len;
    const double *canonical_face_flux_a;
    uint64_t canonical_face_flux_count;
    fullmag_fem_bytes_view_v1 schema_id;
    fullmag_fem_bytes_view_v1 operator_version;
    fullmag_fem_bytes_view_v1 source_module_id;
    fullmag_fem_bytes_view_v1 source_state_revision;
    fullmag_fem_bytes_view_v1 source_field_digest;
    fullmag_fem_bytes_view_v1 mesh_revision;
    fullmag_fem_bytes_view_v1 topology_revision;
    fullmag_fem_bytes_view_v1 geometry_digest;
    fullmag_fem_bytes_view_v1 closure_revision;
    fullmag_fem_bytes_view_v1 closure_digest;
    fullmag_fem_bytes_view_v1 face_record_payload_sha256;
    fullmag_fem_bytes_view_v1 canonical_face_digest;
    fullmag_fem_bytes_view_v1 balance_certificate_digest;
    fullmag_fem_bytes_view_v1 view_identity_digest;
    fullmag_fem_bytes_view_v1 envelope_revision;
    fullmag_fem_bytes_view_v1 envelope_digest;
    fullmag_fem_bytes_view_v1 si_unit;
    fullmag_fem_bytes_view_v1 component_convention;
    fullmag_fem_bytes_view_v1 fe_space;
    fullmag_fem_bytes_view_v1 balance_certificate_bytes;
    fullmag_fem_current_balance_certificate_v1 balance_certificate;
    double evaluated_envelope_multiplier;
    double evaluation_time_s;
    uint64_t stage_identity;
} fullmag_fem_conservative_current_view_input_v1;
```

Define the output ABI exactly as follows (the typed buffer structs differ only
in the `data` pointee type). Byte-buffer capacities/required/written lengths are
bytes; `u64` and `f64` buffer lengths are element counts. Every element-to-byte
conversion is checked for overflow before pointer validation/allocation/copy:

```c
typedef struct fullmag_fem_mut_bytes_buffer_v1 {
    uint8_t *data;
    uint64_t capacity;
    uint64_t required_len;
    uint64_t written_len;
} fullmag_fem_mut_bytes_buffer_v1;
typedef struct fullmag_fem_mut_u64_buffer_v1 {
    uint64_t *data;
    uint64_t capacity;
    uint64_t required_len;
    uint64_t written_len;
} fullmag_fem_mut_u64_buffer_v1;
typedef struct fullmag_fem_mut_f64_buffer_v1 {
    double *data;
    uint64_t capacity;
    uint64_t required_len;
    uint64_t written_len;
} fullmag_fem_mut_f64_buffer_v1;

typedef struct fullmag_fem_conservative_current_view_output_v1 {
    uint32_t abi_version;
    uint32_t struct_version;
    uint64_t struct_size;
    fullmag_fem_mut_u64_buffer_v1 canonical_face_vertex_ids;
    fullmag_fem_mut_f64_buffer_v1 canonical_face_flux_a;
    fullmag_fem_mut_bytes_buffer_v1 schema_id;
    fullmag_fem_mut_bytes_buffer_v1 operator_version;
    fullmag_fem_mut_bytes_buffer_v1 source_module_id;
    fullmag_fem_mut_bytes_buffer_v1 source_state_revision;
    fullmag_fem_mut_bytes_buffer_v1 source_field_digest;
    fullmag_fem_mut_bytes_buffer_v1 mesh_revision;
    fullmag_fem_mut_bytes_buffer_v1 topology_revision;
    fullmag_fem_mut_bytes_buffer_v1 geometry_digest;
    fullmag_fem_mut_bytes_buffer_v1 closure_revision;
    fullmag_fem_mut_bytes_buffer_v1 closure_digest;
    fullmag_fem_mut_bytes_buffer_v1 face_record_payload_sha256;
    fullmag_fem_mut_bytes_buffer_v1 canonical_face_digest;
    fullmag_fem_mut_bytes_buffer_v1 balance_certificate_digest;
    fullmag_fem_mut_bytes_buffer_v1 view_identity_digest;
    fullmag_fem_mut_bytes_buffer_v1 envelope_revision;
    fullmag_fem_mut_bytes_buffer_v1 envelope_digest;
    fullmag_fem_mut_bytes_buffer_v1 si_unit;
    fullmag_fem_mut_bytes_buffer_v1 component_convention;
    fullmag_fem_mut_bytes_buffer_v1 fe_space;
    fullmag_fem_mut_bytes_buffer_v1 balance_certificate_bytes;
    fullmag_fem_current_balance_certificate_v1 balance_certificate;
    double evaluated_envelope_multiplier;
    double evaluation_time_s;
    uint64_t stage_identity;
    uint64_t canonical_face_record_count;
    uint64_t accepted_generation;
    uint64_t reserved_zero[4];
} fullmag_fem_conservative_current_view_output_v1;
```

The input descriptor's `balance_certificate_bytes` must decode as exactly
`fem_conservative_current_balance_certificate.v1` and hash to
`balance_certificate_digest`; the output buffer receives those same canonical
bytes. Define
`fullmag_fem_solve_steady_transport_conservative_v1(steady_request,
current_build_request, retry_accepted_generation, steady_result,
current_output)` for native-to-Rust
export. Define OE solver entry points to accept only the const input descriptor
above for Rust-to-native import. Mirror all layouts exactly in Rust and add
compile-time size/offset assertions. Every byte view is bounded and need not be
NUL-terminated; embedded NUL and invalid UTF-8 are rejected for semantic
tags/IDs. `canonical_face_vertex_ids_len` must equal three times
`canonical_face_flux_count`. Import buffers are caller-owned and valid only for
the dynamic extent of the call; `oersted_c_api.cpp` validates everything,
checks multiplication/addition overflow, and deep-copies accepted records,
tags and complete certificate bytes before returning. Export computes all
required lengths first. On `FULLMAG_FEM_BUFFER_TOO_SMALL` it atomically writes
every `required_len`, sets every `written_len=0`, writes zero payload bytes and
publishes `accepted_generation` as the only result scalar. Every other scalar
and the steady result stays untouched. Zero retry token permits a new solve;
nonzero token permits only export of that exact retained snapshot without
re-solving. Another/stale token fails. Only an
all-capacities-sufficient call atomically commits payloads, written lengths and
result scalars. Never return an MFEM object pointer across the ABI.

- [ ] **Step 3: Implement and test the explicit C++ C-ABI adapter owner**

Keep exported `extern "C"` entry points and descriptor validation/copying in `oersted_c_api.cpp`; it may call typed OE-T0/OE-F1/OE-F2 C++ owners but may not assemble forms or perform quadrature. Register the source and `oersted_abi_contract` target explicitly in `backends/fem/CMakeLists.txt`. The ABI test calls the C symbols, not C++ internals, and covers unknown version/size, reserved bits, every bounded-view failure, output capacity, deep-copy lifetime, error-message termination, and no partial result publication after failure.

- [ ] **Step 4: Persist canonical data-plane artifact**

Write `current_transport/<id>.rt0-face-flux.v1.bin`,
`current_transport/<id>.current-balance.v1.bin` and
`current_transport/<id>.conservative-view.json` atomically. Each face-flux binary record
is exactly 32 bytes in this order: three canonical face vertex identities as
unsigned 64-bit little-endian integers followed by `flux_A` as IEEE-754
binary64 little-endian. Records are lexicographically sorted by the three IDs;
there is no in-band header or padding. The manifest supplies schema, record
size/count, exact byte length, `face_record_payload_sha256`,
`canonical_face_digest`, `balance_certificate_digest` and
`view_identity_digest` plus operator/orientation versions,
SI/component/space tags, balance certificate, and the full identity tuple:
`source_module_id`, `source_state_revision`, `source_field_digest`,
`mesh_revision`, `topology_revision`, `geometry_digest`, `closure_revision`,
`closure_digest`, `envelope_revision`, `envelope_digest`,
`evaluated_envelope_multiplier`, `evaluation_time_s`, and `stage_identity`.
On restore, validate
the manifest, checked `count*32` length, record ordering, finite normalized
flux bytes and digest before allocating or exposing an Oersted request.

The balance binary follows the exact
`fem_conservative_current_balance_certificate.v1` layout in the runtime
contract: sorted stable element/face/circuit/omitted-constraint rows, gates and
recomputable summary. Immediately after the three gate f64 values it stores
`u64le rows_before,u64le rank`, then four family counts. Every omitted row is
`LP(id),u8 reason,4*u64le anchor,f64 residual_A`; reason 1 is a closed-component
dependency with nonzero stable tetrahedron anchor, reason 2 is a generic
consistent dependency with all-zero anchor sentinel. Its SHA-256 is
`balance_certificate_digest`, so `view_identity_digest` transitively binds all
rank bytes. All SHA-256
fields cross ABI/persistence as exactly 64 lowercase unprefixed hex characters;
nested hash preimages decode them to 32 raw bytes. Face `side_count` is exactly
`1|2`; two sides are ordered by the lexicographic stable adjacent-tetrahedron
key and one-sided `side2_flux_A` is `+0.0`. Circuit kinds are exactly `1..4`.
Source-cut/interface rows require two real keys; terminal/outer rows use the
reserved zero second-key and `paired_flux_A=+0.0`. All zero sentinels normalize
to positive zero. Counts are bounded by `2^31-1`, IDs by 4096 bytes, total
checked bytes by `2^63-1`; unknown enums, overflow, unsorted or duplicate rows
are rejected. Restore/import deep-copies certificate bytes and recomputes all
four digests before publication. Add tamper tests for every row family,
count/order, duplicates, normalized zero, uppercase/non-hex/length errors and
summary mismatch.

- [ ] **Step 5: Verify and review OE-T0 bridge**

```bash
just verify-fem-oersted-oet0-cpu-contract
just verify-fem-oersted-oet0-tsan-cpu-contract
```

The command is a managed CPU-only recipe and links the Rust ABI tests against
the prebuilt CPU-only FEM library; it neither configures CUDA nor enables an
accelerator feature. Review must confirm canonical face-flux record streams are
data-plane artifacts and JSON never embeds the heavy current field. OE-F1
remains intentionally RED until Task 3 adds its direct-tetra target.

- [ ] **Step 6: Commit OE-T0 bridge**

```bash
git add native/include/fullmag_fem.h crates/fullmag-fem-sys/src/lib.rs \
  backends/fem/cpu/mfem/interactions/oersted/oersted_c_api.hpp \
  backends/fem/cpu/mfem/interactions/oersted/oersted_c_api.cpp \
  backends/fem/tests/oersted_abi_contract.cpp backends/fem/CMakeLists.txt \
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

Cover projection quadrature points far from, near, inside, on a face of, and on an edge of a current tetrahedron. Verify refinement convergence against a high-depth independent run, no cutoff/self deletion, exact current-sign involution, rigid rotation covariance, deterministic bytes across two runs, and failure when the subdivision limit is reached. Add a regression in which nodal interpolation gives the wrong load but direct evaluation at target integration points matches an independently over-integrated `L2` load. Add closed straight-wire/cylinder workloads only with a controlled finite-return geometry; test an analytic return only as a separately accumulated OE-F1 field with its own error/identity.

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
just verify-fem-oersted-oef1-cpu-contract
```

Expected: OE-T0 remains green and the new OE-F1 target fails at the missing direct solver.

- [ ] **Step 3: Implement far/near/singular integration**

Evaluate the affine physical RT0 field at every quadrature point. Use embedded tetrahedral rules for separated pairs and compare componentwise estimates against `atol_Apm + rtol*max(|H_hi|,|H_lo|)`. Recursively subdivide near pairs in a deterministic child order. For a target on/in a tetrahedron, split it into positive-volume target-vertex sub-tetrahedra and apply a Duffy/Gauss--Jacobi rule; reject zero/negative Jacobians. Accumulate each component with Neumaier compensation in global element order.

- [ ] **Step 4: Implement shared projection and snapshot output**

For every target element and every point in the versioned projection rule, evaluate the direct source integral with the same singular/near/far estimator, multiply by the target basis, and accumulate the consistent load. Estimate projection-load error by repeating with the embedded higher target rule and reject an unconverged target element. Solve one consistent vector `L2` mass projection to the LLG nodal field space. Nodal sampling followed by interpolation into the load is forbidden. Return only that projected field as publishable `H_oe`. Compute external Zeeman energy without `1/2`; emit a nonvariational work snapshot instead when source identity includes magnetization dependence.

- [ ] **Step 5: Verify complexity guard and physics**

Reject requests above an explicit source-target pair budget before allocation. Run:

```bash
just verify-fem-oersted-oef1-cpu-contract
just verify-fem-time-domain-cpu-only-contract
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
- Modify: `crates/fullmag-authoring/src/spin_transport.rs`
- Modify: `crates/fullmag-authoring/src/validation.rs`
- Modify: `crates/fullmag-authoring/src/adapters.rs`
- Modify: `crates/fullmag-authoring/src/builder.rs`
- Create: `crates/fullmag-authoring/tests/spin_transport_oersted_roundtrip.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/current_transport.py`
- Modify: `packages/fullmag-py/src/fullmag/model/energy.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/resources/spinAuthoringResources.ts`
- Test: `crates/fullmag-plan/src/tests.rs`
- Test: `packages/fullmag-py/tests/test_current_transport.py`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`

**Interfaces:**
- Consumes: public `OerstedField(method="direct_biot_savart")`, a named current source and its conservative-view artifact.
- Produces: resolved CPU-double OE-F1 plan and revisioned field/diagnostic/work artifacts; capability remains `semantic_only` until the final promotion task.

- [ ] **Step 1: Write failing four-path serializer/planner tests**

Test the same exact closure and direct-policy fields through four independent routes: Python -> canonical scene, API payload -> canonical scene, UI edit -> API payload -> canonical scene, and canonical script export -> parse -> canonical scene. Assert lossless preservation of `current_source_id`, `closure.kind`, authored `geometry_ref`/`volume_mesh_intent`, `closure_operator_version`, additive analytic-return identity, method, quadrature profile, tolerances, pair budget, projection version and work semantics. Every authoring route must reject `current_view_ref`, artifact paths, record counts and digests as resolved/data-plane injection. Planner accepts only FEM/CPU/double/strict, globally closed tetrahedral source, complete OE-T0 ref, finite tolerances and pair budget. It rejects any GPU device, any single precision, missing closure, nodal-only current, stale digest, PBC, pair-budget excess and an attempt to reuse vector-potential Krylov parameters.

The Rust scene owner is `crates/fullmag-authoring`, not `ProblemIR`: add tagged schemas in `spin_transport.rs`, fail-closed rules in `validation.rs`, API conversion in `adapters.rs`, builder preservation in `builder.rs`, and focused round-trip tests. Python must propagate the same fields through `model/energy.py`, `model/problem.py`, `runtime/scene_document.py`, `runtime/script_builder.py`, and `world.py`. The API must expose them through `schemas/authoring.rs`, `router_v2/handlers/model/authoring.rs`, and `openapi_v2.rs`; regenerate the checked-in client before facade/resource tests.

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

Resolution looks up `current_source_id`, pins the executed source revision and
artifact revision, validates its canonical face-flux manifest, and only then
places `ConservativeCurrentViewRef` in the resolved plan. No authoring adapter
may synthesize, accept or round-trip that resolved reference.

The dedicated C++ adapter in `oersted_c_api.cpp` validates every bounded descriptor and deep-copies it into native owners before OE-F1 construction. Add C ABI request/result tamper tests for source identity, component/FE tags, certificate bytes, lengths and lifetime; a Rust layout test alone is insufficient.

- [ ] **Step 3: Publish exact OE-F1 artifacts**

Persist projected `H_oe`, quadrature diagnostics, consumed current-view digest, operator/realization/engine IDs, observation/projection identity and work snapshot atomically. The field-store/API uses the artifact revision and ETag; it must not expose tentative or rejected-stage results.

- [ ] **Step 4: Verify, review, and commit OE-F1 integration**

```bash
just verify-fem-oersted-oef1-cpu-contract
cargo test -p fullmag-authoring spin_transport_oersted_roundtrip
cargo test -p fullmag-plan oersted
python -m unittest packages/fullmag-py/tests/test_current_transport.py
pnpm --dir apps/control-room test -- ControlRoomApi.test.ts
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
- Produces: `A`, `p`, projected `H_oe`, discrete block/constraint/weak-Ampere/compatible-divergence diagnostics, airbox identity and work snapshot.

- [ ] **Step 1: Write failing exact-sequence and manufactured-solution tests**

Build compatible `ND_FECollection(1,3)`, `H1_FECollection(1,3)` and RT0 source fixtures. Verify `grad(H1_0)` maps into the essential ND space, the discrete `curl*grad` norm is below `1e-13`, every scalar boundary true dof is essential in the baseline, no mean constraint/pin exists, and the block matrix has the specified `C/B/B^T/0` structure. Add manufactured `A`, signed-current, source-digest, current-range, first-block/constraint/weak-Ampere/compatible-divergence, projection and three-airbox fixtures.

Add fail-closed tests for nontrivial topology without harmonic constraints, current support outside airbox, mismatched source mesh, PBC, `mu_r != 1`, and selecting `natural_curl_zero_mean_h1.v1` before that separate variant exists.

- [ ] **Step 2: Run managed gate and confirm RED**

```bash
just verify-fem-oersted-oef2-cpu-contract
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

Use block GMRES with AMS on the ND block and BoomerAMG on the Dirichlet H1 block. Defaults are restart `100`, maximum iterations `2000`, algebraic rtol `1e-10`. Independently assemble `r_A=C a+B p-f` and `r_p=B^T a`, then report preconditioner-scaled dual norms for both blocks using the declared ND and Schur preconditioners. Separately assemble the weak Ampere/current residual against the discrete test space. Form `B_oe` with the compatible ND-to-RT discrete curl, measure compatible RT0 divergence before any nodal projection, and report the essential-boundary residual and harmonic count. A recovered strong `||div A||`, a nodal curl/divergence diagnostic, or library convergence alone is not acceptance evidence.

- [ ] **Step 5: Project and publish field/work identity**

Compute compatible RT0 `B_oe=curl A` with the discrete `CurlInterpolator`, divide by `mu0` exactly once, certify the compatible divergence and only then apply the same consistent nodal `L2` projection/version as OE-F1. Reuse the common energy/work-snapshot builder so direct and mixed paths cannot drift in sign, `mu0`, `1/2`, source identity or rejected-stage behavior.

- [ ] **Step 6: Run cross-oracle and airbox gates**

```bash
just verify-fem-oersted-oef2-cpu-contract
just verify-fem-oersted-oef1-cpu-contract
just verify-fem-time-domain-cpu-only-contract
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
- Modify: `crates/fullmag-authoring/src/spin_transport.rs`
- Modify: `crates/fullmag-authoring/src/validation.rs`
- Modify: `crates/fullmag-authoring/src/adapters.rs`
- Modify: `crates/fullmag-authoring/src/builder.rs`
- Modify: `crates/fullmag-api/src/quantity_data_plane.rs`
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/current_transport.py`
- Modify: `packages/fullmag-py/src/fullmag/model/energy.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/resources/spinAuthoringResources.ts`
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

Verify Python -> scene, API -> scene, UI -> API -> scene, and canonical script export -> parse preserve `boundary_gauge_variant`, Krylov policy, harmonic policy, `current_source_id`, closure kind, authored `geometry_ref`/`volume_mesh_intent` and `fem_closed_current_extension.v1` byte-for-byte. All four reject an authored `current_view_ref`, artifact revision, face-record count or digest. Separate planner/runner tests prove that the resolved plan binds `ConservativeCurrentViewRef` only from the executed `current_source_id` revision and its verified artifact. Empty/default selection normalizes to `tangential_A_h1_0.v1`; explicitly authored zero-mean variant rejects as unavailable rather than silently running baseline. `analytic_return_path` rejects for OE-F2 even if OE-F1 accepts it as the separately tagged additive `oersted_analytic_return_additive.v1` realization. Any GPU or single-precision request rejects before native construction.

- [ ] **Step 2: Wire typed plans and ABI without generic ownership**

Extend the dedicated Oersted ABI family with the baseline variant and solver fields. `oersted_c_api.cpp` validates the complete request and bounded views, deep-copies caller-owned data, invokes the native owner and exposes a bounded result with explicit release semantics. Add request/result tamper and post-call caller-buffer-mutation tests. Runner loads/validates OE-T0 artifacts, invokes the native owner, and publishes outputs. `dispatch.rs`, generic `execute.rs`, `Context`, and `mfem_bridge.cpp` may only name/call the owner; they may not assemble spaces/forms or store duplicate physics policy.

- [ ] **Step 3: Expose resource-first observability**

Serve the existing `H_oe` quantity from the projected artifact and expose compact diagnostics/provenance: requested/resolved method, operator/engine, source/closure digests, gauge/BC, topology certificate, airbox sizes, iterations/residuals, projection version, work semantics and snapshot identity. Heavy fields remain binary. Inspector labels carry SI units and show `semantic_only`/unsupported states exactly from capability data.

- [ ] **Step 4: Run API/UI gates**

```bash
just verify-fem-oersted-oef2-cpu-contract
cargo test -p fullmag-authoring spin_transport_oersted_roundtrip
cargo test -p fullmag-plan oersted
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
- Produces: one reproducible managed gate, workload-bounded evidence for at most `reference_executable` or an honest retained `semantic_only` status, and a publication-quality evidence report.

- [ ] **Step 1: Freeze managed verification recipes**

Confirm all six Task 0 CPU-only recipes retain their configuration assertions,
then freeze `just verify-fem-oersted-oet0-cpu-contract`,
`just verify-fem-oersted-oet0-tsan-cpu-contract`,
`just verify-fem-oersted-oef1-cpu-contract` and
`just verify-fem-oersted-oef2-cpu-contract` around the exact native tests and
Rust ABI checks inside the managed CPU-only FEM container against its prebuilt
CPU library. Add one public end-to-end recipe that runs canonical Python
authoring, planner, native CPU-double execution, artifact validation and
quantity readback.

- [ ] **Step 2: Run complete evidence matrix**

```bash
just verify-fem-steady-transport-cpu-only-contract
just verify-fem-oersted-oet0-cpu-contract
just verify-fem-oersted-oet0-tsan-cpu-contract
just verify-fem-oersted-oef1-cpu-contract
just verify-fem-oersted-oef2-cpu-contract
just verify-fem-time-domain-cpu-only-contract
just check
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
pnpm --dir apps/control-room test
```

Record command, commit, managed runtime digest, workload, mesh/airbox sequence, tolerances, result, artifact hashes and wall time. A started container or one green sub-gate is not completion evidence.

- [ ] **Step 3: Decide status from evidence, never intent**

Promote only the exact tuples proven by the named gates. OE-F1 may become at most `reference_executable` for FEM CPU/double/strict within its pair-budget and closed tetrahedral circuit scope. OE-F2 may become at most `reference_executable` for the exact CPU/double/strict, topology and airbox envelope exercised by the public execution, cross-oracle, exact-sequence, topology-reject and artifact gates. This task cannot assign `production_executable`; that requires Task 8. FEM GPU remains `semantic_only`/unsupported exactly as capability data states; no CPU result can promote it.

- [ ] **Step 4: Final independent review and commit**

Package the complete branch diff. Require no Critical/Important findings, clean `git diff --check`, valid JSON, docs link/lint success and no placeholder/status overclaim. Update the report checklist with every remaining limitation, then commit with message `docs(fem): publish Oersted implementation evidence`.

### Task 8: Separate future production-envelope and scaling qualification

**Status:** Deferred; it is not authorized by, and must not be claimed as completed by, Tasks 1--7.

**Interfaces:**
- Consumes: an already reproducible `reference_executable` OE-F2 lane and frozen CPU runtime digest.
- Produces: workload-bounded performance, memory, convergence and operational evidence that may support a later, separately reviewed production promotion.

- [ ] Define a versioned production workload envelope covering conductor/airbox element counts, aspect ratios, coefficient contrast, supported topology, current magnitude, mesh partitions and target accuracy.
- [ ] Add an explicit AMS scaling gate, including BoomerAMG iteration scaling and wall-time/memory measurements across mesh and MPI partition sequences; demonstrate bounded iteration growth and no partition-dependent physics drift.
- [ ] Qualify airbox truncation, mesh refinement, OE-F1 cross-oracle subsets, restart behavior, deterministic artifact identity and failure recovery at the envelope boundaries.
- [ ] Run soak and repeated-stage tests that cover artifact lifetime, rejected solves, cancellation, memory growth and managed-runtime reproducibility.
- [ ] Commission independent physics, MFEM/hypre performance, ABI/security and product-operability reviews. Only a new capability change with these artifacts may consider `production_executable`; absence of evidence leaves the lane at `reference_executable` or lower.

## Final exit criteria

- OE-T0 publishes one immutable RT0/H(div) field with complete source/mesh/topology/closure revision and digest identity plus independent balance evidence.
- OE-F1 integrates affine RT0 current over physical tetrahedra, including singular target/source pairs without cutoff, and matches analytic/refinement/sign/rotation gates.
- OE-F2 implements baseline `H_0(curl) x H^1_0`, not a zero-mean surrogate, rejects unsupported topology, and converges to OE-F1 across mesh/airbox sequences.
- OE-F1 and OE-F2 publish the same projected LLG field convention and exact energy/work-snapshot identity.
- Python, ProblemIR, planner, ABI, runner, artifact, API and UI preserve requested/resolved semantics and fail closed for unsupported GPU/single/zero-mean variants.
- All authoritative native proof comes from managed `just` recipes; capability rows describe only the evidence actually obtained.
