# Capability matrix v0

## Purpose

The capability matrix answers two questions before execution:

1. Is a Python-authored `ProblemIR` legal for the requested backend and mode?
2. If it is legal, what planning path should be selected?

For the STT / STNO roadmap slice, the canonical machine-readable source is:

- `docs/specs/capability-matrix-v0.json`

That JSON file is the authoritative status source for:

- the four-state vocabulary,
- Oersted alignment,
- STNO benchmark / report status,
- explicit semantic-only status for deferred FEM periodic / eigen parity items.

The broader Markdown tables below remain a wider repository snapshot during the
status-model migration, but the JSON slice above wins if there is any conflict
for STT / STNO roadmap items.

## Product-facing status vocabulary

Every product-facing feature should be described with one of these statuses:

| Status | Meaning |
|--------|---------|
| **`unsupported`** | Not executable on the current lane. |
| **`source_visible`** | Source code or scaffolding exists, but the lane is not publishable as an executable production path. |
| **`semantic_only`** | Legal in Python API and `ProblemIR`, but not executable on the current public path. |
| **`reference_executable`** | Executable on the trusted reference lane used for correctness and validation. |
| **`development_executable`** | Executable only in an explicitly selected development mode; not production-qualified. |
| **`partial_production_executable`** | Executable only for the explicitly documented bounded production workload. |
| **`implemented`** | Implementation exists, but production execution and validation are separate states. |
| **`production_executable`** | Executable on the intended production lane. |
| **`validated`** | Executable and benchmarked with explicit regression coverage for the documented workload. |

## Mixed-P1 shared-domain target vocabulary

The canonical target is defined by
`docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md` and ADR 0021.
These IDs expose one cross-layer vocabulary without claiming execution or
validation:

| Capability | Current product status | implementation_state | Evidence now | First promotion scope |
|---|---|---|---|---|
| `mesh.topology.mixed_p1` | CPU/GPU `implemented`; FDM `unsupported` | implemented | complete source-report/certificate validation, deterministic clone packing, final fingerprint rebinding, and runner/native contract gates exist; managed public-runtime proof is missing | one axis-aligned P1 Box in one conforming airbox |
| `mesh.swept.prism` | CPU/GPU `implemented`; FDM `unsupported` | implemented | native Python meshing and native contract tests preserve `prism6` without tet conversion; managed public-runtime proof is missing | `prism6` magnetic cells with no tet conversion |
| `mesh.transition.pyramid_tet` | CPU/GPU `implemented`; FDM `unsupported` | implemented | conforming `pyramid5` transition and `tet4` far-air topology remain certificate-bound in source and contract tests | `pyramid5` air transition and `tet4` far air |
| `mesh.exact_layer_count` | CPU/GPU `implemented`; FDM `unsupported` | implemented | accepted certificate requires requested = realized = `L`, exact `L+1` magnetic planes for `L in {1,2,3}`, empty report/certificate fallbacks, and `degraded=false` | exact `layers` in `{1,2,3}` for one physical film |
| `fem.cpu.exchange_demag.mixed_p1` | `implemented` | implemented | bounded CPU/strict/double P1 exchange/Poisson/relaxation source and operator contracts exist, but no immutable managed public-runtime report exists | MFEM/hypre CPU double, exchange + uniform Zeeman + Poisson Robin/Dirichlet |
| `fem.gpu.exchange_demag.mixed_p1` | `implemented` | implemented | bounded GPU/strict/double P1 exchange/Poisson/relaxation source and operator contracts exist, but no immutable managed public-runtime report exists | MFEM/libCEED/CUDA GPU double on the same certified mesh |

The current first-slice legality is explicit FEM, explicit CPU or GPU, strict mode,
double precision, P1, one Box, an exact layer count in `{1,2,3}`, one shared-domain airbox,
uniform `Ms`/`Aex`, exchange, optional uniform Zeeman, Poisson Robin/Dirichlet,
and PG-BB, NCG, or overdamped LLG. `auto`, single, extended, and hidden
fallback remain illegal.
Every mixed-P1 mesh feature capability publishes
`supported_layer_counts=[1,2,3]`. Control Room authoring fails closed when an
executable capability omits or changes that machine-readable scope, and the
canonical object-mesh export rejects exact prism layer counts outside it.
Strict execution requires both the certificate and enclosing build report to
record `fallbacks_triggered=[]`, plus build-report `degraded=false`; no prism-to-tet, GPU-to-CPU,
or mixed-to-free-tetrahedral fallback is legal.

Until separately qualified, all modes reject before backend startup when a
mixed-P1 request includes FEM/BEM, PBC/Floquet, DMI, STT, thermal,
magnetoelasticity, regional projections, eigen/frequency-domain studies,
DG0/material interfaces, order greater than one, arbitrary OCC shapes,
multiple bodies, or multilayers. FDM and hybrid lanes are unsupported. The
Gmsh 4.15.2 fixture is topology feasibility evidence and does not promote any
row to `production_executable` or `validated`. Promotion requires a fresh
managed public CPU/GPU run of the exact SP4 relaxation stage with immutable
fingerprint, device/engine, fallback, telemetry, and artifact evidence.

The Control Room may display typed mixed-certificate quality gates and
structured mixed-P1 rejection evidence without changing any capability row.
Typed orphan-entity diagnostics invalidate the Inspector topology-integrity
gate when non-empty. Tet4-only histogram selection returns the typed
`mixed_topology_not_supported` conflict for mixed topology instead of silently
omitting prism or pyramid cells.
Per-family quality evidence proves only the identity and acceptance checks of
the current certified mesh. Missing-capability IDs, requested/resolved
execution, `fallback=none`, and the `free_tetrahedral` alternative are
diagnostics supplied by the planner/runtime path; rendering them must never be
used to infer executable availability or validation.

### Execution-device cardinality

The public execution vocabulary accepts a device target and `gpu_count`, but
current FDM and FEM realizations are single-device only. `gpu_count=0` or `1`
is legal subject to the selected device/lane; `gpu_count>1` is rejected by the
Python DSL and ProblemIR validator in `strict`, `extended`, and `hybrid`
modes. This is an explicit unavailable-path diagnostic, not CPU fallback and
not a claim of multi-GPU capability.

### FEM automatic device crossover

FEM keeps the public `cpu | gpu | auto` device vocabulary. Explicit CPU and
GPU requests are hard constraints: performance policy never changes them, and
an unavailable explicit GPU request fails closed. Only `auto` may consume a
qualified, versioned, hash- and identity-verified crossover profile described
by ADR 0021. Without a matching profile, `auto` remains availability-first and
prefers an executable GPU lane; this is not benchmark qualification.

Current production activation is fail-closed because the runtime registry does
not yet join the selected manifest, actually loaded library hashes, and
detected GPU into one authoritative identity. Matching caller-controlled JSON
files cannot qualify a profile. Schema v1 rejects non-null signatures because
no algorithm, trusted key, or verifier is defined.
`FULLMAG_FEM_CROSSOVER_RUNTIME_IDENTITY` is ignored and untrusted; it has no
production or diagnostic consumer and cannot attest to runtime identity.

The crossover feature vector includes node count, optional native assembled
matrix nonzero count, demag state, relaxation algorithm, and preview state.
Missing `matrix_nnz` stays missing rather than being estimated. Requested and
resolved device, selection reason, calibration ID, and confidence are runtime
provenance and resource-first v2 status fields.
Preview state is derived from actual execution cadence, and the selected
decision is pinned through engine, session, artifact, and persistent-runtime
provenance without reloading mutable profile data.

### FEM dynamic-solver evidence overlay

FEM modal and driven solvers also record independent evidence axes so a narrow
executable or algebra oracle cannot promote a broader capability:

```text
implementation_state = absent | contract_only | source_visible | executable
validation_state = unvalidated | algebra_validated | physics_validated | production_qualified
validated_scope = bounded workload description
```

The product-facing status above remains the availability summary. These axes
state what exists and what the evidence actually covers. Synthetic periodic
airbox algebra, a one-thread dense GPU adapter, and the narrow cuSolverDN K0
macrospin exception are three different scopes and must never promote one
another.

## Native FEM qualification overlay

The 2026-05-16 native FEM audit adds a stricter reading rule for FEM CPU/GPU:
executor availability is not the same thing as solver qualification.

For native FEM, `production_executable` means the public lane can execute the
feature. It does **not** mean the feature is validated for production workloads
unless the row or related note lists explicit validated workloads.

Native FEM GPU runtime provenance uses `fem_gpu_qualification_status` with the
ladder `unsupported`, `source_visible`, `production_executable`, `validated`.
The current strict GPU path may publish `production_executable` only when the
resolved device-resident operator modes and hot-loop synchronization audit are
clean; it must not publish `validated` until the documented validation workload
has passed.

Canonical references:

- `docs/adr/0014-native-fem-backend-modularization.md`
- `docs/specs/native-fem-backend-architecture-v1.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

Native FEM release documentation must use this minimum target as the first
qualified CPU FEM scope unless a narrower release note says otherwise:

```text
FEM CPU P1
no PBC unless feature-specific PBC gates pass
exchange
Zeeman
uniaxial anisotropy
cubic anisotropy after derivative tests
Poisson demag airbox with documented boundary limits
explicit RK fixed/adaptive with stop-reason telemetry
```

The following native FEM features may be executable in the current code, but
must not be described as `validated` until their feature-specific gates pass:

```text
Slonczewski STT
Zhang-Li STT
DMI interfacial/bulk
thermal noise
generalized/current-solution Oersted on FEM
two-way magnetoelasticity
high-order FEM
general FEM GPU parity
```

### Spin torque, transport, SHE, and dynamic Oersted M0–M3 overlay

The normative physics sources are 0960–0980 and the runtime target is
`docs/specs/spin-transport-runtime-contract-v1.md`. Existing rows below retain
their historical executable-slice meaning. They must not be widened by name:

The following rows are normative PR-00 snapshots. A row is identified by the
tuple `(capability_id, formula/operator/realization version, discretization,
device, precision, execution mode, workload)`, never by capability name alone.
An omitted tuple is `unsupported`.

| Capability id | Version scope | Backend / device / precision / mode | Workload scope | Status | Promotion rule |
|---|---|---|---|---|---|
| `spin_torque.prescribed_sot` | `prescribed_sot.legacy_fullmag.v0` | FDM / CPU / double / strict | existing single-grid local SOT payload | `reference_executable` | compatibility only; no v1 or SHE claim |
| `spin_torque.prescribed_sot` | `prescribed_sot.legacy_fullmag.v0` | FDM / GPU / double or single / strict | existing single-grid native CUDA integrators | `production_executable` | compatibility only; no v1 or validated claim |
| `spin_torque.prescribed_sot` | `prescribed_sot.fullmag.v1` | FDM or FEM / CPU or GPU / any precision / any mode | canonical signed-current macrospin | `semantic_only` | SI/Gilbert/signed-current/mask/stage-time gates and lane proof |
| `spin_torque.zhang_li` | `zhang_li.fullmag.v1` | FDM / CPU or GPU / any precision / any mode | canonical domain-wall/PBC workloads | `semantic_only` | signed-current, operator-version, convergence and lane parity gates; legacy executable slices are not v1 evidence |
| `spin_torque.zhang_li` | `zhang_li.mumax3.v1` + `zl_mumax3_central_v1` | FDM / CPU / double / strict | MuMax3 Standard Problem 5 and central-stencil one-step oracle | `reference_executable` | source constants, clamped/PBC stencil, Gilbert projection, Python→IR→planner identity, and AoS/SoA CPU parity pass; full trajectory/SP5 parity remains open |
| `spin_torque.zhang_li` | `zhang_li.mumax3.v1` + `zl_mumax3_central_v1` | FDM / GPU / single or double / strict | same-gird native CUDA central stencil | `source_visible` | ABI and FP32/FP64 kernel branches are implemented; managed CUDA rebuild, device runtime parity, and qualification artifact are still required |
| `spin_torque.zhang_li` | `zhang_li.mumax3.v1` + `zl_mumax3_central_v1` | FEM / CPU or GPU / any precision / any mode | MuMax3-compatible FDM-only operator | `unsupported` | planner fails closed; FEM uses `zhang_li.fullmag.v1` with `zl_central_reference_v1` instead |
| `spin_torque.slonczewski` | `slonczewski.fullmag.v2` + `slonczewski_thin_layer_homogenized.v1` | FDM / CPU / double / strict | canonical macrospin/current-scaling workloads | `reference_executable` | corrected hbar/e SI/Gilbert oracle, signed `J_n`, target mask, and CPU regression gates; GPU fails closed until its versioned descriptor and parity gate exist |
| `spin_torque.slonczewski` | `slonczewski.fullmag.v2` + `slonczewski_thin_layer_homogenized.v1` | FDM / GPU / single or double / strict | canonical macrospin/current-scaling workloads | `unsupported` | fail before native construction; no legacy fallback |
| `spin_torque.slonczewski` | `slonczewski.fullmag.v2` + `slonczewski_interface_flux.v1` | FDM / CPU or GPU / any precision / any mode | oriented interface flux | `unsupported` | fail in planning; no homogenized `1/t_F` substitution |
| `spin_torque.zhang_li` | `zhang_li.fullmag.v1` + `zl_central_reference_v1` | FEM / CPU / double / strict | canonical target-masked P1/lumped-projection operator | `reference_executable` | signed-current and independent algebraic oracle pass; domain-wall convergence and lane parity remain open |
| `spin_torque.zhang_li` | `zhang_li.fullmag.v1` + `zl_central_reference_v1` | FEM / GPU / double / strict | canonical target-masked operator | `unsupported` | fails closed before GPU provenance until an identical qualified device realization exists |
| `spin_torque.slonczewski` | `slonczewski.fullmag.v2` + `slonczewski_thin_layer_homogenized.v1` | FEM / CPU / double / strict | canonical target-masked local torque | `reference_executable` | signed `J dot n_stack`, explicit thickness and independent algebraic oracle pass; macrospin/current-scaling qualification remains open |
| `spin_torque.slonczewski` | `slonczewski.fullmag.v2` + `slonczewski_thin_layer_homogenized.v1` | FEM / GPU / double / strict | canonical target-masked local torque | `unsupported` | fails closed before GPU provenance until an identical qualified device realization exists |
| `spin_torque.slonczewski` | `slonczewski.fullmag.v2` + `slonczewski_interface_flux.v1` | FEM / CPU or GPU / double / strict | oriented interface functional | `semantic_only` | planner and native import fail closed until a separate surface functional exists; bulk `1/t_F` lowering is forbidden |
| `transport.charge.ohmic` | `current_transport.fullmag.v1` + `fv_charge_face_flux.v1` or FEM operator | FDM/FEM / CPU/GPU / double / strict | M1 uniform/layered bar with declared BC/gauge | `semantic_only` | conservative solve, balance, convergence and managed lane evidence |
| `transport.charge.magnetoresistive` | `transport_constitutive.reciprocal.fullmag.v1` | FDM/FEM / CPU/GPU / double / strict | M2 AMR/PHE/AHE and reciprocal workloads | `semantic_only` | complete material schema, positivity, Onsager and nonlinear gates |
| `transport.spin.steady_drift_diffusion` | `transport_constitutive.one_way.fullmag.v1` | FDM or FEM GPU / CPU or GPU / double / strict | M1 `spin_1d_diffusion_v1`, interface BC explicitly scoped | `semantic_only` | analytic profile, balance, convergence and managed lane proof |
| `transport.spin.steady_drift_diffusion` | `transport_constitutive.one_way.fullmag.v1` + `fv_spin_upwind_v1` | FDM / CPU / double / strict | M1 one-way structured-grid reference workflow with explicit six-face BC | `reference_executable` | runner-level charge/spin materialization and artifact tests pass; mixing/SML, GPU and cross-backend qualification remain open |
| `transport.spin.steady_drift_diffusion` | `transport_constitutive.one_way.fullmag.v1` + `fem_charge_spin_conforming_h1_p1.transparent.v1` | FEM / CPU / double / strict | full-domain conforming H1/P1, transparent interface, shared exact v1 linear policy | `reference_executable` | `implementation_state=executable`, `validation_state=algebra_validated`, scope `fem_cpu_double_conforming_h1_p1_transparent_m1`; analytic convergence and cross-backend qualification remain open; no fallback/degradation |
| `transport.spin.direct_she` | `transport_constitutive.one_way.fullmag.v1` | FDM or FEM GPU / CPU or GPU / double / strict | M1 `she_1d_film_v1` with declared BC | `semantic_only` | signed tensor-source oracle and charge-to-spin evidence |
| `transport.spin.direct_she` | `transport_constitutive.one_way.fullmag.v1` + `fv_spin_upwind_v1` | FDM / CPU / double / strict | M1 `she_1d_film_v1` structured-grid reference workflow with explicit insulating spin BC | `reference_executable` | runner-level signed `sinh/cosh` profile, charge-current and residual gates pass; BORIS executable parity and FDM/FEM convergence remain open |
| `transport.spin.direct_she` | `transport_constitutive.one_way.fullmag.v1` + `fem_charge_spin_conforming_h1_p1.transparent.v1` | FEM / CPU / double / strict | same transparent conforming H1/P1 M1 reference slice | `reference_executable` | emits revisioned canonical transport quantities; signed vector-profile gate passes, while cross-backend convergence remains open |
| `transport.spin.inverse_she` | `transport_constitutive.reciprocal.fullmag.v1` | FDM/FEM / CPU/GPU / double / strict | M2 reciprocal benchmark | `semantic_only` | Onsager, dissipation and nonlinear-coupling gates |
| `transport.spin.mixing_conductance` | `magnetoelectronic.fullmag.v2` | FDM/FEM / CPU/GPU / double / strict | `mixing_flux_balance_v2` | `semantic_only` | oriented two-trace law, backflow and torque balance; old v1 is read-only |
| `transport.spin.memory_loss` | `sml_reservoir.fullmag.v2` | FDM CPU reference / double / strict | `sml_reservoir_balance_v2`, `sml_reservoir_entropy_v2` | `reference_executable` | statically eliminated local reservoir, trace/power artifact and balance gate are executable in the bounded FDM M2 reference lane; native production, FEM and GPU remain unsupported |
| `transport.spin.transient_drift_diffusion` | `coupled_imex_ark2.v1` | FDM / CPU / double / strict | single-grid one-way M3 decay/order/restart workloads | `reference_executable` | qualified by canonical Python authoring at 300 K through public ProblemIR planning, runner artifacts, and a separate built `fullmag resume-json` process in `just verify-fdm-transient-spin-m3-reference`; API restore does not auto-relaunch the separate CLI process |
| `transport.spin.transient_drift_diffusion` | `coupled_imex_ark2.v1` | FDM GPU and FEM CPU/GPU / double / strict | M3 decay/order/restart workloads | `semantic_only` | no public executable realization or qualification workload |
| `field.oersted.dynamic` | `current_transport.prescribed_density.legacy_fullmag.v0` + `oersted_analytic_cylinder.v1` or `oersted_direct_biot_savart.v1` | FDM / CPU / double / strict | documented prescribed-current single-grid cylinder/midpoint slices only | `reference_executable` | bounded legacy execution; no canonical v1 closure, cadence, FFT, or H(curl) inference |
| `field.oersted.dynamic` | `current_transport.prescribed_density.legacy_fullmag.v0` + `oersted_analytic_cylinder.v1` or `oersted_direct_biot_savart.v1` | FDM / GPU / double or single / strict | documented prescribed-current single-grid native CUDA cylinder/midpoint slices only | `production_executable` | executable is not `validated` and is not the M1 FFT realization |
| `field.oersted.dynamic` | `current_transport.prescribed_density.legacy_fullmag.v0` + `oersted_analytic_cylinder.v1` or `oersted_direct_biot_savart.v1` | FEM / CPU or GPU / double / strict | documented prescribed-current native FEM cylinder/midpoint slices only | `production_executable` | executable is not canonical v1 or general H(curl)/airbox validation |
| `field.oersted.fdm_fft` | `fdm_oersted_cell_integrated_open.v1` + `oersted_fdm_fft_open.v1` | FDM / CPU or GPU / double / strict | M1 closed open-boundary circuit | `semantic_only` | direct cell-integrated oracle and convergence |
| `field.oersted.fem_direct_quadrature` | `fem_conservative_current_rt0_view.v1` + optional `fem_closed_current_extension.v1` + `fem_oersted_direct_tetra_quadrature.v1` + `oersted_direct_biot_savart.v1` | FEM / CPU / double / strict | small M1 volumetrically closed tetrahedral circuit or meshed lead extension; analytic return is a separate OE-F1-only additive realization | `semantic_only` | OE-T0 RT0 balance/digest certificate, singular/near/far quadrature convergence, sign/SI and deterministic projection gates |
| `field.oersted.fem_vector_potential` | `fem_conservative_current_rt0_view.v1` + optional `fem_closed_current_extension.v1` + `fem_oersted_hcurl_h1_gauge.v1` + `oersted_fem_vector_potential.v1` | FEM / CPU or GPU / double / strict | M1 volumetrically closed conductor+lead circuit contained in airbox; analytic return unsupported | `semantic_only` | OE-T0, exact `H_0(curl) x H^1_0` baseline, topology certificate, v2 discrete block/weak-Ampere/compatible-divergence residuals, direct-oracle and airbox convergence; zero-mean is separate |
| `coupling.transport_llg.one_way` | `transport_constitutive.one_way.fullmag.v1` | FDM/FEM / CPU/GPU / double / strict | M1 stage-consistent LLG workloads | `semantic_only` | accepted-state equality and temporal-order proof |
| `coupling.transport_llg.bidirectional` | `transport_constitutive.reciprocal.fullmag.v1` | FDM/FEM / CPU/GPU / double / strict | M2 nonlinear stage solve | `semantic_only` | residual/LTE, rejection and rollback proof |

No PR-00 documentation change promotes a runtime lane. `validated` always
requires a named workload, discretization, device, precision, boundary scope,
artifact hash, and the applicable managed-runtime gate.

### FDM periodic demagnetization boundary semantics

The FDM CPU reference and CUDA production lanes share one resolved boundary
realization.  A demagnetization request with any periodic local axis and
`pbc.demag = "open"` is unsupported and fails in planning; it must not be
silently interpreted as truncated images by one lane.  Legal periodic demag
resolves to `PeriodicTruncatedImages { image_counts }` with the same image
counts on CPU and CUDA.  Requested policy and resolved realization are both
published in artifact metadata.

Capability changes for those features must update both the capability row and
the relevant physics note with units, field/torque interpretation, validation
coverage, and known limits.

## Drive / STNO alignment slice

The following status statements are intentionally explicit because older docs and examples drifted:

| Feature | Status summary | Alignment note |
|---|---|---|
| `OerstedCylinder` on FDM and MFEM FEM | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM for constant / sinusoidal / pulse envelopes | `piecewise_linear` is still rejected on the public planner path. The FDM status covers current single-grid lanes; public multilayer FDM rejects Oersted terms until staged CPU/GPU multilayer RHS coverage exists. |
| `OerstedField(model="from_current_solution")` for cylindrical `prescribed_density` sources | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Executable only for `CurrentTransport(model="prescribed_density")` with cylindrical `solve_region` and axis-aligned current; planner lowers to the exact infinite-cylinder Oersted realization. The FDM status covers current single-grid lanes; public multilayer FDM rejects Oersted terms until staged CPU/GPU multilayer RHS coverage exists. |
| `OerstedField(model="from_current_solution")` for general `prescribed_density` sources | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Non-cylindrical prescribed-current sources lower to a midpoint Biot-Savart `H_oe(x)` realization with explicit provenance. The current FDM slice is still single-body and capped by planner source-cell count, but both CPU reference and native CUDA now execute the resulting per-cell field. Public multilayer FDM rejects Oersted terms until staged CPU/GPU multilayer RHS coverage exists. |
| `CurrentTransport(model="prescribed_density")` | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Emits `current_transport/<name>.json` as an auxiliary artifact. On single-grid FDM and MFEM FEM it can bind named current sources into OerstedField and prescribed Slonczewski / Zhang-Li torque modules. Public multilayer FDM rejects Oersted and spin-torque/current bindings until staged CPU/GPU multilayer RHS coverage exists. |
| `SlonczewskiSTT` / `ZhangLiSTT` | Version-dependent; see tuple rows above | Legacy FDM and FEM executable labels apply only to `*.legacy_fullmag.v0` and remain compatibility behavior. Canonical FEM CPU double/strict implements target-masked `slonczewski.fullmag.v2` thin-layer and `zhang_li.fullmag.v1` central-reference contracts as `reference_executable`, not `validated`. Canonical FEM GPU rejects before GPU provenance; interface-flux Slonczewski rejects rather than bulk-lowering. Public multilayer FDM and the Rust FEM reference runner remain unsupported as previously documented. `slonczewski.fullmag.v1` is read-only provenance. |
| `examples/stno_vortex_ref_minimal.py` | `reference_executable` on the reference FDM lane | This is the canonical minimal STNO benchmark; full solver CI validation remains separate work. |
| `examples/stno_vortex_mtj_workflow.py` | non-canonical workflow example | Do not treat this generated workflow as the golden benchmark. |
| Artifact-backed STNO report | `validated` on the reference FDM lane | Uses real solver artifacts, not synthetic demonstration data, and has regression coverage for the analysis path. |
| FEM periodic / Floquet spin-wave support | `partial_production_executable` for k=0 static-periodic driven response on native FEM CPU and native FEM GPU magnetic slices, with ordinary k=0 demag supplied by the backend demag-tangent provider; narrow CPU/GPU nonzero-k Floquet no-demag phase projection; `semantic_only`/`unsupported` for broader Floquet lanes | Static-periodic response requires `mesh.periodic_node_pairs` plus boundary-pair metadata with translation/tolerance diagnostics, and stays separate from full nonzero-k Floquet/Bloch demag support. The current CPU/GPU static-periodic response can run on a magnetic-body mesh or on the compacted magnetic slice extracted from a shared-domain airbox mesh; dynamic demag on GPU is a hybrid CUDA local/exchange plus backend demag-provider path, not device-resident periodic Poisson. The current driven Floquet no-demag slice phase-projects the complex response block for local terms plus a supplied exchange-edge tangent operator; the high-level planner/runner can reach it for complete pair metadata and Bloch-phased tangent drive when demag and DMI are not requested. It is not periodic demag, full periodic exchange-graph assembly, periodic Poisson, or production k-path response. Floquet dynamic demag remains gated. |
| FEM eigen equilibrium import for STNO parity | `semantic_only` | Do not describe as end-to-end public STNO support yet. |
| FEM eigen frequency-window target | `semantic_only` for public authoring; `implementation_state=source_visible`, `validation_state=unvalidated` for production selected-spectrum qualification | Intended public contract: `frequency_min_hz`, `frequency_max_hz`, and `count` as max returned modes in the interval. A native PETSc/SLEPc selected-spectrum adapter exists; the remaining blockers include the real-scalar imaginary-axis target transformation, original-operator residual qualification, and real shared-domain Poisson assembly where demag is requested. Current dense/sparse reference execution and source-visible SLEPc code must not be marketed as COMSOL-class large-object execution. |
| FEM modal interior-window eigensolve | `semantic_only`; `implementation_state=source_visible`, `validation_state=unvalidated` for the native production adapter | This row is the modal `modal_eigen` product only. `Eigenmodes` uses `L q = lambda B_alpha q`, `lambda=i omega`, tangent variables, and explicit interval targets such as `frequency_min_hz` / `frequency_max_hz`. Its status does not promote driven response. The native SLEPc implementation exists, but its current real-axis target is not a qualified imaginary-axis shift. Synthetic Poisson-airbox algebra oracles remain non-production: `assembly_kind=synthetic_algebraic_oracle` must keep `production_periodic_airbox_claim=false` until a real shared-domain FEM assembly is validated. |
| FEM Poisson-airbox K0 modal algebra oracle | `source_visible`; `implementation_state=executable`, `validation_state=algebra_validated`, `validated_scope=tiny synthetic full-descriptor fixtures` | `assembly_kind=synthetic_algebraic_oracle` exercises descriptor, Schur reconstruction, sign, and verifier algebra only. It is not a publishable physical reference lane, cannot carry `production_periodic_airbox_claim=true`, and does not qualify real MFEM weak-form assembly, mesh convergence, or production Poisson physics. |
| FEM Poisson-airbox K0 modal CPU production | `source_visible`; `implementation_state=source_visible`, `validation_state=unvalidated` | The native SLEPc adapter exists, but production remains unavailable until `assembly_kind=mfem_weak_form_shared_domain`, the imaginary-axis real-split target, finite descriptor handling, original-operator residual, and managed mesh/airbox physics gates all pass. |
| FEM GPU Poisson-airbox dense G5a oracle | `source_visible`; `implementation_state=executable`, `validation_state=algebra_validated`, `validated_scope=bounded one-thread dense GPU fixture` | The truthful lane is `gpu_dense_modal_validation`. It is not a publishable physical reference lane and is one-shot, non-persistent, and non-scalable, so `gpu_device_resident_modal_eigensolver=true` and any production modal claim are forbidden. The separate `gpu_dense_k0_macrospin_modal_eigen` cuSolverDN exception does not promote this Poisson-airbox oracle. |
| FEM modal k-path dispersion | `reference_executable` for the CPU reference/MVP modal artifact lane; `partial_production_executable` for the managed native CPU selected-spectrum no-demag `Full2x2` Floquet k-path slice and for the gamma-equivalent production CPU provenance bridge; `partial_production_executable`/validated for the managed native GPU K0 no-demag macrospin/Kittel slice only | COMSOL-style nonzero-k dispersion maps to `Eigenmodes` over a Floquet/Bloch k path, not to driven `FrequencyResponse`. `/v2/sessions/current/analysis/frequency-domain/manifest.v1` exposes `capabilities.dispersion.reference_cpu`, `capabilities.dispersion.production_cpu`, `capabilities.dispersion.production_cpu_gamma_k_path`, and `capabilities.dispersion.production_gpu`: the reference CPU lane can emit spectrum, branches, `dispersion.csv`, and mode-field artifacts; `production_cpu_gamma_k_path` proves only that legal gamma-equivalent samples can preserve selected-spectrum production CPU provenance through the multi-k orchestrator; `production_cpu` is the managed native CPU selected-spectrum nonzero-k Floquet slice with labelled Bloch/Floquet tangent payloads, `lambda_eq_i_omega`, `exp_i_omega_t`, persisted mode-field payloads, and analytic/reciprocal exchange-only gates; and `production_gpu` is currently limited to the K0 no-demag macrospin/Kittel validation lane using `gpu_dense_k0_macrospin_modal_eigen` with cuSolverDN dense generalized solve, `device_residency=gpu_device_resident`, and no CPU fallback. Dynamic demag-k, nonzero-k Floquet GPU modal operators, and broader sparse/matrix-free Floquet validation remain gated until the matching native operators/eigensolvers exist. The driven-response GPU Floquet smoke must not be reused as modal dispersion proof. |
| FEM driven frequency response | `partial_production_executable` for the native FEM CPU gamma/free-boundary, k=0 static-periodic magnetic/compacted shared-domain, diagnostic `periodic_airbox_k0` Schur/provider, and no-demag nonzero-k Floquet phase-projection slices; `partial_production_executable` for the native FEM GPU gamma/free-boundary, k=0 static-periodic magnetic/compacted shared-domain, narrow `periodic_airbox_k0` Schur/provider slice with GPU demag tangent-with-potential provider, and no-demag nonzero-k Floquet phase-projection slice; `reference_executable` for dense FEM validation response | This row is the driven `driven_response` product only. `Frequency Response` solves `(i omega B - A) q = b` at requested frequencies. Its status does not promote modal eigensolve. The CPU/GPU slices include exchange, Zeeman, uniform uniaxial anisotropy, uniform or nodal damping, ordinary k=0 dynamic demag through a backend demag-tangent provider when requested, and P1 interfacial/bulk DMI for open/gamma and k=0 static-periodic magnetic slices when the native element tangent payload is complete. The GPU `periodic_airbox_k0` path is limited to matrix-free Schur/phi-consistency or coupled-block provider routes: it must build the demag tangent-with-potential backend on the GPU demag backend when using the Schur provider, uses a persistent CUDA magnetic-operator context for static device buffers across Krylov applications, and must not accept explicit CPU dense/coupled-block payloads as GPU proof. The nonzero-k Floquet no-demag slice phase-projects local terms and a supplied exchange-edge tangent operator with `floquet_phase_projection=true`; high-level planning requires magnetic-body or compacted magnetic-slice geometry, no demag, no DMI, complete pair metadata, and Bloch-phased tangent drive unless a complete lane-appropriate coupled-block provider is supplied. Full periodic exchange-graph assembly, nonzero-k Floquet DMI assembly on GPU, native nonzero-k demag-k Poisson assembly, dense coupled-block GPU response, magnetoelastic response, fully device-resident Krylov, and validated production k-path response remain explicitly gated. |
| `StudyIR::FrequencyResponse` | `partial_production_executable` for the native FEM CPU gamma/free-boundary, k=0 static-periodic magnetic/compacted shared-domain, diagnostic `periodic_airbox_k0` Schur/provider, and no-demag nonzero-k Floquet phase-projection slices; `partial_production_executable` for the native FEM GPU gamma/free-boundary, k=0 static-periodic magnetic/compacted shared-domain, narrow `periodic_airbox_k0` Schur/provider slice with GPU demag tangent-with-potential provider, and no-demag nonzero-k Floquet phase-projection slice; `reference_executable` for dense FEM validation response | Public Python/API/IR semantics exist. The current runner can emit artifact-backed dense block-real magnetic frequency-sweep validation results as `fem_frequency_response_dense_validation`, exposes the native MFEM production CPU response engine as `fem_frequency_response_production_cpu`, and routes requested GPU frequency response to `fem_frequency_response_production_gpu` for gamma/free-boundary, k=0 static-periodic magnetic slices, the narrow `periodic_airbox_k0` Schur/provider slice, and no-demag nonzero-k Floquet phase projection. Static-periodic response requires `mesh.periodic_node_pairs`; explicit CPU/GPU response may use a shared-domain airbox mesh by compacting the native request to magnetic nodes. CPU dynamic demag is supplied to the driven operator through a matrix-free backend demag-tangent provider. GPU ordinary k=0 dynamic demag uses the backend provider while local/exchange application remains CUDA-backed through a persistent CUDA magnetic-operator context; open/gamma and k=0 static-periodic GPU DMI use that context with a CUDA weak-residual tangent kernel when complete P1 element DMI payloads are supplied; GPU `periodic_airbox_k0` additionally requires the demag tangent-with-potential provider to be created on the GPU demag backend, accepts lane-appropriate matrix-free coupled-block providers, rejects explicit CPU dense/coupled-block payloads, and preserves `requested_execution_lane="production_gpu"` in artifacts. The current nonzero-k Floquet slice requires supplied Floquet pair metadata and remains limited to no-demag/no-DMI phase projection of local terms plus a supplied exchange-edge tangent operator, with the Rust native wrapper forwarding that accepted slice to C ABI instead of pre-native unavailable short-circuiting. Full nonzero-k Floquet/Bloch production response without a supplied coupled-block provider, missing periodic pair metadata, nonzero-k Floquet DMI on GPU, magnetoelastic response, native nonzero-k demag-k Poisson assembly, dense coupled-block GPU response, fully device-resident Krylov, and broader production GPU response remain explicitly gated. |

Runtime capability payloads expose five separate deferred booleans for this scope: `supports_frequency_response`, `supports_coupled_magnetoelastic_quasistatic`, `supports_coupled_magnetoelastic_elastodynamic`, `supports_frequency_domain_elastodynamics`, and `supports_coupled_eigenmodes`; all remain `false` for current engines until the matching solver family is implemented and validated. The frequency-domain analysis manifest is the precise UI gate for modal dispersion lane status and must keep `dispersion.reference_cpu`, `dispersion.production_cpu`, `dispersion.production_cpu_gamma_k_path`, and `dispersion.production_gpu` aligned with the rows above.

The frequency-domain UI may expose the diagnostic readiness labels `periodic_airbox_k0.production_cpu_not_validated` and `periodic_airbox_k0.production_gpu_not_validated` only as temporary rejection/degraded-state reasons. They mean that the requested k=0 periodic-airbox driven response lacks the matching managed production proof for that lane; they must not be converted into user-selectable execution modes or treated as successful capability states.

## Microwave antenna field-basis slice

The solved-antenna target is defined by
`docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
and ADR 0017. The regional-drive target is defined independently by
`docs/physics/0920-regional-time-domain-field-drive.md` and ADR 0019.
Capability is split between layout authoring, field-solve
execution, field-basis consumption, and analysis. Source visibility in one
part does not promote the others.

| Capability | FDM CPU reference | FDM GPU production | FEM CPU public | FEM GPU public | Current truth |
|---|---|---|---|---|---|
| `RegionalFieldDrive` / `prescribed_zeeman_mask` import compatibility | `reference_executable` | `unsupported` with explicit rejection | `source_visible` only | `unsupported` | Current truth before ADR 0019 implementation: FDM CPU consumes the legacy materialized mask; native FEM has no qualifying projection/RHS proof. Planner-visible intent is not executable evidence. New authoring exports only `RegionalFieldDrive` and no lane may fall back to `SolvedAntennaDrive` or another device. |
| variable-width 3D microstrip/CPW layout | `unsupported` | `unsupported` | `unsupported` | `unsupported` | Current constant-width antenna structs and box preview do not encode ordered width/gap stations or explicit return conductors. |
| `StudyIR::AntennaFieldSolve(model="quasistatic_conduction_biot_savart_3d")` | `unsupported` | `unsupported` | `unsupported` | `unsupported` | Initial target is native FEM CPU/MFEM H1 conduction plus adaptive 3D Biot-Savart. Current `mqs_2p5d_az` is an infinite-strip approximation and does not satisfy this row. |
| `SolvedAntennaDrive` consumption | `unsupported` | `unsupported` | `unsupported` | `unsupported` | Each lane is promoted independently after artifact compatibility, stale rejection, waveform, `H_ant`, and LLG parity gates pass. |
| source `W_H(k)` | `semantic_only` | `semantic_only` | `semantic_only` | `semantic_only` | `SpinWaveExcitationAnalysis(method="source_k_profile")` authoring exists, but the resource-backed vector spectrum is not executable. |
| local `W_H(u,k)` | `unsupported` | `unsupported` | `unsupported` | `unsupported` | Requires the new variable-width layout and windowed local-spectrum analysis contract. |
| Gamma time-domain response from `RegionalFieldDrive` | `unsupported` | `unsupported` | `unsupported` | `unsupported` | Promotion requires equilibrium transfer, exact cadence, `H_drive` RHS/readback identity, RK-time convergence, linear-response, mesh, and lane-parity gates from physics note 0920. |
| finite-k response `S_m(k,omega)` | `unsupported` | `unsupported` | `unsupported` | `unsupported` | Requires localized regional drive, open propagation supercell, absorber proof, uniform physical probe operator, and an artifact-backed response. It must not be inferred from source spectrum or a nonuniform FEM node FFT. |

Promotion order is fixed:

1. typed layout/port/stage/drive semantics;
2. native FEM CPU field solve with managed-runtime analytical and convergence
   evidence;
3. FDM CPU reference and FEM CPU field-basis consumption;
4. CUDA FDM and native FEM GPU consumption after double-precision parity;
5. source-spectrum and dynamic-response analysis products;
6. publication-aligned variable-width CPW benchmark.

An FDM downstream request may use an FEM CPU field-solve artifact only as
explicit cross-discretization state transfer. The field-solve and downstream
requested/resolved execution records remain separate. Forced unsupported
field-solve lanes fail; they do not silently choose another device.

## Current execution policy

### Planar monitor postprocessing capability

Planar sampling is postprocessing of a published spatial field. Solver
execution device and sampling execution are separate capability dimensions.
The first production sampler runs on CPU, including when `source_device=gpu`;
that does not claim native GPU sampling.

| Capability | FDM | FEM P1 | FEM high-order | Failure/degraded rule |
|---|---|---|---|---|
| `planar_monitor_authoring` | implemented | implemented | gated | invalid authored frame/target rejects before execution |
| `planar_plane_sample` axis frame | scientifically validated | scientifically validated | gated | no hidden basis-order fallback |
| `planar_plane_sample` arbitrary frame | scientifically validated | scientifically validated | gated | invalid/unsupported frame returns stable reason |
| `planar_slab_average` | cell-volume weighted, validated | conservative tetra measure, validated | gated | node-count averaging forbidden |
| `planar_depth_projection` | cell-volume weighted, validated | conservative tetra measure, validated | gated | unsupported reduction rejects |
| `planar_surface_projection` planar boundary | boundary measure | boundary triangle measure, validated | gated | folded/non-injective surfaces are diagnostic |
| `planar_vector_sampling` | browser-verified | browser-verified nodal vectors | gated | unavailable component returns stable reason |
| `planar_mesh_overlay` | optional grid outline | exact section topology, browser-verified | topology-gated | absence does not alter sampled values |
| `planar_airbox_sampling` | full-domain quantities only | full-domain quantities and air mesh | gated | magnetic-only quantities do not become airbox fields |

`contract target` and `production target` are not current validation claims.
Promotion to `public-executable`, `browser-verified`, scientifically
`validated`, or `production-ready` requires the current artifacts specified by
`docs/physics/0970-planar-monitor-sampling-and-projection.md`. Strict and
extended modes preserve the same monitor intent; no mode silently substitutes
another operator. Hybrid sampling remains planned.

Stable capability reasons are:

- `quantity_not_spatial`;
- `quantity_not_materialized`;
- `target_outside_monitor`;
- `fem_topology_required`;
- `fem_basis_order_unsupported`;
- `surface_projection_non_injective`;
- `airbox_quantity_scope_unsupported`;
- `vector_component_unavailable`;
- `sampling_budget_exceeded`;
- `stale_mesh_scope`;
- `stale_monitor_revision`;
- `stale_field_revision`.

- `strict` means backend-neutral semantics only.
- `extended` is reserved for future backend-specific features.
- `hybrid` is explicit and requires both hybrid mode and hybrid backend.

## Authoring-layer note

- `SceneDocument` `scene.v1` is now the canonical control-room authoring document for geometry,
  material assignment, magnetization initialization, study defaults, and editor metadata.
- `study.exchange_enabled` and `study.demag_enabled` are authoring switches for active
  `ProblemIR.energy_terms`. Disabling either term removes that contribution from `H_eff`; it does
  not create a new solver capability or a per-object demag participation mask.
- This does not expand executable capability coverage by itself.
- Execution legality, planner resolution, requested-vs-resolved backend semantics, and runtime
  provenance remain governed by the same `ProblemIR` and backend capability rules listed below.

## Runtime engine naming

- `BackendPlanIR::Fem` on CPU resolves to `fem_cpu_native`.
- `fem_cpu_native` is the sole maintained CPU FEM engine and denotes the MFEM/libCEED/hypre
  runtime stack, not a generic "some CPU-native FEM" bucket.
- `fem_cpu_native` availability is `native_fem_cpu_available`: an MFEM/hypre CPU-capable
  native FEM stack is present. CUDA runtime support, visible CUDA devices, and MFEM CUDA device
  support are not prerequisites for this CPU lane.
- `BackendPlanIR::Fem` on GPU resolves to `fem_native_gpu`.
- `fem_native_gpu` availability is `native_fem_gpu_available` and remains separate from the
  CPU probe. A non-forced GPU request may resolve to `fem_cpu_native` only for
  a capability whose explicit planner policy permits that degradation and only
  when `native_fem_cpu_available=true`; this is not a generic fallback rule.
- The production FEM relaxation set for demag workloads is `llg_overdamped`,
  `projected_gradient_bb`, and `nonlinear_cg` at the qualified `rtol<=1e-12`
  direct-minimizer policy. There is no hidden PG-BB-to-NCG fallback.
- `tangent_plane_implicit` is CPU/MFEM development-only. Strict mode rejects
  TPI, and every forced GPU TPI request rejects. Extended automatic selection
  may resolve TPI only to the CPU/MFEM development lane with explicit warning
  and requested/resolved provenance; no hidden GPU-to-CPU fallback is legal.
- FEM relaxation runtime proof must be container-backed. Host-side `cargo`,
  `cmake`, or direct native binaries are smoke checks only; final FEM runtime
  evidence comes from the managed `just` recipes such as
  `just ensure-managed-fem-runtime` and `just fem-gpu-headless ...`.
- Time-domain FEM has no CPU-reference fallback lane: if the local launcher lacks native MFEM
  support, it must hand off to the managed `fem-gpu-host` runtime or fail early with an explicit
  diagnostic.
- `fem_cpu_baseline_internal` is reserved for the Rust FEM baseline helper and must not appear as
  the public time-domain FEM `resolved_engine_id`.
- `BackendPlanIR::FemEigen` on CPU resolves to `fem_eigen_cpu_baseline`.
- `BackendPlanIR::FemEigen` on GPU resolves to `fem_eigen_native_gpu`.
- `FULLMAG_FEM_EXECUTION=cpu` selects the CPU lane, but the final engine id still depends on the
  workflow family (`fem_cpu_native` for time-domain FEM, `fem_eigen_cpu_baseline` for FEM eigen).
- `resolve_runtime_capabilities()` must return the same canonical engine ids as runtime/session
  resolution; capabilities metadata is part of the same public execution contract.
- Canonical reference: `docs/specs/runtime-engine-naming-v0.md`.

### LLG time-domain evidence overlay

Contract IDs: `LLG-TD-POLICY-V1`, `LLG-TD-ATTEMPT-V1`, and
`LLG-TD-STIFF-V1`, with `LLG-TD-FIRST-DT-V1`, `LLG-TD-MAX-ERR-V1`, and
`LLG-TD-ATOMIC-V1` as required policy semantics. Status describes publication availability; implementation
and validation remain separate evidence axes.

The validation vocabulary is exact and monotonic: `unvalidated`,
`algebra_validated`, `physics_validated`, and `production_qualified`. Runtime,
artifacts, API, and Control Room resolve the state from the checked-in registry;
they never infer it from an engine or qualification ID. The registry key is
capability ID + qualification ID + backend + device + precision + integrator +
timestep policy. Missing or mismatched artifact/source evidence fails closed to
`unvalidated`.

| Policy | Backend | Device | Precision | Product status | implementation_state | validation_state | validated_scope |
|---|---|---|---|---|---|---|---|
| explicit fixed | FDM | CPU | double | `reference_executable` | executable | unvalidated | RK23/RK45 AoS/SoA exact fixed-step contract tests pass; no adaptive retry or next-step suggestion; scientific qualification pending |
| explicit fixed | FDM | CPU | single | `unsupported` | absent | unvalidated | CPU reference is double-only |
| explicit fixed | FDM | CUDA | double | `production_executable` | executable | unvalidated | source contract preserves exact fixed RK23/RK45 semantics; no CUDA runtime evidence in Task 7; Task 12 qualification pending |
| explicit fixed | FDM | CUDA | single | `production_executable` | executable | unvalidated | source contract preserves exact fixed RK23/RK45 semantics; FP32 runtime budget remains separate and unproven |
| explicit fixed | FEM | CPU | double | `production_executable` | executable | unvalidated | native explicit fixed execution; full interaction matrix not implied |
| explicit fixed | FEM | CPU | single | `unsupported` | absent | unvalidated | native FEM CPU is double-only |
| explicit fixed | FEM | GPU | double | `production_executable` | executable | unvalidated | native explicit fixed execution; no FP32 implication |
| explicit fixed | FEM | GPU | single | `unsupported` | absent | unvalidated | no qualified native FEM GPU FP32 lane |
| explicit adaptive | FDM | CPU | double | `reference_executable` | executable | unvalidated | AoS/SoA contract tests reject above-tolerance attempts at `dt_min` with no state commit; scientific trajectory and guard qualification pending |
| explicit adaptive | FDM | CPU | single | `unsupported` | absent | unvalidated | CPU reference is double-only |
| explicit adaptive | FDM | CUDA | double | `source_visible` | executable | unvalidated | v2 ABI behavior, canonical PI vectors, fixed/adaptive separation, typed floor failure, and batch `dt_next` consumption are contract evidence; guard-enabled policies fail closed; trajectory/trace qualification pending |
| explicit adaptive | FDM | CUDA | single | `source_visible` | executable | unvalidated | shared PI controller and FP32 compile/contract budget only; guards fail closed; separate runtime accuracy/trajectory qualification pending and no FP64 promotion |
| explicit adaptive | FEM | CPU | double | `production_executable` | executable | unvalidated | prior managed FP64 RK45 evidence covers Gilbert macrospin, periodic exchange, fast-mode rejection, relax-to-run handoff, Poisson demag, replay, and the periodic-antidot fixture, but the current registry has no exact clean schema-v3 artifact/source binding; the lane therefore fails closed |
| explicit adaptive | FEM | CPU | single | `unsupported` | absent | unvalidated | native FEM CPU is double-only |
| explicit adaptive | FEM | GPU | double | `production_executable` | executable | unvalidated | prior strict-device FP64 RK45 evidence used CUDA RK kernels, device Hypre Poisson, no fallback, exact relax-to-run handoff, and the periodic-antidot fixture, but the current registry has no exact clean schema-v3 artifact/source binding; the lane therefore fails closed and FP32 remains unqualified |
| explicit adaptive | FEM | GPU | single | `unsupported` | absent | unvalidated | no qualified native FEM GPU FP32 adaptive lane |
| stiff time-domain | FEM | CPU | double | `unsupported` | absent | unvalidated | a physical-time tangent-plane integrator must be implemented separately |
| stiff time-domain | FEM | CPU | single | `unsupported` | absent | unvalidated | no implementation; CPU remains double-only |
| stiff time-domain | FEM | GPU | double | `unsupported` | absent | unvalidated | no implementation and no hidden CPU fallback |
| stiff time-domain | FEM | GPU | single | `unsupported` | absent | unvalidated | no implementation and no hidden CPU fallback |

## Capability matrix

| Feature | FDM | FEM | Hybrid | Tier | Notes |
|---------|-----|-----|--------|------|-------|
| `Box` geometry | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Box→grid lowering for FDM and Box→mesh lowering for FEM |
| `Cylinder` geometry | planned | planned | planned | semantic-only | Requires active-mask voxelizer for accurate curved-boundary FDM execution |
| Imported geometry ref | planned | planned | planned | semantic-only | FDM planner accepts it when a precomputed grid asset is attached; public execution still depends on voxelization extras |
| Material constants (`Ms`, `A`, `alpha`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Used by the CPU reference FDM runner and the MFEM/libCEED/hypre CPU plus MFEM/libCEED/CUDA GPU FEM runners |
| Material constants (`Ku1`, `anisU`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Local uniaxial anisotropy is executable on the current FDM and FEM lanes. CPU FDM, single-grid native CUDA FDM, and public multilayer FDM expose the derived `H_ani` observation boundary; native FEM CPU qualification includes `exchange_anis_uniaxial` and `exchange_demag_anis_uniaxial` readiness gates for the no-PBC adaptive slice. A separate managed uniform-`M_s` FEM GPU fixture compares projected `eden_ani` and `eden_total` with native `E_ani` and `E_total`; this is bounded observable qualification, not validation of every anisotropy/runtime combination. Shared-domain FEM may realize different per-object uniaxial axes as nodal axis fields when materialization proves ownership; cubic-axis heterogeneity and surface anisotropy remain separately gated. |
| Material constants (`Kc1`, `anisC1`, `anisC2`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Local cubic anisotropy is executable on the current FDM and FEM lanes. CPU FDM, single-grid native CUDA FDM, and public multilayer FDM expose the derived `H_ani` observation boundary; native FEM CPU qualification includes `exchange_anis_cubic` and `exchange_demag_anis_cubic` readiness gates for the no-PBC adaptive slice. A separate managed uniform-`M_s` FEM GPU fixture selects `H_ani_cubic` and compares projected `eden_ani` and `eden_total` with native `E_ani` and `E_total`; this does not cover nonlocal or surface anisotropy. |
| Per-cell material fields (`ms_field`, `a_field`, `alpha_field`, `ku*_field`, `kc*_field`) | planned | bounded FEM exec | planned | **partial-production-executable** (FEM CPU DG0 `M_s`) | Current FDM execution plans carry uniform material constants only; single-grid and public multilayer FDM reject used materials with per-cell material fields instead of silently dropping them. FEM carries material field payloads through native material-field lanes where supported. The newly qualified sharp element-DG0 `M_s` slice is CPU/double ordinary time evolution with mandatory consistent-mass exchange; Poisson demag and Zeeman are optional additions, not standalone DG0 owners. GPU DG0, direct relaxation, DG0 anisotropy/DMI/thermal/STT/Oersted/magnetoelastic combinations, and discontinuous DG0 `A` remain unsupported and reject without nodal fallback. The direct-relaxation restriction is enforced by both planner and native ABI; DG0 step statistics use a direct allocation-free material-weighted reduction. |
| Object-owned authored regions (`object_regions`, region material overrides, region mesh policy, region couplings) | partial CUDA FDM exec | partial FEM executable | planned | **source-visible / partial-executable** | Authored regions are visible in Python, ProblemIR, OpenAPI, and the Control Room. Current single-grid CUDA FDM can materialize owner-scoped region masks for region texture overrides and explicit/disabled region-region exchange pairs; CPU reference FDM rejects executable pair overrides instead of silently ignoring them. FDM/FEM planning samples smooth `Ms/Aex` region material transitions into coefficient payloads using signed-distance weights; omitted `material_transition` defaults to `mesh_relative(cells=3, scope=boundary)` for `Ms/Aex`, while explicit `kind=sharp` remains the conformal/projection-gated discontinuous path. FEM also samples `Alpha` region overrides/fields into nodal coefficient payloads, records realization method plus min/max/mean statistics, and emits projection warnings for explicit sharp projection into runtime solver status. Python/Gmsh automatically creates conformal authored-region markers for fully contained box and cylinder regions on the OCC shared-domain path, including arbitrary cylinder axes; unsupported shapes, regions outside the owner, and overlapping conformal regions reject instead of degrading silently. Metadata-only markers do not qualify, and marker IDs cannot collide with object/domain `region_markers`. One bounded strict sharp-jump path is production-executable: conformal element-DG0 `M_s` on FEM CPU/double ordinary time evolution with mandatory consistent-mass exchange and optional Poisson demag/Zeeman. It preserves one shared P1 `m` field and uses no nodal fallback. This does not qualify discontinuous DG0 `A`, GPU DG0, other DG0 owners, region couplings, or general conformal coefficient runtime mapping. Explicit projection in extended mode remains the broader executable nodal-field path. Python `study.domain_mesh(..., object_region_markers=...)` preserves explicit precomputed markers through ProblemIR and script export. Broader conformal CSG and public multilayer FDM region-owned material/coupling remain deferred; public multilayer FDM rejects authored `object_regions` rather than silently ignoring them. Unsupported `rkky` and `interlayer_exchange` runtime coupling diagnostics use the public snake_case kind tokens, not Rust enum debug names. Native single-grid multilayer CUDA emits explicit disabled exchange pairs between object ids so separate objects keep free-surface semantics even though intra-object region defaults use harmonic mean. |
| Ferromagnet + uniform `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Lowered to per-cell vectors for FDM and per-node vectors for FEM |
| Ferromagnet + random `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Deterministic xorshift64 RNG in planner |
| Multiple `Ferromagnet` bodies + global demag | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses multilayer-convolution for eligible z-stacks, with CPU reference, a native CUDA single-grid fast path for compatible stacks, and `cuda-assisted` fallback for the remaining current public scope; staged CPU and CUDA multilayer execute fixed-step Heun, classical RK4, and Bogacki-Shampine RK23 tableaus and explicitly reject adaptive stepping, RK45, and ABM3, while compatible native single-grid CUDA stacks can additionally route fixed-step RK45/ABM3 through the existing single-grid integrators. The assisted CUDA realization is explicitly host-authoritative: its execution provenance records `fdm_multilayer_transfer_telemetry` with measured vector H2D/D2H counts and bytes, so it must not be described as device-resident. The CUDA multilayer paths honor `execution_precision` (`double` and calibrated `single`) across the native fast path and the assisted multilayer demag/explicit-RK runtime. Session capabilities select a multilayer profile and therefore advertise only exchange, Newell demag, Zeeman, uniaxial/cubic anisotropy, and interfacial DMI; thermal, spin torque, Oersted, bulk DMI, magnetoelastic, and CUDA boundary correction remain absent until their planner/runtime scope is executable. FEM merges disjoint mesh assets into one execution plan with body-local exchange and global demag |
| `Exchange` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU 6-point stencil in FDM and lumped-mass P1 operator in FEM |
| `Demag` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM, validation pending for full FEM GPU demag) | FDM uses Newell tensor FFT. Executable FEM includes Poisson airbox (`poisson_robin` / `poisson_dirichlet`) on the MFEM/libCEED/hypre CPU lane and strict MFEM/libCEED/CUDA GPU lane. Strict FEM GPU demag mode is `device_hypre_poisson`: RHS, hypre solve, warm-start, recovery `H_demag`, and demag energy stay device-resident, with `uses_gpu_poisson=true`, `hypre_execution_policy=device`, and no hot-loop demag field/magnetization round-trip. `hybrid_cpu_poisson` is only an explicit compatibility/debug mode and must not be silently selected for `study.device("gpu")`. Initial strict GPU scope is P1, double precision, shared-domain airbox Dirichlet/Robin. High-order and Fredkin-Koehler GPU demag remain gated. The static/time-domain k=0 periodic demag slice has ordinary managed CPU/GPU periodic-antidot relaxation evidence for seam continuity and device-Poisson provenance, but remains below validated production until strict M5 z-padding and primitive-vs-supercell reports pass for the same workload; it may execute only when `ProblemIR.pbc.demag="periodic_airbox_k0"`, the mesh carries `periodic_node_pairs`, `periodic_boundary_pairs`, periodic axes that match `ProblemIR.pbc.axes`, a shared-domain airbox, at least one open axis, and accepted `periodic_pairs.v1` diagnostics proving shared-airbox coverage, magnetic coverage where the magnetic body crosses the selected seam, and opposed-normal boundary-face pairs; selected periodic axes may include `z` for non-fully-periodic cells, while the current antidot qualification fixture remains the film-specific `x/y` periodic, open-`z` case. A historical managed 3x3 primitive-vs-periodic-supercell artifact `.fullmag/reports/fem-demag-periodic-airbox-validation-supercell-pbc/periodic_airbox_validation.csv` passed with `2.4167958871934916e-3` relative energy error against the `2.0e-2` tolerance and zero primitive `H_demag`/`phi` seam mismatch for its fixture; this is supporting evidence for the reduced Poisson path, not current M5 antidot acceptance. Strict GPU k=0 static periodic demag has source-contract support and ordinary managed periodic-antidot GPU gate evidence proving `uses_cuda_kernels=true`, `uses_gpu_poisson=true`, `demag_operator_mode="device_hypre_poisson"`, and zero accepted `H_demag`/normal-flux seam mismatch for `exchange_coupled` and `air_gap`; it must still not be reported as validated production until strict M5 z-padding and primitive-vs-supercell evidence pass. Fully periodic 3D, dynamic frequency-response demag, nonzero-k Floquet magnetostatics, and broader GPU periodic demag remain gated. The public nonzero-k Floquet demag request is `magnetostatic_bc=floquet_airbox`; it is accepted as IR/DSL intent but must fail capability planning until a validated Bloch/Floquet demag-k operator exists. Executable FEM also includes the initial body-only `fredkin_koehler` FEM/BEM open-boundary path in the native MFEM CPU subsystem. Poisson requires a shared-domain mesh with air; `fredkin_koehler` must not require or allocate an airbox and uses the magnetic body boundary surface instead. The Fredkin-Koehler implementation is dense-reference/validation-scale until analytic and cross-model qualification are complete. Native FEM demag exposes an explicit backend-hint `FemLinearSolverPolicy` authoring contract (`CG/GMRES`, `AMG/JACOBI/NONE`, tolerances, iteration cap) while keeping `Demag()` physics-first. For explicit native `poisson_robin`, the managed runtime resolves directly to `hypre_pcg_boomeramg`; live session views preserve requested CPU threads, resolved Rayon threads, and requested/effective OpenMP threads when the native runtime reports them. |
| `InterfacialDMI` / `BulkDMI` | ✅ exec | planned | planned | **public-executable** (FDM); **bounded energy-observation qualification** (FEM GPU); **under-qualification** (FEM frequency response) | CPU FDM computes DMI field/energy in the reference lane and exposes `H_dmi` as a derived snapshot/preview observable. Public multilayer FDM carries global DMI constants through CPU reference observables/RHS, CUDA-assisted local effective fields, native stacked single-grid plans, native stacked scalar/field reporting, and staged multilayer v2 explicit-RK RHS for fixed-step Heun/RK4/RK23. Separate managed uniform-`M_s` native FEM GPU fixtures select interfacial `H_dmi` and bulk `H_dmi_bulk`, and compare `eden_dmi`/`eden_total` with native `E_dmi`/`E_total` at the same source step. That evidence qualifies only the bounded time-evolution energy-observation workload; it does not promote GPU DG0 or every FEM DMI execution surface. The FEM driven frequency-response CPU/GPU P1 tetrahedral tangent DMI slices remain under their separate qualification. Per-layer/per-cell DMI fields remain deferred. |
| `Zeeman` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Public API authors `B`; planner normalizes to `H_ext` in A/m for CPU FDM and CPU FEM |
| `RegionalFieldDrive` / legacy prescribed antenna mask import | CPU reference executable; CUDA unsupported | source-visible planning only; native CPU/GPU consumption unqualified | planned | **mixed current status; see the microwave slice above** | Separate MuMax-style source governed by note 0920 and ADR 0019. It is not a conductor field solve and must not be used as a hidden fallback for `SolvedAntennaDrive`; this summary does not promote any lane beyond the detailed row above. |
| Variable-width 3D microstrip/CPW layout | planned | planned | planned | **planned** | Ordered width/gap stations along current flow, explicit signal/return conductors, and rigid 3D placement; the current constant-width preview does not qualify. |
| `AntennaFieldSolve` Tier 1 | artifact consumer planned | CPU solver planned; GPU unsupported | explicit state transfer planned | **planned** | Native FEM CPU owns the first H1 conduction plus adaptive 3D Biot-Savart solve. `mqs_2p5d_az` does not qualify. |
| `SolvedAntennaDrive` | planned | planned | planned | **planned** | Immutable per-ampere basis multiplied by canonical waveform; lane promotion requires stale-artifact rejection and field/LLG parity. |
| `ThermalNoise` | ✅ exec | planned | planned | **public-executable** (single-grid FDM) | CPU/GPU single-grid FDM execute Brown thermal noise where configured. Public multilayer FDM rejects thermal noise explicitly until staged CPU/GPU multilayer RHS coverage exists, rather than dropping it from `FdmMultilayerPlanIR`. |
| `Magnetoelastic` | planned | planned | planned | **internal-reference** | Small-strain magnetoelastic coupling (B1/B2 cubic, λ_s isotropic); prescribed-strain H_mel wired into H_eff; see `docs/physics/0700-shared-magnetoelastic-semantics.md` |
| `LLG` (Heun) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Heun stepper in `fullmag-engine` |
| LLG explicit fixed | see LLG time-domain evidence overlay | see LLG time-domain evidence overlay | `unsupported` | lane-specific | Existing fixed execution is retained, but `fix_dt` API/IR round-trip is not complete until Task 5. |
| LLG explicit adaptive | `source_visible` | `source_visible` | `unsupported` | **`source_visible`** | RK23/RK45 source exists, but production publication is blocked by findings `LLG-TD-API-001` through `LLG-TD-TEST-011`. |
| LLG timestep qualification registry | implemented, current state `unvalidated` | implemented, current state `unvalidated` | `unsupported` | **fail-closed evidence owner** | Exact lane identity includes integrator and timestep policy. Promotion requires artifact and clean runtime-source hashes, validated scope, timestamp, validator schema, and prerequisite gates; status is exposed unchanged through provenance, API, and Control Room. |
| LLG stiff time-domain | `unsupported` | `unsupported` | `unsupported` | **`unsupported`** | The existing `Relaxation(tangent_plane_implicit)` is an energy minimizer, not full physical-time LLG. No explicit-to-stiff or GPU-to-CPU fallback is legal. |
| `Relaxation(llg_overdamped)` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Shared `StudyIR::Relaxation` with `RelaxStop` and structured execution-owned completion. This is the only relaxation algorithm that owns `dynamics`, RK, `dt`, and a stage-local relaxation clock. |
| `Relaxation(projected_gradient_bb)` | ✅ exec | ✅ exec on `fem_cpu_native` and `fem_native_gpu`, including demag at `rtol<=1e-12` | **planned** | **public-executable** (FDM CPU/reference/CUDA; native FEM CPU/MFEM/CUDA) | Direct minimization with the physical `mu0 Ms V` energy metric, norm-preserving retraction, and native Armijo/BB control. Its accepted line-search step is in `m/A`; it owns no RK, `dt`, physical time, or pseudo-time. FEM demag uses direct polarized increments; no hidden fallback is permitted. Heterogeneous cellwise FDM CUDA material fields remain fail-closed where that lane does not support them. |
| `Relaxation(nonlinear_cg)` | ✅ exec | ✅ exec on `fem_cpu_native` and `fem_native_gpu` | **planned** | **public-executable** (FDM CPU/reference/CUDA; native FEM CPU/MFEM/CUDA) | PR+ direct minimization uses the same physical energy metric, retraction, and Armijo units as PG-BB. Its accepted line-search step is in `m/A`; it owns no RK or time controls. |
| `Relaxation(tangent_plane_implicit)` | unsupported in strict production | CPU/MFEM development-only in extended mode; forced GPU unsupported | **planned** | **under-development** (native FEM CPU/MFEM only) | Strict mode rejects TPI. Extended mode may resolve it only to the CPU/MFEM development lane with explicit requested/resolved provenance and warning. Forced GPU rejects; no hidden GPU-to-CPU fallback or GPU capability claim is permitted. |

| `FrequencyResponse` | semantic-only | reference-executable dense validation path; gated production CPU slice; gated production GPU slice with k=0 demag provider, narrow `periodic_airbox_k0` CPU/GPU Schur/provider slices, plus narrow CPU/GPU nonzero-k Floquet phase-projection smoke | planned | partial production CPU/GPU executable, broader response still gated | First-class `StudyIR::FrequencyResponse` and Python `fm.FrequencyResponse` serialize the driven frequency-domain contract. This is COMSOL-like `Frequency Domain` forced harmonic response, not COMSOL-like `Eigenfrequency`; response peaks are mode candidates, not modal proof. The current runner can execute the dense block-real magnetic frequency-sweep validation path and emit artifact-backed response sweeps, progress, diagnostics, and field payload resources. New production promotion is blocked by the audit P0 contract until the phasor convention, matrix form, dynamic-demag Poisson sign, `Ms`-correct susceptibility/absorbed-power units, damping convention, and tangent-frame transport are implemented and tested. The native MFEM frequency-domain production CPU lane is executable for the gamma-point/free-boundary, k=0 static-periodic magnetic/compacted shared-domain, no-demag nonzero-k Floquet phase-projection, and narrow `periodic_airbox_k0` Schur/provider response slices with exchange, Zeeman, uniform uniaxial anisotropy, CPU dynamic demag through a backend demag-tangent provider, interfacial/bulk DMI on P1 tetrahedra for open/gamma and k=0 static-periodic magnetic slices, uniform or nodal Gilbert damping, matrix-free GMRES, progress telemetry, and partial-artifact cancellation. Narrow CPU and GPU `k=0 periodic_airbox_k0` driven-response slices exist for the antidot/PBC work as matrix-free Schur/phi-consistency provider paths; they are not full assembled coupled `[delta_m, delta_phi]` solvers, not eigenmode/modal solvers, and not nonzero-k demag-k implementations. The native FEM production GPU lane is executable for the gamma-point/free-boundary, k=0 static-periodic magnetic/compacted shared-domain, no-demag nonzero-k Floquet phase-projection, and narrow `periodic_airbox_k0` Schur/provider response slices with exchange, Zeeman, uniform uniaxial anisotropy, P1 interfacial/bulk DMI for open/gamma and k=0 static-periodic magnetic slices when complete element tangent payloads are supplied, uniform or nodal Gilbert damping, native CUDA operator application, matrix-free GMRES, static-periodic tangent projection, `validation_fallback_used=false`, ordinary k=0 dynamic demag through a backend demag-tangent provider, and `periodic_airbox_k0` dynamic demag through the GPU demag tangent-with-potential provider. The nonzero-k Floquet no-demag slice phase-projects local terms plus a supplied exchange-edge tangent operator and is reachable through the Rust native wrapper and the high-level planner/runner when no-demag/no-DMI, magnetic-body or compacted magnetic-slice, and complete pair metadata prerequisites are met. Static-periodic response requires `mesh.periodic_node_pairs` and boundary-pair translation/tolerance diagnostics. The DMI part of the CPU/GPU driven-response slice is wired through the public runner payload and native weak-residual contracts but still requires managed FEM runtime proof before it is promoted to validated production. Full nonzero-k Floquet/Bloch production response with demag, nonzero-k demag-k, frequency-domain elastodynamics, true `periodic_airbox_k0` eigenfrequency/modal solving, coupled eigenmodes, and two-way magnetoelastic response remain explicitly capability-gated. `/v2/sessions/current/analysis/frequency-domain/manifest.v1` exposes nested `frequency_domain_capabilities.v1` for precise UI gating. |
| Execution precision `double` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU reference FDM remains the trusted baseline; FEM executes through the MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU runtimes |
| Execution precision `single` | ✅ exec | planned | planned | **public-executable** (CUDA FDM) | Public CUDA FDM supports calibrated `single` precision across native single-body runs and multilayer CUDA paths; CPU reference FDM remains `double`-only |
| Field/scalar outputs (`m`, `H_ex`, `H_ext`, `H_ani`, `H_dmi`, `H_eff`, `E_ex`, `E_ext`, `E_ani`, `E_dmi`, `E_total`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Common artifact layout for current FDM/FEM executable slices; FDM `H_ani` is exposed by CPU reference, single-grid native CUDA copy/preview/snapshot endpoints, and public multilayer observable paths. FDM `H_dmi` remains CPU/reference plus current public multilayer observable coverage, with broader per-layer/per-cell native DMI still tracked separately. |
| FEM live energy-density preview (`eden_ex`, `eden_demag`, `eden_ext`, `eden_ani`, `eden_dmi`, `eden_total`) | n/a | bounded CPU/GPU exec | planned | **partial-production-executable** | Managed qualification compares each advertised projected term and `eden_total` at source step 52 with the matching native scalar. CPU DG0 covers consistent-mass exchange with optional Poisson demag and Zeeman through `fem_nodal_conservative_tetra_projection`. Four separate uniform-`M_s` GPU fixtures cover uniaxial, cubic, interfacial DMI, and bulk DMI through `fem_nodal_visualization_projection`. Canonical element/quadrature density publication, GPU DG0, and broader interaction combinations remain unsupported or unqualified. |
| FEM demag outputs (`H_demag`, `demag_phi`, `E_demag`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | The MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM lanes emit demag outputs through the same quantity/artifact contract as FDM. Static PBC equilibrium acceptance requires same-step `H_demag` and scalar-potential `demag_phi` field artifacts plus seam checks across explicit periodic node pairs; `demag_phi` is checked after removing the best constant gauge offset per periodic pair id. |
| FDM hints | ✅ exec | n/a | planned | **public-executable** | Cell size → grid dims in planner |
| FEM hints | n/a | ✅ exec | planned | **public-executable** (FEM) | Planner builds `FemPlanIR`; execution currently requires `MeshIR` or external meshing extras |
| Hybrid hints | n/a | n/a | planned | semantic-only | Requires hybrid mode and backend |

All relaxation surfaces use defaults `1e-4 A/m` and `50000` steps. The exact
accepted-state residual is `max_torque_Apm` in `A/m`; `max_torque_T = mu0 *
max_torque_Apm` is its equivalent in `T`, while `max_rhs_norm_per_s` is a
separate dynamic observable in `1/s`. Budget exhaustion is completed but not
converged; numerical stagnation is failed/non-converged. The authoritative
completion record belongs to execution, never to sampled artifacts.

## Early planner rules

- `backend="auto"` resolves to `fdm` for `strict` and `extended` during execution planning.
- `backend="auto"` does not resolve hybrid implicitly.
- Hybrid planning is a deliberate opt-in, not a fallback.

---

## Cross-backend comparison tolerances

### Purpose

FDM and FEM solutions to the same `ProblemIR` will differ numerically due to discretization
differences. Comparisons must be under **physical** tolerances, not bitwise equality.

### Default tolerances

| Metric | Default tolerance | Notes |
|--------|-------------------|-------|
| Exchange energy (relative) | 1% | For meshes refined enough that discretization error is small |
| Effective field L2 norm | 5% | On matched/projected grids; dominated by boundary representation |
| Magnetization L2 norm | 1% | After sufficient relaxation with identical initial conditions |

### Convergence-rate requirement

Tolerance claims require a **convergence-rate study** demonstrating that:

1. The quantity of interest converges with mesh/grid refinement for each backend individually.
2. The FDM and FEM solutions converge to each other as both are refined.
3. The convergence rate is consistent with the expected order of the discretization scheme
   (second-order for FDM 6-point stencil, first- or second-order for FEM depending on element order).

Without a completed convergence study, comparison results are informational only and must not
be used as acceptance criteria.

### Comparison methodology

- **Grid matching**: FDM cell centers must be projected onto FEM nodes (or vice versa) using
  nearest-neighbor or interpolation. The projection scheme must be documented.
- **Boundary handling**: Boundary cells/nodes may be excluded from L2 norms if the geometric
  representation differs significantly between FDM voxels and FEM elements.
- **Time alignment**: Comparisons must be at identical simulation times. If adaptive stepping
  is used, outputs must be interpolated to common time points.
- **Reproducibility**: Comparison scripts must be deterministic and checked into the repository.
