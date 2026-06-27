# Production FEM Interior-Window Eigensolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Date: 2026-06-15

Status: implementation playbook, not an executable production capability yet

Goal: implement a COMSOL-class production FEM modal eigensolver for large
interior frequency windows while keeping modal eigen analysis strictly separate
from driven frequency-domain response.

Architecture: Fullmag must have one shared linearized-LLG operator contract and
two separate solver products. `Eigenmodes` solves a homogeneous eigenproblem and
returns normal modes. `FrequencyResponse` solves a forced harmonic linear
system and returns complex response at requested drive frequencies. They share
equilibrium, tangent basis, interaction derivatives, demag realization, phase
convention, artifact conventions, and validation fixtures; they do not share
solver entrypoints, stop reasons, UI labels, or capability status.

Tech stack: native FEM under `backends/fem` with MFEM/hypre/libCEED, PETSc/SLEPc
or equivalent sparse eigensolver stack, Rust runner orchestration, canonical
Python DSL and `ProblemIR`, v2 resource-first API, Control Room React modules,
Zarr heavy payloads, JSON control-plane artifacts, container-backed `just`
runtime verification.

---

## 0. Executive Decision: Split Modal Eigensolve From Driven Frequency Domain

### 0.1 Why This Matters

COMSOL separates these products because the mathematical problems are different:

```text
Eigenmode / Eigenfrequency:
  A q = lambda B q
  no drive vector
  output: eigenfrequencies, eigenvectors, modal residuals

Driven Frequency Domain:
  (i omega B - A) q(omega) = b(omega)
  explicit drive vector
  output: forced complex response, susceptibility, absorbed power, phase maps
```

Fullmag must preserve the same product distinction.

The existing masterplan folder is a "frequency-domain FEM" umbrella because
both products use linearized frequency-domain physics. That umbrella must not
cause API, UI, or backend naming to collapse the two solvers into one path.

### 0.2 Canonical Naming

Use these names consistently:

| Product | Public study | Backend family | Primary result |
|---|---|---|---|
| Modal eigensolve | `Eigenmodes` | `fem_modal_eigen` | spectrum, modes, dispersion |
| Driven harmonic response | `FrequencyResponse` | `fem_frequency_response` | response sweep, susceptibility, absorbed power |
| Shared operator contract | not a public study | `fem_linearized_llg_operator` | operator diagnostics |

Do not call eigenmodes "the frequency-domain solver" in product UI. It is a
modal solver under the frequency-domain analysis family.

### 0.3 Required Tree Separation

Production backend layout must make the split visible:

```text
backends/fem/
  include/frequency_domain/
    frequency_domain_contract.hpp       existing shared public contract
    operator_contract.hpp               existing shared operator contract
    operator_terms.hpp                  existing shared term contract
    tangent_frame.hpp                   existing tangent basis contract
    equilibrium_state.hpp               existing equilibrium contract
    driven_response_solver.hpp          existing driven response contract
    solver_progress.hpp                 create shared progress contract
    modal_eigen_solver.hpp              create modal-only solver contract
    modal_eigen_request.hpp             create modal-only request contract
    modal_eigen_result.hpp              create modal-only result contract
  src/frequency_domain/
    frequency_domain_contract.cpp       existing C ABI / contract glue
    operator_contract.cpp               existing shared operator glue
    operator_terms.cpp                  existing shared term glue
    tangent_frame.cpp                   existing shared tangent implementation
    equilibrium_state.cpp               existing equilibrium implementation
    driven_response_solver.cpp          existing driven response glue
    solver_progress.cpp                 create shared progress glue
    modal_eigen_solver.cpp              create modal-only glue
  cpu/frequency_domain/
    mfem_operator_context.cpp           existing MFEM operator context
    mfem_linearized_operator.cpp        existing MFEM linearized operator
    mfem_tangent_space.cpp              existing tangent-space machinery
    mfem_exchange_operator.cpp          existing exchange term
    mfem_zeeman_operator.cpp            existing Zeeman term
    mfem_dmi_operator.cpp               existing DMI term
    dense_driven_response.cpp           existing dense response reference
    production_cpu_driven_response.cpp  existing driven response lane
    production_cpu_modal_eigen.cpp      create modal production lane
    slepc_modal_eigen.cpp               create modal SLEPc adapter
    spectral_transform.cpp              create modal shift-invert adapter
    window_partition.cpp                create modal window orchestration
    mode_filter.cpp                     create modal physical filters
    mode_deduplication.cpp              create modal duplicate removal
    modal_artifact_writer.cpp           create modal artifacts
    response_artifact_writer.cpp        create response artifacts if absent
  tests/frequency_domain/
    frequency_domain_contract.cpp       existing contract test
    operator_contract_test.cpp          create or extend
    modal_eigen_contract_test.cpp       create modal-only test
    driven_response_contract_test.cpp   create response-only test
```

Rules:

- `operator/` contains shared physics and numerical operator construction.
- modal production files contain homogeneous eigensolve only.
- driven response files contain forced response only.
- Rust runner calls separate native entrypoints for modal and response.
- Control Room renders separate Explorer nodes and separate inspectors.
- Do not create a parallel `backends/fem/cpu/mfem/frequency_domain` tree. The
  current native FEM spine is `backends/fem/cpu/frequency_domain` plus
  `backends/fem/src/frequency_domain`; new files must extend that spine.

---

## 1. Mathematical Contract

### 1.1 Shared Linearized LLG Operator

The static state is:

```text
m(r, t) = m0(r) + Re[delta_m(r) exp(i omega t)]
|m0(r)| = 1
m0(r) dot delta_m(r) = 0
```

Use SI units:

```text
gamma     rad s^-1 T^-1
mu0       T m A^-1
gamma0    rad s^-1 (A/m)^-1, defined as mu0 * |gamma|
H_eff     A/m
B_ext     T at public API when authored as flux density
H_ext     A/m inside solver, H_ext = B_ext / mu0
omega     rad/s
f         Hz, f = omega / (2*pi)
```

The undamped linearized equation is:

```text
d delta_m / dt =
  -gamma0 * P_T( m0 x delta_H[delta_m] + delta_m x H0 )
```

where:

- `P_T` projects onto the tangent plane of `m0`;
- `H0 = H_eff[m0]`;
- `delta_H[delta_m]` is the Frechet derivative of the effective field;
- `delta_m` is dimensionless.

After tangent projection with two tangent components per magnetic node:

```text
delta_m_i = q_{2i} * e1_i + q_{2i+1} * e2_i
```

the shared operator exposes:

```text
L q = tangent linearized RHS
M q = tangent mass application
```

### 1.2 Modal Eigenproblem

The modal solver must publish one mathematical form even if the native backend
uses an algebraically equivalent block realization. The canonical continuous
problem is:

```text
L q = lambda M q
lambda = i * omega       for complex first-order form
frequency_hz = Re(omega) / (2*pi)
```

The first production lane uses the undamped gyrotropic real block pencil. This
is the implementation target for the first COMSOL-class modal milestone:

```text
G q_dot = -K q
K phi = omega G phi
```

where:

- `q` has two tangent components per magnetic node;
- `K` is the symmetric tangent Hessian of magnetic energy in SI units;
- `G` is the skew-symmetric gyrotropic tangent mass operator;
- `omega` is real for the undamped conservative lane;
- accepted physical frequencies use `frequency_hz = abs(omega) / (2*pi)`;
- the solver keeps only the positive-frequency representative of each
  conjugate pair.

Native implementation may use any of these equivalent algebraic forms, but the
choice must be recorded in diagnostics:

```text
form = "gyrotropic_generalized"
  K phi = omega G phi

form = "first_order_complex"
  L q = lambda M q, lambda = i omega

form = "real_hamiltonian_block"
  H y = omega B y
```

The first production implementation must not silently mix these forms. It must
choose one internal form per run and write:

```text
omega_rad_s
frequency_hz
eigenvalue_real
eigenvalue_imag
algebraic_form
positive_frequency_pair_index
discarded_negative_frequency_partner
```

The solver accepts a mode only when:

```text
frequency_min_hz <= frequency_hz <= frequency_max_hz
relative_residual <= residual_tolerance
tangent_leakage_max_abs <= tangent_leakage_tolerance
mode payload contains finite numbers
```

### 1.3 Driven Frequency Response

The driven solver solves:

```text
(i omega M - L) q(omega) = b(omega)
```

with explicit drive phasor `b(omega)`.

Driven response outputs:

- complex `delta_m(omega)`;
- response amplitude and phase;
- susceptibility tensor or drive-projected susceptibility;
- absorbed power density;
- per-frequency linear residual.

No modal eigenvector is required for driven response. Modal projections may be
added later as postprocessing, but they must not replace the direct forced
solve.

### 1.4 Damping Convention

Initial modal production lane:

```text
damping_policy = "ignore"
```

This lane solves the conservative undamped modal problem and returns real
frequencies. If a real block form is used, the plan must prove that the block
operator is algebraically equivalent to the canonical gyrotropic tangent
linearization above. It must not call a nonsymmetric first-order pencil
"Hermitian" unless the actual transformed operator is self-adjoint under the
documented weighted inner product.

Later non-Hermitian modal lane:

```text
time dependence: exp(-i omega_complex t)
omega_complex = omega_r - i Gamma
frequency_hz = omega_r / (2*pi)
linewidth_fwhm_hz = Gamma / pi
Q = omega_r / (2*Gamma)
```

Driven response may include Gilbert damping earlier because the harmonic linear
system naturally contains the `i omega alpha m0 x delta_m` term.

### 1.5 FEM Weak Form and Units

The implementation must derive every native matrix/vector from the FEM weak
form. Do not implement the modal operator as an ad hoc nodal finite-difference
stencil over an FEM mesh.

For magnetic domain `Omega_m`, tangent test function `eta`, tangent trial
function `xi`, and equilibrium magnetization `m0`, define:

```text
delta_m = T q
eta     = T p
T_i     = [e1_i e2_i]  at node i
```

The material-weighted tangent mass is:

```text
M_t(p, q) = integral_Omega_m Ms(r) * eta(r) dot xi(r) dV
```

Units:

```text
Ms              A/m
eta, xi         dimensionless
dV              m^3
M_t             A m^2
```

The gyrotropic bilinear form is:

```text
G_t(p, q) = integral_Omega_m (Ms(r) / gamma0) *
            eta(r) dot (m0(r) x xi(r)) dV
```

Units:

```text
gamma0          rad s^-1 (A/m)^-1
G_t             A^2 s m / rad
```

The tangent energy Hessian is assembled from second variation terms:

```text
K_t(p, q) = d^2 E[m0](eta, xi)
```

with energy units Joule. The effective-field relation must remain:

```text
delta E = -mu0 * integral_Omega_m Ms H_eff dot delta_m dV
```

Therefore any field derivative implementation must pass this consistency
identity:

```text
p^T K q =
  -mu0 * integral_Omega_m Ms eta dot delta_H[xi] dV
  plus constraint/equilibrium terms required by tangent projection
```

Supported first production finite elements:

```text
magnetization space: H1 vector P1 on tetrahedra
tangent unknowns: two scalar P1 coefficients per magnetic node
material fields: elementwise constant or nodal P1 where already supported
quadrature: at least order 2 for P1 exchange/Zeeman/anisotropy;
            higher order for DMI/demag terms when needed by existing FEM terms
```

Exchange weak form:

```text
E_ex = integral_Omega_m A_ex |grad m|^2 dV
K_ex(eta, xi) = 2 * integral_Omega_m A_ex grad eta : grad xi dV
```

Units:

```text
A_ex       J/m
grad       1/m
K_ex       J
```

Uniaxial anisotropy weak form for unit axis `u`:

```text
E_ani = integral_Omega_m K_u * (1 - (m dot u)^2) dV
K_ani(eta, xi) = -2 * integral_Omega_m K_u *
                 (eta dot u) * (xi dot u) dV
```

Zeeman contribution to the Hessian is zero for a fixed external field, but the
equilibrium field enters the tangent projected linearization through the
constraint term. The implementation must document where this term is applied so
that a uniform macrospin Kittel test passes.

DMI weak form must reuse the existing FEM DMI weak-residual contract. Modal DMI
must not introduce a new sign convention. The DMI tangent operator is accepted
only when the directional derivative of the existing DMI residual matches a
finite-difference derivative within the validation tolerance.

### 1.6 Dynamic Demag Linearization

Demag in modal and response solvers is the Frechet derivative of the stray
field with respect to `delta_m`, evaluated at the equilibrium mesh and boundary
model:

```text
delta_H_demag[xi] = -grad(delta_phi)
div(-grad(delta_phi)) = div(Ms * xi)   in magnetic domain
```

The first production modal lane may support only `k = 0` and free/static
boundary semantics. It must still state the demag model explicitly:

```text
demag_model = "poisson_airbox_dirichlet" | "poisson_airbox_robin" |
              "fem_bem_fredkin_koehler"
dynamic_demag_k = [0, 0, 0]
```

For Poisson airbox demag:

- source is `div(Ms * xi)` assembled from tangent trial functions;
- boundary condition is inherited from the static demag configuration;
- airbox mesh and magnetic mesh coupling are recorded in diagnostics;
- Poisson residual tolerance must be stricter than the target modal residual by
  at least one decade;
- the demag solve residual is written per operator application in sampled
  diagnostics, not only in a final text log.

For FEM/BEM demag:

- the boundary integral realization must be recorded as the demag model;
- single-layer/double-layer sign convention must match the static FEM/BEM
  contract;
- symmetry of the demag Hessian must be tested by `p^T K_demag q` versus
  `q^T K_demag p` for undamped k=0 cases.

Nonzero-k Floquet dynamic demag remains unsupported until a separate physics
note and validation suite define the dynamic demag-k operator. The production
modal planner must fail clearly if the user requests a nonzero-k modal window
with demag enabled before that model exists.

### 1.7 Equilibrium Acceptance and Error Budget

The modal solver must reject a bad equilibrium instead of normalizing it away.
Tangent-frame construction may normalize `m0` for numerical stability only
after diagnostics have measured the raw input.

Required equilibrium diagnostics:

```text
max_norm_error       = max_i abs(|m0_i| - 1)
rms_norm_error       = sqrt(mean_i (|m0_i| - 1)^2)
max_torque_T         = max_i |m0_i x H_eff_i| in Tesla-equivalent units
rms_torque_T         = sqrt(mean_i |m0_i x H_eff_i|^2)
material_weighted_torque =
  sqrt(integral Ms |m0 x H_eff|^2 dV / integral Ms dV)
```

Initial acceptance targets:

```text
max_norm_error <= 1e-6
rms_norm_error <= 1e-8
max_torque_T <= user_tolerance_or_1e-3_T
material_weighted_torque <= user_tolerance_or_1e-4_T
```

These numbers are starting gates, not final scientific claims. The validation
reports must record observed frequency drift when the torque tolerance is
varied by one decade. A production promotion cannot happen until the report
shows that the chosen equilibrium gate keeps frequency errors below the stated
modal validation tolerance for the reference cases.

### 1.8 Mode Normalization, Gauge, and Degeneracy

For conservative undamped modes, normalize accepted modes with the documented
positive energy or mass convention:

```text
q_i^T M_t q_i = 1
```

If the internal eigenvector is complex, publish:

```text
mass_norm_complex = q^H M_t q
phase_gauge = "largest_component_real_positive"
phase_anchor_dof = index of largest |q_j|
```

Gauge fixing:

- find the component with largest complex magnitude;
- multiply the eigenvector by a unit complex phase so that this component is
  real and positive;
- if two components tie within machine tolerance, choose the lowest global DOF
  index for reproducibility.

Degeneracy handling:

- modes whose frequencies differ by less than
  `degenerate_frequency_tolerance_hz` form a degenerate cluster;
- within a cluster, do not claim stable individual ordering from one run to the
  next;
- publish a stable `degenerate_cluster_id`;
- compute the subspace overlap matrix against dense/reference modes when
  validating;
- UI mode tracking may use cluster identity plus modal overlap, not index alone.

For the later damped non-Hermitian lane, normalization must move to
biorthogonal left/right vectors:

```text
v_i^H B u_j = delta_ij
```

That lane is out of scope for the first production promotion and must remain
capability-gated until implemented.

### 1.9 Window Completeness Contract

A request like "20 modes between 100 MHz and 5 GHz" has two separate meanings:

```text
frequency_window = [100e6, 5e9] Hz
max_returned_modes = 20
completeness_policy = "best_effort" | "certified_count"
```

For `best_effort`, the solver may return the first 20 accepted modes it finds,
but diagnostics must say that additional modes may exist in the interval.

For `certified_count`, the solver must estimate or certify the number of
eigenvalues in the interval. Acceptable certification mechanisms:

- inertia count for a symmetric/Hamiltonian transformed pencil when available;
- contour integral eigenvalue count;
- dense oracle count for small validation systems;
- independent overlapping shift check with no missed accepted modes.

The UI must show the distinction:

```text
Requested: first 20 modes in 100 MHz - 5 GHz
Found: 20 accepted
Window completeness: not certified, more modes may exist
```

or:

```text
Requested: all modes in 100 MHz - 5 GHz, cap 20
Certified count: 18
Returned: 18 accepted
Window completeness: certified
```

This prevents the product from implying that "first 20" means "all physical
modes in the window".

---

## 2. Repository File Map

### 2.1 New Native Files

Create if absent, otherwise extend the existing owner file:

```text
backends/fem/include/frequency_domain/operator_contract.hpp
backends/fem/include/frequency_domain/equilibrium_state.hpp
backends/fem/include/frequency_domain/tangent_frame.hpp
backends/fem/include/frequency_domain/solver_progress.hpp
backends/fem/include/frequency_domain/modal_eigen_solver.hpp
backends/fem/include/frequency_domain/modal_eigen_request.hpp
backends/fem/include/frequency_domain/modal_eigen_result.hpp
backends/fem/include/frequency_domain/driven_response_solver.hpp
backends/fem/src/frequency_domain/solver_progress.cpp
backends/fem/src/frequency_domain/modal_eigen_solver.cpp
backends/fem/cpu/frequency_domain/mfem_tangent_space.cpp
backends/fem/cpu/frequency_domain/mfem_operator_context.cpp
backends/fem/cpu/frequency_domain/mfem_linearized_operator.cpp
backends/fem/cpu/frequency_domain/mfem_exchange_operator.cpp
backends/fem/cpu/frequency_domain/mfem_zeeman_operator.cpp
backends/fem/cpu/frequency_domain/mfem_dmi_operator.cpp
backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp
backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp
backends/fem/cpu/frequency_domain/spectral_transform.cpp
backends/fem/cpu/frequency_domain/window_partition.cpp
backends/fem/cpu/frequency_domain/mode_filter.cpp
backends/fem/cpu/frequency_domain/mode_deduplication.cpp
backends/fem/cpu/frequency_domain/modal_artifact_writer.cpp
backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp
backends/fem/cpu/frequency_domain/response_artifact_writer.cpp
backends/fem/tests/frequency_domain/operator_contract_test.cpp
backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
backends/fem/tests/frequency_domain/driven_response_contract_test.cpp
backends/fem/tests/frequency_domain/window_partition_test.cpp
backends/fem/tests/frequency_domain/mode_deduplication_test.cpp
```

Several shared files already exist under `backends/fem/include/frequency_domain`,
`backends/fem/src/frequency_domain`, and `backends/fem/cpu/frequency_domain`.
Extend those files where the existing responsibility matches. Create only the
listed modal-specific files that are absent. Modify `backends/fem/CMakeLists.txt`
to register new sources. Do not create a second build system and do not create a
parallel `cpu/mfem` tree.

### 2.2 Rust Files

Modify:

```text
crates/fullmag-ir/src/study.rs
crates/fullmag-ir/src/plan.rs
crates/fullmag-ir/src/lib.rs
crates/fullmag-plan/src/fem.rs
crates/fullmag-runner/src/native_fem.rs
crates/fullmag-runner/src/native_fem/plan.rs
crates/fullmag-runner/src/dispatch.rs
crates/fullmag-runner/src/fem_eigen.rs
crates/fullmag-runner/src/frequency_response.rs
crates/fullmag-runner/src/artifacts.rs
crates/fullmag-runner/src/types.rs
crates/fullmag-api/src/schemas/runtime.rs
crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs
crates/fullmag-api/src/router_v2/handlers/analysis/response.rs
```

Create if absent:

```text
crates/fullmag-runner/src/fem/frequency_domain/mod.rs
crates/fullmag-runner/src/fem/frequency_domain/modal.rs
crates/fullmag-runner/src/fem/frequency_domain/response.rs
crates/fullmag-runner/src/fem/frequency_domain/progress.rs
```

### 2.3 Python and UI Files

Modify:

```text
packages/fullmag-py/src/fullmag/model/study.py
packages/fullmag-py/src/fullmag/world.py
packages/fullmag-py/src/fullmag/runtime/script_builder.py
packages/fullmag-py/src/fullmag/runtime/scene_document.py
apps/control-room/src/modules/inspector/panels/stages/EigenmodesStageInspector.tsx
apps/control-room/src/modules/inspector/panels/stages/FrequencyResponseStageInspector.tsx
apps/control-room/src/modules/inspector/panels/StudyPipelineSection.tsx
apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts
apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts
apps/control-room/src/kernel/api/generated/openapi-v2.json
apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
```

Do not add direct React `fetch()` calls. All data access must go through the v2
API facade and resource hooks.

### 2.4 Current-State Reconciliation

Before implementation starts, the first PR must reconcile the plan against the
current tree. The implementation must not create a second frequency-domain
stack.

Current native frequency-domain spine already present:

```text
backends/fem/include/frequency_domain/frequency_domain_contract.hpp
backends/fem/include/frequency_domain/operator_contract.hpp
backends/fem/include/frequency_domain/operator_terms.hpp
backends/fem/include/frequency_domain/tangent_frame.hpp
backends/fem/include/frequency_domain/equilibrium_state.hpp
backends/fem/include/frequency_domain/driven_response_solver.hpp
backends/fem/src/frequency_domain/frequency_domain_contract.cpp
backends/fem/src/frequency_domain/operator_contract.cpp
backends/fem/src/frequency_domain/operator_terms.cpp
backends/fem/src/frequency_domain/tangent_frame.cpp
backends/fem/src/frequency_domain/equilibrium_state.cpp
backends/fem/src/frequency_domain/driven_response_solver.cpp
backends/fem/cpu/frequency_domain/mfem_operator_context.cpp
backends/fem/cpu/frequency_domain/mfem_linearized_operator.cpp
backends/fem/cpu/frequency_domain/mfem_tangent_space.cpp
backends/fem/cpu/frequency_domain/mfem_exchange_operator.cpp
backends/fem/cpu/frequency_domain/mfem_zeeman_operator.cpp
backends/fem/cpu/frequency_domain/mfem_dmi_operator.cpp
backends/fem/cpu/frequency_domain/dense_driven_response.cpp
backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp
```

Current API/resource paths already present in generated v2 paths:

```text
/v2/sessions/current/analysis/frequency-domain/manifest.v1
/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2
/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2
/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2
/v2/sessions/current/analysis/frequency-domain/eigen/dispersion
/v2/sessions/current/analysis/frequency-domain/response/progress.v1
/v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1
/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep
/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1
```

Current capability matrix already states:

```text
StudyIR::FrequencyResponse:
  partial_production_executable for native FEM CPU gamma/free-boundary and
  k=0 static-periodic magnetic slice; broader response still gated.
```

Therefore this plan does not create `FrequencyResponse` from zero. It adds:

- production modal interior-window eigensolve;
- stronger shared operator contracts needed by modal eigensolve;
- improved artifact/API separation between modal and response;
- capability-status deltas that keep the existing driven response status intact;
- validation that prevents modal progress from being shown as response progress
  or vice versa.

Implementation rule:

```text
If an existing file already owns the responsibility, extend it.
If no existing file owns the responsibility, create the named modal-specific file.
Never fork existing frequency-domain contracts into a new namespace.
```

### 2.5 Capability Delta Table

| Capability row | Current status | Target change in this plan |
|---|---|---|
| `StudyIR::FrequencyResponse` | partial production CPU slice for limited native FEM response | keep status, add clearer UI/API separation and response schemas |
| `FrequencyResponse` broad demag/nonzero-k/GPU | gated/unsupported | unchanged unless a response milestone explicitly validates it |
| `StudyIR::Eigenmodes` dense FEM reference | reference/MVP path | keep as small-system oracle |
| `FEM modal interior-window eigensolve` | semantic/design target | promote only after native CPU shift-invert, diagnostics, artifacts, and validation |
| `FEM modal contour/FEAST interval solve` | planned | separate optional production lane after shift-invert |

No implementation PR may promote capability status as a side effect of wiring
schemas or UI. Promotion requires the validation gates in Milestone 11.

### 2.6 First PR Scope Boundary

The first implementation PR after this plan must be documentation/contract only:

- update physics notes with the modal/response split;
- update capability matrix with modal interior-window row;
- update artifact spec with exact modal diagnostics schema;
- add or update docs validation script;
- do not modify native solver behavior.

This prevents a large solver patch from also silently redefining public
semantics.

---

## 3. Milestone 0 - Product Split and Contract Freeze

### Objective

Make the repository unambiguous: modal eigen and driven response are separate
study products sharing one linearized operator contract.

### Files

Modify:

```text
docs/physics/0700-frequency-domain-linearized-llg.md
docs/physics/frequency_domain_solver_physics.md
docs/physics/0600-fem-eigenmodes-linearized-llg.md
docs/specs/capability-matrix-v0.md
docs/specs/frequency-domain-artifacts-v2.md
docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/01-backend-native-fem-frequency-domain.md
```

### Implementation Steps

- [x] Add a "Product Split" section to `docs/physics/0700-frequency-domain-linearized-llg.md`.
- [x] State that `Eigenmodes` solves `A q = lambda B q`.
- [x] State that `FrequencyResponse` solves `(i omega B - A) q = b`.
- [x] State that both products use `gamma0 = mu0 * |gamma|`.
- [x] State that both products use tangent variables, not unconstrained 3D
      variables.
- [x] Add a capability row for `FEM modal interior-window eigensolve`.
- [x] Keep its status `semantic_only` until the production native path passes
      managed runtime validation.
- [x] Add a separate row for `FEM driven frequency response`.
- [x] Ensure the response row does not inherit modal eigensolver status.
- [x] Update artifact docs with `eigen/diagnostics/solver.v1.json`.
- [x] Update artifact docs with `response/diagnostics/solver.v1.json`.
- [x] Add a rule that `frequency_domain/manifest.v1.json` must include
      `study_product = "modal_eigen"` or `study_product = "driven_response"`.
- [x] Add a rule that UI labels must use "Eigenmodes" and "Frequency Response"
      separately.

### Exact Artifact Fields

Modal manifest fields:

```json
{
  "schema_version": "frequency_domain_manifest.v1",
  "analysis_family": "magnetic_frequency_domain",
  "study_product": "modal_eigen",
  "stage_kind": "eigenmodes",
  "phase_convention": "exp_i_omega_t",
  "frequency_units": "Hz",
  "field_units": "dimensionless_delta_m"
}
```

Driven response manifest fields:

```json
{
  "schema_version": "frequency_domain_manifest.v1",
  "analysis_family": "magnetic_frequency_domain",
  "study_product": "driven_response",
  "stage_kind": "frequency_response",
  "phase_convention": "exp_i_omega_t",
  "frequency_units": "Hz",
  "field_units": "dimensionless_delta_m"
}
```

### Tests

- [x] Add markdown consistency test under the existing docs test mechanism if
      present. If no docs test exists, add a Python script:
      `scripts/validate_frequency_domain_product_split.py`.
- [x] Script checks that all docs contain both `modal_eigen` and
      `driven_response`.
- [x] Script checks that capability matrix has separate rows for modal and
      driven response.
- [x] Script fails if `Eigenmodes` is described as "the frequency-domain
      solver" without the word "modal".

Command:

```bash
python3 scripts/validate_frequency_domain_product_split.py
```

Expected:

```text
frequency-domain product split docs are consistent
```

### Acceptance Criteria

- Modal and driven response are separate in docs, capability vocabulary,
  manifests, and UI naming.
- No capability row implies that modal eigen production readiness makes driven
  response production-ready.
- No capability row implies that driven response production readiness makes
  modal eigen production-ready.

---

## 4. Milestone 1 - Dense Oracle Diagnostics

### Objective

Make the existing dense/reference modal solver a trustworthy oracle before
building the production solver.

### Files

Modify:

```text
crates/fullmag-runner/src/fem_eigen.rs
crates/fullmag-runner/src/artifacts.rs
crates/fullmag-runner/tests/physics_validation.rs
scripts/verify_fem_frequency_domain_eigen_artifacts.py
docs/specs/frequency-domain-artifacts-v2.md
```

### Implementation Steps

- [x] Keep dense solve as reference-only for small systems.
- [x] For every exported mode, compute generalized residual:

```text
r = K u - lambda M u
relative_residual = ||r||_2 / (||K u||_2 + |lambda| * ||M u||_2)
```

- [x] Export `residual_absolute_l2`.
- [x] Export `residual_relative_l2`.
- [x] Export `residual_linf`.
- [x] Compute tangent leakage for real and imaginary reconstructed fields:

```text
leak_i = abs(m0_i dot delta_m_i)
tangent_leakage_mean_abs = mean(leak_i)
tangent_leakage_max_abs = max(leak_i)
```

- [x] Export mass norm:

```text
mass_norm = u^T M u
```

- [x] Export orthogonality for dense oracle:

```text
orthogonality_ij = u_i^T M u_j
```

- [x] Store `omega_rad_s`.
- [x] Store `frequency_hz`.
- [x] Store `gamma_rad_s_T`.
- [x] Store `gamma0_rad_s_per_A_m`.
- [x] Store `mu0_T_m_per_A`.
- [x] Add `solver_diagnostics` section to `eigen/metadata/eigen_summary.json`.
- [x] Update verifier to reject missing residual diagnostics for dense oracle.

### Exact Rust Helper Signatures

Add or refine helpers in `crates/fullmag-runner/src/fem_eigen.rs`:

```rust
fn generalized_relative_residual(
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    eigenvalue: f64,
    vector: &DVector<f64>,
) -> f64
```

```rust
fn tangent_leakage_summary(
    equilibrium: &[Vector3],
    mode_vectors: &[Vector3],
) -> TangentLeakageSummary
```

```rust
#[derive(Debug, Clone, Copy)]
struct TangentLeakageSummary {
    mean_abs: f64,
    max_abs: f64,
}
```

### Tests

- [x] Add test `dense_eigen_exports_relative_residuals`.
- [x] Add test `dense_eigen_exports_tangent_leakage`.
- [x] Add test `dense_eigen_frequency_units_are_hz_and_rad_s`.
- [x] Add test `macrospin_kittel_frequency_order_of_magnitude`.
- [x] Add verifier case with missing `residual_relative_l2`; expected failure.
- [x] Add verifier case with missing `omega_rad_s`; expected failure.

Commands:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner dense_eigen
python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py .fullmag/reports/frequency-domain-eigen-runtime/artifacts
```

Expected:

```text
all dense eigen diagnostics tests pass
```

### Acceptance Criteria

- Dense oracle reports residual, tangent leakage, mass norm, and unit metadata.
- Artifact verifier treats missing diagnostics as invalid.
- Dense oracle remains explicitly non-production for large systems.

---

## 5. Milestone 2 - Native Frequency-Domain Contract Skeleton

### Objective

Create native FEM contracts for shared operator, modal eigen, and driven
response without implementing the solver yet.

### Files

Create:

```text
backends/fem/include/frequency_domain/operator_contract.hpp
backends/fem/include/frequency_domain/modal_eigen_request.hpp
backends/fem/include/frequency_domain/modal_eigen_result.hpp
backends/fem/include/frequency_domain/modal_eigen_solver.hpp
backends/fem/include/frequency_domain/driven_response_solver.hpp
backends/fem/include/frequency_domain/solver_progress.hpp
backends/fem/src/frequency_domain/modal_eigen_solver.cpp
backends/fem/src/frequency_domain/solver_progress.cpp
backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp
backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp
backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
backends/fem/tests/frequency_domain/driven_response_contract_test.cpp
```

Modify:

```text
backends/fem/src/api.cpp
native/include/fullmag_fem.h
crates/fullmag-fem-sys/src/lib.rs
crates/fullmag-runner/src/native_fem.rs
```

### C++ Request Structures

Use explicit SI field names:

```cpp
struct FullmagFemLinearizedOperatorRequest {
  uint32_t abi_version;
  const char* mesh_asset_id;
  const char* equilibrium_source_kind;
  double gamma_rad_s_T;
  double mu0_T_m_A;
  double alpha;
  int include_exchange;
  int include_demag;
  const char* demag_realization;
  const char* damping_policy;
  const char* spin_wave_bc_kind;
  const double* k_vector_rad_m;
  int k_vector_len;
  const char* operator_diagnostics_json;
};
```

```cpp
struct FullmagFemModalEigenRequest {
  uint32_t abi_version;
  FullmagFemLinearizedOperatorRequest operator_request;
  int requested_mode_count;
  const char* target_kind;
  double target_frequency_hz;
  double frequency_min_hz;
  double frequency_max_hz;
  double residual_tolerance;
  int max_outer_iterations;
  int max_linear_iterations;
  const char* output_directory;
  int write_partial_artifacts;
  int completeness_policy;
  int eigensolver_family;
  int spectral_transform_kind;
  void* cancel_user_data;
  int (*cancel_requested)(void* user_data);
  void* progress_user_data;
  void (*progress_callback)(
    void* user_data,
    const char* progress_json
  );
};
```

```cpp
struct FullmagFemDrivenResponseRequest {
  uint32_t abi_version;
  FullmagFemLinearizedOperatorRequest operator_request;
  const double* frequencies_hz;
  int frequency_count;
  const double* excitation_field_A_m;
  int excitation_field_len;
  double excitation_phase_rad;
  double residual_tolerance;
  int max_linear_iterations;
  const char* output_directory;
  int write_partial_artifacts;
  void* cancel_user_data;
  int (*cancel_requested)(void* user_data);
  void* progress_user_data;
  void (*progress_callback)(
    void* user_data,
    const char* progress_json
  );
};
```

### FFI Status Contract

Add:

```cpp
enum FullmagFemFrequencyDomainStatus {
  FULLMAG_FEM_FD_OK = 0,
  FULLMAG_FEM_FD_UNAVAILABLE = 1,
  FULLMAG_FEM_FD_VALIDATION_ERROR = 2,
  FULLMAG_FEM_FD_OPERATOR_ERROR = 3,
  FULLMAG_FEM_FD_SOLVE_ERROR = 4,
  FULLMAG_FEM_FD_ARTIFACT_ERROR = 5,
  FULLMAG_FEM_FD_INTERRUPTED = 6
};
```

Result boundary:

```cpp
struct FullmagFemFrequencyDomainResult {
  uint32_t abi_version;
  FullmagFemFrequencyDomainStatus status;
  char* error_message;
  char* diagnostics_json;
  char* result_json;
  char* artifact_manifest_path;
};
```

### ABI and Lifetime Rules

ABI version:

```text
FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION = 1
```

Rules:

- every public request/result struct starts with `uint32_t abi_version`;
- native entrypoints reject unknown ABI versions with
  `FULLMAG_FEM_FD_VALIDATION_ERROR`;
- all input pointers are borrowed for the duration of the call only;
- all output strings are allocated by native FEM and released only by
  `fullmag_fem_frequency_domain_result_destroy`;
- Rust bindings must copy output strings before destroying the native result;
- result destruction must be idempotent for a zeroed result;
- progress callback strings are borrowed for the duration of the callback only;
- callbacks must not call back into native FEM on the same context;
- solver entrypoints are reentrant across different backend handles, but not
  concurrently reentrant on the same mutable FEM context;
- `output_directory` is required for any request with `write_partial_artifacts`;
- solver must create artifacts atomically using temporary files plus rename;
- cancellation must be checked before factorization, between outer iterations,
  between frequency points, and before final artifact publication.

Progress callback payload schema:

```json
{
  "schema_version": "fem_frequency_domain_progress.v1",
  "study_product": "modal_eigen",
  "solver_phase": "factorizing_shift",
  "execution_lane": "production_cpu",
  "started_at": "2026-06-15T00:00:00Z",
  "last_update_at": "2026-06-15T00:00:03Z",
  "frequency_window_hz": [100000000.0, 5000000000.0],
  "requested_mode_count": 20,
  "accepted_mode_count": 4,
  "candidate_mode_count": 8,
  "current_shift_hz": 1250000000.0,
  "outer_iteration": 12,
  "max_outer_iterations": 300,
  "linear_iteration": 41,
  "max_linear_iterations": 1000,
  "current_residual_relative_l2": 2.5e-7,
  "target_residual_relative_l2": 1.0e-8,
  "partial_artifacts_available": true,
  "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
  "stop_reason": null
}
```

Driven response progress uses the same schema but sets:

```json
{
  "study_product": "driven_response",
  "solver_phase": "solving_frequency_point",
  "total_frequency_points": 101,
  "completed_frequency_points": 34,
  "current_frequency_hz": 2500000000.0,
  "current_linear_residual_relative_l2": 1.0e-6
}
```

Rust runtime mapping:

- modal progress updates `StepUpdate.stats.step` with accepted mode count only
  for legacy compatibility;
- modal progress also writes structured solver progress into stage execution
  telemetry so the Control Room does not infer eigensolve progress from LLG
  step counters;
- response progress maps `completed_frequency_points` to progress, not modal
  accepted mode count;
- heartbeat messages may report "still active" but must not replace the latest
  solver phase/residual fields.

### Native Entry Points

Add:

```cpp
FullmagFemFrequencyDomainResult fullmag_fem_modal_eigen_solve(
  const FullmagFemModalEigenRequest* request
);

FullmagFemFrequencyDomainResult fullmag_fem_driven_response_solve(
  const FullmagFemDrivenResponseRequest* request
);

void fullmag_fem_frequency_domain_result_destroy(
  FullmagFemFrequencyDomainResult* result
);
```

Initial implementation returns `FULLMAG_FEM_FD_UNAVAILABLE` with structured
diagnostics. It must not crash, throw, or return null diagnostics.

### Rust Binding Steps

- [x] Add bindgen declarations in `crates/fullmag-fem-sys/src/lib.rs`.
- [x] Add safe wrappers in `crates/fullmag-runner/src/native_fem.rs`.
- [x] Convert native statuses to `RunError` or capability diagnostics.
- [x] Preserve `diagnostics_json` in runner error messages and stage
      diagnostics.
- [x] Add unit test proving unavailable native modal solver is not treated as
      dense fallback.

### Tests

Native:

```bash
just ensure-managed-fem-runtime
```

Add managed native test recipe if absent:

```bash
just verify-fem-frequency-domain-native-contract
```

Expected:

```text
frequency_domain_contract_test passed
modal_eigen_contract_test passed
driven_response_contract_test passed
```

Rust:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner native_frequency_domain_unavailable
```

Expected:

```text
native unavailable status is surfaced as capability error
```

### Acceptance Criteria

- Native backend has separate modal and driven response entrypoints.
- Rust runner can call both and receives structured unavailable diagnostics.
- No production status is promoted.
- No dense fallback occurs when native production path is explicitly requested.

---

## 6. Milestone 3 - Managed PETSc/SLEPc Dependency Integration

### Objective

Package PETSc/SLEPc or an equivalent production sparse eigensolver stack into
the managed FEM runtime.

### Files

Modify:

```text
docker/fem-gpu/Dockerfile
compose.yaml
scripts/export_fem_gpu_runtime.sh
justfile
backends/fem/CMakeLists.txt
backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
```

### Implementation Steps

- [x] Add or extend a `just` recipe that inspects managed FEM solver
      dependencies without requiring implementers to hand-write Docker commands:

```bash
just inspect-managed-fem-frequency-domain-deps
```

- [x] The recipe reports PETSc/SLEPc availability, versions, CMake package
      locations, and exported runtime-library paths.
- [x] Raw `docker compose` may be used only inside the `justfile` recipe or as a
      labelled diagnostic when the recipe itself is broken. It is not the normal
      build path.
- [x] If PETSc/SLEPc are absent, add deterministic installation to
      `docker/fem-gpu/Dockerfile`.
- [x] Add or extend the container-backed rebuild recipe:

```bash
just rebuild-fem-runtime
```

- [x] Prefer distro packages only if they provide versions compatible with the
      MFEM/hypre stack in the image.
- [x] If building from source, pin versions in Dockerfile ARGs. Not applicable
      for the current runtime because it uses distro PETSc/SLEPc packages:

```text
PETSC_VERSION=3.x.y
SLEPC_VERSION=3.x.y
```

- [x] Record versions in `.fullmag/runtimes/fem-gpu-host/manifest.json`.
- [x] Export required shared libraries in `scripts/export_fem_gpu_runtime.sh`.
- [x] Export headers and CMake package files needed by `backends/fem`.
- [x] Add CMake feature flag:

```text
FULLMAG_FEM_WITH_SLEPC=ON
```

- [x] Add runtime capability probe:

```text
modal_eigen_native_cpu_slepc_available = true|false
```

- [x] Add clear error if requested production modal path lacks SLEPc.

### CMake Requirements

CMake must expose:

```cmake
find_package(PETSc REQUIRED)
find_package(SLEPc REQUIRED)
target_compile_definitions(fullmag_fem PRIVATE FULLMAG_FEM_WITH_SLEPC=1)
target_link_libraries(fullmag_fem PRIVATE PETSC::petsc SLEPC::slepc)
```

If package names differ, wrap them in a local CMake module under the existing
backend build convention. Do not hardcode host-specific library paths.

### Tests

Commands:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just inspect-managed-fem-frequency-domain-deps
just verify-fem-frequency-domain-native-contract
```

Expected:

```text
SLEPc version is printed
managed runtime manifest contains PETSc and SLEPc versions
modal native dependency contract passes
```

Add native test:

```cpp
TEST(FrequencyDomainDependencies, SlepcIsAvailableWhenFeatureEnabled) {
  auto info = fullmag_fem_frequency_domain_dependency_info();
  ASSERT_TRUE(info.slepc_available);
  ASSERT_GT(std::strlen(info.slepc_version), 0);
}
```

### Acceptance Criteria

- Managed runtime includes PETSc/SLEPc or equivalent.
- Runtime manifest records solver library versions.
- Native C++ can link and run a trivial SLEPc availability test.
- Missing dependency produces capability error, not link-time or runtime crash.

---

## 7. Milestone 4 - Tangent Operator Assembly and Apply

### Objective

Build the shared tangent-space linearized LLG operator used by both modal and
driven response paths.

### Files

Create or modify:

```text
backends/fem/include/frequency_domain/tangent_frame.hpp
backends/fem/include/frequency_domain/operator_contract.hpp
backends/fem/cpu/frequency_domain/mfem_tangent_space.cpp
backends/fem/cpu/frequency_domain/mfem_linearized_operator.cpp
backends/fem/cpu/frequency_domain/mfem_exchange_operator.cpp
backends/fem/cpu/frequency_domain/mfem_zeeman_operator.cpp
backends/fem/cpu/frequency_domain/mfem_dmi_operator.cpp
backends/fem/cpu/frequency_domain/mfem_operator_context.cpp
backends/fem/tests/frequency_domain/operator_contract_test.cpp
```

### Tangent Frame Algorithm

For every active magnetic node:

```text
input: m0 = (mx, my, mz)
normalize m0
choose helper a:
  if abs(mz) < 0.9 then a = (0, 0, 1)
  else a = (0, 1, 0)
e1 = normalize(a x m0)
e2 = m0 x e1
```

Tests:

- `||e1|| = 1`
- `||e2|| = 1`
- `e1 dot e2 = 0`
- `e1 dot m0 = 0`
- `e2 dot m0 = 0`
- `e1 x e2` points along `m0`

### Operator Apply Contract

Expose:

```cpp
class LinearizedLlgOperator {
 public:
  int tangent_dof_count() const;
  void apply_mass(const Vector& q, Vector& out) const;
  void apply_dynamic_operator(const Vector& q, Vector& out) const;
  OperatorDiagnostics diagnostics() const;
};
```

`q` has length `2 * active_node_count`.

`apply_dynamic_operator` computes:

```text
L q = -gamma0 * P_T( m0 x delta_H[q] + delta_m[q] x H0 )
```

### Interaction Implementation Order

1. Mass and tangent projection.
2. Zeeman local term.
3. Exchange weak Laplacian.
4. Uniaxial anisotropy Hessian.
5. Cubic anisotropy Hessian.
6. Static k=0 demag derivative with Poisson-Robin or Poisson-Dirichlet.
7. DMI after weak residual derivative tests.
8. Surface anisotropy after boundary-face tests.

Do not enable an interaction in production capability until its derivative test
passes.

### Directional Derivative Test

For every interaction:

```text
H'[xi] ~= (H[m0 + eps xi] - H[m0 - eps xi]) / (2 eps)
```

Use:

```text
eps = 1e-6
relative_error <= 1e-5 for double precision
```

### Tests

Native commands:

```bash
just verify-fem-frequency-domain-native-contract
```

Add test names:

```text
tangent_frame_is_orthonormal
mass_apply_preserves_dimension
zeeman_operator_matches_macrospin_precession
exchange_directional_derivative_matches_finite_difference
anisotropy_directional_derivative_matches_finite_difference
operator_rejects_non_unit_equilibrium_above_tolerance
```

Rust command:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner frequency_domain_operator_diagnostics
```

### Acceptance Criteria

- Shared operator works without invoking modal or response solver.
- Operator diagnostics report active nodes, tangent DOF, interactions, units,
  equilibrium residual, and demag realization.
- Operator rejects invalid equilibrium before eigensolve or response solve.

---

## 8. Milestone 5 - CPU Shift-Invert Modal Solver

### Objective

Implement the first production CPU modal eigensolver for k=0/free-boundary
interior targets using shift-invert spectral transformation.

### Files

Create or modify:

```text
backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp
backends/fem/cpu/frequency_domain/spectral_transform.cpp
backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp
backends/fem/src/frequency_domain/solver_progress.cpp
backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
crates/fullmag-runner/src/fem/frequency_domain/modal.rs
crates/fullmag-runner/src/fem/frequency_domain/progress.rs
```

### Shift Selection

For `target="nearest"`:

```text
shift_frequency_hz = target_frequency_hz
shift_omega_rad_s = 2*pi*shift_frequency_hz
```

For `target="frequency_window"` initial single-shift implementation:

```text
shift_frequency_hz = 0.5 * (frequency_min_hz + frequency_max_hz)
shift_omega_rad_s = 2*pi*shift_frequency_hz
```

The single-shift milestone is not complete production window coverage. It is an
intermediate proof of spectral transform, residuals, native progress, and
artifact wiring.

### Algebraic Pencil for First Production Lane

The first production modal lane must implement one of these two explicit
pencils and record the selected value in diagnostics:

Option A, generalized gyrotropic pencil:

```text
K phi = omega G phi
```

where `K` is the tangent energy Hessian and `G` is the gyrotropic tangent
operator. Because `G` is skew-symmetric, this path generally uses a
nonsymmetric generalized solver and filters positive physical frequencies.

Option B, real Hamiltonian first-order operator:

```text
q_dot = A q
A = -G^{-1} K
A phi = lambda phi
lambda = i omega
```

This path must not explicitly form a dense `G^{-1}`. It may implement operator
application by solving with `G` or by using the equivalent SLEPc spectral
transformation on the pair. If `G` is block-local in the tangent basis, the
local inverse may be applied analytically and documented.

Required diagnostics:

```json
{
  "algebraic_form": "gyrotropic_generalized",
  "slepc_problem_type": "gnhep",
  "positive_frequency_filter": "omega_rad_s > 0",
  "eigenvalue_to_frequency": "frequency_hz = abs(omega_rad_s)/(2*pi)",
  "conjugate_pair_policy": "keep_positive_frequency_partner"
}
```

The implementation must add a unit test that constructs a two-DOF macrospin
operator with known frequency and verifies the eigenvalue mapping before any
MFEM mesh is involved.

### SLEPc Configuration

Initial target:

```text
EPS type: krylovschur
ST type: sinvert
target: shift_omega_rad_s
which: target_magnitude
nev: count + guard_modes
ncv: max(2*nev + 8, 32)
tol: residual_tolerance
max_it: max_outer_iterations
```

Problem type must be selected from the actual algebraic form:

```text
gyrotropic generalized nonsymmetric: EPS_GNHEP
real Hamiltonian standard operator:  EPS_NHEP
Hermitian transformed lane:          EPS_GHEP only if proven self-adjoint
```

Do not use a Hermitian SLEPc problem type for the first-order LLG operator
unless the code includes a test proving the weighted self-adjointness identity.

Linear solve:

```text
KSP type: gmres or preonly for direct test path
PC type: hypre boomeramg, gamg, ilu, or fieldsplit depending on matrix
max_it: max_linear_iterations
rtol: min(1e-2 * eigen_residual_tolerance, 1e-10)
```

Every resolved choice is written to diagnostics.

Linear tolerance policy:

```text
ksp_rtol <= min(0.01 * eigen_residual_tolerance, 1e-10)
ksp_atol <= 1e-14 for normalized validation systems
```

If the shifted operator is indefinite or nonsymmetric, AMG may be a
preconditioner candidate but not a correctness assumption. Diagnostics must
record:

```text
pc_type
ksp_type
ksp_converged_reason
ksp_final_residual
factorization_package if direct solve is used
nullspace_policy
```

Nullspace policy:

- if the magnetic system has global phase or constant-vector null modes,
  attach a PETSc nullspace only after proving it belongs to the shifted
  operator;
- otherwise reject singular shifted systems with a clear diagnostic;
- never hide a singular shift by returning fewer modes without stop reason.

### Residual Acceptance

For every candidate:

```text
r = A q - lambda B q
relative_residual = ||r||_2 / (||A q||_2 + |lambda| * ||B q||_2)
```

For the gyrotropic pencil:

```text
r = K phi - omega G phi
relative_residual =
  ||r||_2 / (||K phi||_2 + |omega| * ||G phi||_2)
```

For the first-order complex form:

```text
r = L phi - lambda M phi
relative_residual =
  ||r||_2 / (||L phi||_2 + |lambda| * ||M phi||_2)
```

Accept if:

```text
relative_residual <= residual_tolerance
frequency_hz is finite
mode payload finite
tangent leakage below tolerance
```

### Progress Events

Native solver emits:

```json
{
  "phase": "solving_shift_invert",
  "shift_frequency_hz": 2500000000.0,
  "outer_iteration": 12,
  "max_outer_iterations": 500,
  "linear_iteration": 34,
  "max_linear_iterations": 1000,
  "residual_max": 1.2e-8,
  "residual_target": 1.0e-8,
  "candidate_modes": 28,
  "converged_modes": 18,
  "accepted_modes": 15
}
```

Rust maps this into existing stage progress without overwriting by heartbeat.

### Tests

Native:

```text
modal_shift_invert_finds_macrospin_mode
modal_shift_invert_residual_below_tolerance
modal_shift_invert_reports_ksp_iterations
modal_shift_invert_cancel_returns_interrupted
```

Rust:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner modal_shift_invert_progress
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-cli fem_eigen_progress
```

Managed runtime:

```bash
just verify-fem-frequency-domain-eigen-runtime
```

### Acceptance Criteria

- Native modal solver performs a real spectral-targeted solve.
- Progress includes outer iterations and shifted linear solve iterations.
- Result artifacts include residuals and shift provenance.
- Unsupported demag/k cases fail clearly.

---

## 9. Milestone 6 - Multi-Shift Frequency Window Orchestration

### Objective

Make `frequency_window` robust for wide windows and mode-dense systems by
partitioning the requested interval into subwindows and running multiple
shift-invert solves.

### Files

Create or modify:

```text
backends/fem/cpu/frequency_domain/window_partition.cpp
backends/fem/cpu/frequency_domain/mode_filter.cpp
backends/fem/cpu/frequency_domain/mode_deduplication.cpp
backends/fem/tests/frequency_domain/window_partition_test.cpp
backends/fem/tests/frequency_domain/mode_deduplication_test.cpp
crates/fullmag-runner/src/fem/frequency_domain/modal.rs
scripts/verify_fem_frequency_domain_eigen_artifacts.py
```

### Window Partition Algorithm

Inputs:

```text
frequency_min_hz
frequency_max_hz
count
expected_mode_density optional
max_subwindow_width_ratio default 0.35
min_subwindow_count default 1
max_subwindow_count default 16
```

Compute:

```text
window_width = frequency_max_hz - frequency_min_hz
relative_width = window_width / frequency_min_hz
subwindow_count = clamp(
  ceil(relative_width / max_subwindow_width_ratio),
  min_subwindow_count,
  max_subwindow_count
)
```

For each subwindow:

```text
sub_min = frequency_min_hz + i * window_width / subwindow_count
sub_max = frequency_min_hz + (i + 1) * window_width / subwindow_count
shift = 0.5 * (sub_min + sub_max)
guard_min = max(0, sub_min - guard_fraction * (sub_max - sub_min))
guard_max = sub_max + guard_fraction * (sub_max - sub_min)
```

Default:

```text
guard_fraction = 0.25
guard_modes_per_shift = max(4, ceil(count / subwindow_count))
```

The partitioner also carries completeness metadata:

```text
completeness_policy
certification_method
estimated_modes_in_window
certified_modes_in_window
uncertified_subwindows
```

For `best_effort`, `certification_method = "none"` is allowed, but the result
must publish `window_completeness = "not_certified"`.

For `certified_count`, every subwindow must be certified by at least one of:

- contour eigenvalue count;
- inertia count for a supported symmetric/Hamiltonian transformed pencil;
- dense oracle count for small systems;
- overlapping shifts with coverage proof and no missing interval after
  deduplication.

Coverage proof for overlapping shifts:

```text
subwindow_i.guard_max >= subwindow_{i+1}.guard_min
all accepted candidates in guard overlap deduplicate consistently
edge residuals below tolerance
no subwindow reaches max_outer_iterations without stop_reason="converged"
```

### Deduplication Algorithm

For candidate modes sorted by frequency:

1. Reject non-finite frequencies.
2. Reject candidates outside requested window.
3. Reject residual above tolerance.
4. Reconstruct mode vector in common physical basis.
5. Normalize with mass norm.
6. Compare with accepted modes:

```text
frequency_close =
  abs(f_i - f_j) <= max(1e-6 * max(f_i, f_j), 1e3)

overlap = abs(u_i^H M u_j)
same_mode = frequency_close && overlap >= 0.90
```

7. If duplicate, keep lower residual.
8. Stop after `count` accepted modes only if all subwindows have completed or
   remaining subwindows are provably outside requested interval.

If more accepted physical modes exist than the requested `count`, publish:

```json
{
  "stop_reason": "requested_count_reached",
  "window_completeness": "truncated_by_requested_count",
  "additional_modes_may_exist": true
}
```

If the user requested all modes in a window with a cap, publish whether the cap
truncated a certified count:

```json
{
  "certified_modes_in_window": 37,
  "returned_modes": 20,
  "result_truncated": true,
  "truncation_reason": "requested_mode_cap"
}
```

### Stop Reasons

Valid stop reasons:

```text
converged
window_exhausted
partial_convergence
max_iterations
linear_solve_failed
residual_not_met
cancelled
capability_missing
operator_invalid
```

Do not use `completed` without a specific modal stop reason.

### Diagnostics

`eigen/diagnostics/solver.v1.json` includes:

```json
{
  "requested_window_hz": [100000000.0, 5000000000.0],
  "resolved_search_window_hz": [75000000.0, 5125000000.0],
  "window_completeness": {
    "policy": "best_effort",
    "status": "not_certified",
    "certification_method": "none",
    "additional_modes_may_exist": true
  },
  "subwindows": [
    {
      "index": 0,
      "requested_hz": [100000000.0, 1325000000.0],
      "search_hz": [75000000.0, 1356250000.0],
      "shift_hz": 712500000.0,
      "outer_iterations": 42,
      "linear_iterations_total": 1230,
      "candidate_modes": 12,
      "accepted_modes": 5,
      "residual_max": 8.0e-9,
      "stop_reason": "converged"
    }
  ]
}
```

### Tests

Native:

```text
window_partition_covers_requested_interval
window_partition_adds_guard_bands
window_partition_never_uses_negative_frequency
mode_filter_keeps_boundary_modes_inclusive
mode_deduplication_keeps_lower_residual_duplicate
frequency_window_reports_unresolved_subwindow
```

Rust:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner frequency_window
```

Artifact verifier:

```bash
python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py .fullmag/reports/frequency-domain-eigen-runtime/artifacts
```

### Acceptance Criteria

- Published modes are inside requested window.
- Diagnostics list every subwindow.
- Partial convergence is explicit.
- Duplicate modes are removed by frequency and overlap.
- No hidden fallback to `lowest` exists.
- UI and artifact manifest distinguish `best_effort`, `certified_count`, and
  `truncated_by_requested_count`.

---

## 10. Milestone 7 - FEAST or Contour Interval Solver

### Objective

Add a true interval eigensolver for wide windows and dense spectra where
multi-shift Krylov-Schur is not efficient enough.

### Files

Create:

```text
backends/fem/cpu/frequency_domain/contour_interval_solver.cpp
backends/fem/cpu/frequency_domain/contour_quadrature.cpp
backends/fem/tests/frequency_domain/contour_interval_solver_test.cpp
```

Modify:

```text
backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp
backends/fem/src/frequency_domain/solver_progress.cpp
docs/specs/capability-matrix-v0.md
```

### Algorithm

Use FEAST or contour-integral equivalent:

```text
P = (1 / 2*pi*i) integral_Gamma (z B - A)^-1 B dz
```

where `Gamma` encloses the requested frequency interval after mapping to the
solver eigenvalue plane.

For the undamped positive-frequency modal lane:

```text
lambda = i omega
omega in [2*pi*f_min, 2*pi*f_max]
Gamma encloses lambda interval on the positive imaginary axis
```

If the implementation works directly in the real `omega` plane, diagnostics
must say:

```text
contour_plane = "omega_rad_s"
frequency_mapping = "f_hz = omega_rad_s/(2*pi)"
```

If the implementation works in first-order complex `lambda`, diagnostics must
say:

```text
contour_plane = "lambda"
frequency_mapping = "f_hz = abs(imag(lambda))/(2*pi)"
positive_frequency_filter = "imag(lambda) > 0"
```

Implementation options:

1. SLEPc contour/region support if available and stable.
2. FEAST-like custom wrapper using independent shifted KSP solves at contour
   points.

Contour shape:

```text
default shape: ellipse or rectangle around positive-frequency interval
real half-width: max(alpha_damping_margin, residual_margin)
imag lower: 2*pi*frequency_min_hz
imag upper: 2*pi*frequency_max_hz
quadrature: trapezoidal for smooth contour, Gauss-Legendre per side for rectangle
initial contour_point_count: 16
refinement: double contour_point_count until count/residual stable
```

Subspace dimension:

```text
subspace_dimension = min(
  max(2 * requested_mode_count + 8, estimated_mode_count + 8),
  configured_max_subspace_dimension
)
```

Rank handling:

- if projected subspace rank is below estimated mode count, increase subspace
  dimension or contour quadrature;
- if rank deficiency persists, return `partial_convergence` with diagnostics;
- do not publish a certified count from a rank-deficient projected subspace.

Duplicate and conjugate handling:

- filter negative-frequency partners before mode count certification;
- deduplicate by mass overlap in the same physical basis used by shift-invert;
- within degenerate clusters, certify the subspace, not individual ordering.

Required contour diagnostics:

```text
contour_point_count
quadrature_rule
contour_center_hz
contour_radius_hz
linear_iterations_per_point
projection_rank
estimated_mode_count
accepted_mode_count
count_certificate
quadrature_refinements
rank_deficiency_detected
```

Certification:

```text
certified_count = true only if:
  contour count is stable after one quadrature refinement
  all accepted residuals <= residual_tolerance
  projection_rank >= accepted_mode_count
  no contour linear solve failed
```

### Solver Selection Policy

Default:

```text
if target == frequency_window and relative_width >= 0.5:
  prefer contour interval solver when available
else:
  use multi-shift Krylov-Schur
```

User-facing public API remains unchanged. Resolved policy is provenance.

### Tests

Native:

```text
contour_solver_counts_modes_inside_interval
contour_solver_rejects_missing_linear_solver
contour_solver_reports_each_contour_point
contour_solver_matches_dense_oracle_small_mesh
```

Managed runtime:

```bash
just verify-fem-frequency-domain-eigen-runtime
```

Performance:

```bash
just benchmark-fem-frequency-domain-eigen-window
```

### Acceptance Criteria

- Contour interval solver can be selected by resolved policy.
- Same artifact schema is used as shift-invert.
- Diagnostics expose contour points and linear solves.
- Capability matrix distinguishes shift-invert availability from contour
  interval availability.
- Certified contour counts are exposed separately from best-effort contour
  results.

---

## 11. Milestone 8 - Driven Frequency Response Production Path

### Objective

Implement the COMSOL-style driven `FrequencyResponse` solver as a separate
production path, sharing the operator but not the modal eigensolver.

Current-state delta: the repository already has a limited native FEM CPU driven
response lane for gamma/free-boundary and k=0 static-periodic magnetic response.
This milestone does not restart that work. It hardens the existing response
lane against the new modal contracts:

- keep the existing response capability status unless new validation changes it;
- keep response progress under response resources, not eigen resources;
- keep response artifacts under response schemas, not spectrum/mode schemas;
- reuse shared operator improvements only where the existing response tests
  prove the behavior is unchanged or improved.

### Files

Create or modify:

```text
backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp
backends/fem/cpu/frequency_domain/dense_driven_response.cpp
backends/fem/cpu/frequency_domain/mfem_driven_response_validation.cpp
backends/fem/cpu/frequency_domain/response_artifact_writer.cpp
backends/fem/tests/frequency_domain/driven_response_contract_test.cpp
crates/fullmag-runner/src/fem/frequency_domain/response.rs
crates/fullmag-runner/src/frequency_response.rs
apps/control-room/src/modules/inspector/panels/stages/FrequencyResponseStageInspector.tsx
```

### Equation

For each requested drive frequency:

```text
(i omega M - L + damping_terms) q(omega) = b(omega)
```

where:

```text
omega = 2*pi*frequency_hz
b(omega) = projected harmonic drive phasor
```

### Response Observables

Compute:

```text
response_amplitude = abs(q)
response_phase = atan2(Im(q), Re(q))
susceptibility = projected_response / projected_drive
absorbed_power_density = 0.5 * mu0 * omega * Im(conj(h_drive) dot delta_m)
```

All units must be stated:

- `delta_m` dimensionless;
- drive field in A/m;
- power density in W/m^3;
- susceptibility dimensionless where defined.

Artifact field distinction:

```text
response/field/{frequency_index}:
  unknown_kind = "delta_m_response"
  payload_units = "dimensionless"
  complex_phase_reference = "drive_phase"

response/drive/{frequency_index}:
  field_kind = "h_drive"
  payload_units = "A/m"

response/susceptibility:
  observable_kind = "projected_susceptibility"
  payload_units = "dimensionless" unless tensor component states otherwise

response/absorbed_power_density:
  observable_kind = "absorbed_power_density"
  payload_units = "W/m^3"
```

Do not reuse modal mode-field labels for driven response fields. A response
field is a forced solution at a drive frequency; a modal field is an eigenvector
with arbitrary normalized amplitude.

### Tests

Native:

```text
driven_response_zero_drive_returns_zero_response
driven_response_phase_is_preserved
driven_response_residual_below_tolerance
driven_response_sweep_reuses_operator_template
```

Rust/API:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner frequency_response
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-api frequency_response
```

Managed runtime:

```bash
just verify-fem-frequency-domain-runtime
```

### Acceptance Criteria

- Driven response is callable without modal solve.
- Driven response artifacts do not pretend to be eigenmode artifacts.
- UI shows drive frequency progress, not mode convergence progress.

---

## 12. Milestone 9 - IR, Python, Planner, and Capability Wiring

### Objective

Make public authoring exact and round-trippable while keeping solver policy
separate from physics intent.

### Files

Modify:

```text
crates/fullmag-ir/src/study.rs
crates/fullmag-ir/src/plan.rs
crates/fullmag-ir/src/lib.rs
crates/fullmag-plan/src/fem.rs
packages/fullmag-py/src/fullmag/model/study.py
packages/fullmag-py/src/fullmag/world.py
packages/fullmag-py/src/fullmag/runtime/script_builder.py
packages/fullmag-py/src/fullmag/runtime/scene_document.py
docs/specs/capability-matrix-v0.md
```

### IR Requirements

Modal:

```rust
EigenTargetIR::FrequencyWindow {
    frequency_min_hz: f64,
    frequency_max_hz: f64,
}
```

Optional advanced policy:

```rust
pub struct EigenSolverPolicyIR {
    pub family: EigenSolverFamilyIR,
    pub spectral_transform: EigenSpectralTransformIR,
    pub residual_tolerance: Option<f64>,
    pub max_outer_iterations: Option<u32>,
    pub max_linear_iterations: Option<u32>,
}
```

Driven response:

```rust
pub struct FrequencySweepIR {
    pub frequencies_hz: Vec<f64>,
}
```

### Public Python Contract

Keep the public split visible in Python. Existing constructors already follow
this shape and must stay round-trippable:

```python
fm.Eigenmodes(
    outputs=[
        fm.SaveSpectrum(quantity="eigenfrequency"),
        fm.SaveMode(indices=tuple(range(20))),
        fm.SaveEigenDiagnostics(),
    ],
    count=20,
    target="frequency_window",
    frequency_min=100e6,
    frequency_max=5e9,
    operator="linearized_llg",
    equilibrium_source="relax",
    include_demag=True,
    k_sampling=None,
    normalization="unit_l2",
    damping_policy="ignore",
    spin_wave_bc="free",
)
```

```python
fm.FrequencyResponse(
    outputs=[
        fm.SaveResponse(observable="m_complex"),
        fm.SaveResponse(observable="absorbed_power_density"),
    ],
    frequencies_hz=[100e6, 200e6, 300e6],
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    excitation_phase_rad=0.0,
    operator="linearized_llg",
    equilibrium_source="relax",
    include_demag=True,
    k_sampling=None,
    normalization="unit_l2",
    damping_policy="ignore",
    spin_wave_bc="free",
)
```

Rules:

- `Eigenmodes` may not accept `SaveResponse` outputs;
- `FrequencyResponse` may not be lowered to `EigenTargetIR`;
- modal `frequency_min`/`frequency_max` are stored as Hz and exported as Python
  numeric expressions preserving user intent where possible;
- UI display may format MHz/GHz, but IR and artifacts remain Hz;
- `target="frequency_window"` requires both `frequency_min` and
  `frequency_max`;
- `target="nearest"` requires `target_frequency`;
- `FrequencyResponse.frequencies_hz` must be a non-empty positive finite list;
- scene-document serialization must preserve the class split, not normalize
  both into a generic `frequency_domain` object.

Canonical export examples:

```python
study.stage(
    fm.Eigenmodes(
        outputs=[
            fm.SaveSpectrum(quantity="eigenfrequency"),
            fm.SaveMode(indices=tuple(range(20))),
            fm.SaveEigenDiagnostics(),
        ],
        count=20,
        target="frequency_window",
        frequency_min=100e6,
        frequency_max=5e9,
        equilibrium_source="relax",
        spin_wave_bc="free",
    )
)
```

```python
study.stage(
    fm.FrequencyResponse(
        outputs=[
            fm.SaveResponse(observable="m_complex"),
            fm.SaveResponse(observable="absorbed_power_density"),
        ],
        frequencies_hz=[100e6 + i * ((5e9 - 100e6) / 200) for i in range(201)],
        excitation_field_au_per_m=(0.0, 0.0, 1.0),
        equilibrium_source="relax",
        spin_wave_bc="free",
    )
)
```

If a future `fm.linspace_hz` helper is added, it needs its own Python tests and
IR round-trip tests before the script exporter may use it.

### UI Transaction Patch Shape

Study-stage edits from Control Room must commit through model transactions.
Patch payloads must preserve product kind:

```json
{
  "op": "replace",
  "path": "/study/stages/stage-003/eigenmodes/target",
  "value": {
    "kind": "frequency_window",
    "frequency_min_hz": 100000000.0,
    "frequency_max_hz": 5000000000.0
  }
}
```

```json
{
  "op": "replace",
  "path": "/study/stages/stage-004/frequency_response/frequencies_hz",
  "value": [100000000.0, 200000000.0, 300000000.0]
}
```

Do not send a generic `/frequency_domain/{field}` patch for authoring fields. The
generic frequency-domain namespace is for analysis resources, not for erasing
the authoring product split.

### Validation

Reject:

- non-finite frequency;
- non-positive modal window bounds;
- `frequency_min_hz >= frequency_max_hz`;
- empty response frequency list;
- non-positive response frequencies;
- `damping_policy="include"` for modal production until non-Hermitian lane is
  validated;
- nonzero-k Floquet demag until dynamic demag-k exists.

### Planner Rules

Modal:

```text
StudyIR::Eigenmodes -> BackendPlanIR::FemEigen
```

Driven:

```text
StudyIR::FrequencyResponse -> BackendPlanIR::FemFrequencyResponse
```

No planner branch may map `FrequencyResponse` to `FemEigen` or `Eigenmodes` to
`FemFrequencyResponse`.

### Tests

Python:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k "eigenmodes or frequency_response"
```

Rust:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-ir eigen
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan fem_eigen
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan frequency_response
```

### Acceptance Criteria

- Python and UI round-trip to the same IR.
- Planner never mixes modal and driven products.
- Capability matrix reports separate statuses.

---

## 13. Milestone 10 - Artifacts, API, and Control Room

### Objective

Expose solver state and results through resource-first API and Control Room
without guessing semantics from paths.

### Files

Modify:

```text
docs/specs/frequency-domain-artifacts-v2.md
crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs
crates/fullmag-api/src/router_v2/handlers/analysis/response.rs
crates/fullmag-api/src/schemas/runtime.rs
apps/control-room/src/kernel/api/generated/openapi-v2.json
apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
apps/control-room/src/kernel/api/generated/openapi-v2-client.ts
apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts
apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts
apps/control-room/src/modules/inspector/panels/stages/EigenmodesStageInspector.tsx
apps/control-room/src/modules/inspector/panels/stages/FrequencyResponseStageInspector.tsx
apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx
```

### Modal Inspector Must Show

- requested frequency window;
- resolved search window;
- eigensolver family;
- spectral transform;
- active nodes;
- tangent DOF;
- candidate modes;
- converged modes;
- accepted modes;
- current shift or contour point;
- outer iteration;
- linear iteration;
- residual target and current residual;
- stop reason;
- latest artifact paths.

### Response Inspector Must Show

- drive frequencies;
- current frequency point;
- excitation field and phase;
- linear solver family;
- linear iteration;
- response residual;
- sweep reuse status;
- response artifact paths.

### API Resources

Use the existing frequency-domain namespace. Add or stabilize:

```text
GET /v2/sessions/current/analysis/frequency-domain/manifest.v1
GET /v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2
GET /v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2
GET /v2/sessions/current/analysis/frequency-domain/eigen/branches.v2
GET /v2/sessions/current/analysis/frequency-domain/eigen/dispersion
GET /v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{mode_index}/meta
GET /v2/sessions/current/analysis/frequency-domain/response/progress.v1
GET /v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1
GET /v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep
GET /v2/sessions/current/analysis/frequency-domain/response/field/{frequency_index}/meta
GET /v2/sessions/current/analysis/frequency-domain/response/frequency-points/{frequency_index}
GET /v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1
```

Do not introduce parallel `/analysis/eigen/{resource}` or
`/analysis/frequency-response/{resource}` route families unless a separate ADR
changes the resource namespace.

### Resource-First Implementation Chain

Backend schema ownership:

```text
crates/fullmag-api/src/schemas/runtime.rs
crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs
crates/fullmag-api/src/router_v2/handlers/analysis/response.rs
```

Every new response body must have:

- Rust schema struct;
- OpenAPI schema name;
- operation ID;
- typed frontend return type;
- resource revision key;
- invalidation event mapping;
- loading/error/degraded UI state.

Frontend access chain:

```text
OpenAPI schema
  -> apps/control-room/src/kernel/api/generated/openapi-v2.json
  -> apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
  -> apps/control-room/src/kernel/api/generated/openapi-v2-client.ts
  -> central Control Room API facade
  -> resource hook
  -> inspector/plot/viewport consumer
```

Required resource hooks:

```text
useFrequencyDomainManifestResource()
useEigenSpectrumResource()
useEigenDiagnosticsResource()
useEigenModeFieldMetaResource(sampleIndex, modeIndex)
useFrequencyResponseProgressResource()
useFrequencyResponseDiagnosticsResource()
useFrequencyResponseSweepResource()
useFrequencyResponseFieldMetaResource(frequencyIndex)
```

Resource keys must be stable and namespace-specific:

```text
analysis.frequency_domain.manifest.v1
analysis.frequency_domain.eigen.spectrum.v2
analysis.frequency_domain.eigen.diagnostics.v2
analysis.frequency_domain.response.progress.v1
analysis.frequency_domain.response.diagnostics.v1
analysis.frequency_domain.response.magnetic_sweep
```

Realtime invalidation:

- modal progress invalidates eigen diagnostics and stage execution progress;
- modal artifact publication invalidates manifest, spectrum, diagnostics,
  branches, dispersion, and selected mode-field metadata;
- response progress invalidates response progress and stage execution progress;
- response artifact publication invalidates manifest, response diagnostics,
  response sweep, and selected response field metadata.

The Control Room must not poll thousands of field vectors per second to infer
progress. It must read progress resources and fetch heavy field payloads only
when the selected visualization target changes or an animation frame actually
requires a new phase.

### Artifact Schemas

Modal solver diagnostics:

```json
{
  "schema_version": "eigen_diagnostics.v2",
  "study_product": "modal_eigen",
  "solver_family": "slepc_krylovschur_shift_invert",
  "algebraic_form": "gyrotropic_generalized",
  "frequency_window_hz": [100000000.0, 5000000000.0],
  "requested_mode_count": 20,
  "accepted_mode_count": 18,
  "window_completeness": {
    "policy": "certified_count",
    "status": "certified",
    "certification_method": "contour_count",
    "certified_modes_in_window": 18
  },
  "residual_tolerance": 1.0e-8,
  "max_residual_relative_l2": 8.0e-9,
  "equilibrium": {
    "max_norm_error": 2.0e-8,
    "max_torque_T": 5.0e-4,
    "material_weighted_torque_T": 8.0e-5
  },
  "demag": {
    "enabled": true,
    "model": "poisson_airbox_robin",
    "dynamic_k_supported": false,
    "last_linear_residual": 1.0e-10
  },
  "stop_reason": "converged"
}
```

Modal spectrum rows:

```json
{
  "sample_index": 0,
  "mode_index": 4,
  "frequency_hz": 1030000000.0,
  "omega_rad_s": 6471680861.0,
  "eigenvalue_real": 0.0,
  "eigenvalue_imag": 6471680861.0,
  "residual_relative_l2": 4.0e-9,
  "mass_norm": 1.0,
  "degenerate_cluster_id": "sample-0000-cluster-0004",
  "field_id": "analysis:eigen:sample-0000:mode-0004"
}
```

Mode field payload:

```text
Zarr group: eigen/mode_fields/sample-0000/mode-0004
arrays:
  real: float64, shape [node_count, 3], dimensionless delta_m
  imag: float64, shape [node_count, 3], dimensionless delta_m
  tangent_real: float64, shape [node_count, 2]
  tangent_imag: float64, shape [node_count, 2]
attributes:
  phase_convention
  normalization
  phase_gauge
  phase_anchor_dof
  mesh_asset_id
  equilibrium_source
```

Response diagnostics:

```json
{
  "schema_version": "response_diagnostics.v1",
  "study_product": "driven_response",
  "solver_family": "production_cpu_gmres",
  "total_frequency_points": 201,
  "completed_frequency_points": 201,
  "max_linear_residual_relative_l2": 1.0e-7,
  "drive_units": "A/m",
  "response_unknown_units": "dimensionless_delta_m",
  "absorbed_power_density_units": "W/m^3",
  "stop_reason": "converged"
}
```

Partial or cancelled artifacts:

- manifest includes `run_status = "partial" | "cancelled" | "completed"`;
- each published frequency point or mode row carries its own residual;
- missing rows are not represented as zero amplitude;
- UI shows partial/cancelled status from manifest and diagnostics, not by
  guessing from file count.

### Control Room Ownership

Explorer node IDs:

```text
study:stage:{stage_id}:eigenmodes
study:stage:{stage_id}:frequency-response
results:frequency-domain:eigen:spectrum
results:frequency-domain:eigen:modes:sample:{sample_index}:mode:{mode_index}
results:frequency-domain:response:sweep
results:frequency-domain:response:frequency:{frequency_index}
```

Inspector routing:

```text
study:stage:*:eigenmodes
  -> EigenmodesStageInspector

study:stage:*:frequency-response
  -> FrequencyResponseStageInspector

results:frequency-domain:eigen:*
  -> EigenResultInspector

results:frequency-domain:response:*
  -> FrequencyResponseResultInspector
```

Loading/error/degraded states:

- `no_manifest`: show no result artifacts yet;
- `progress_only`: show live solver progress without result links;
- `partial_artifacts`: show partial/cancelled result status and available rows;
- `diagnostics_missing`: show explicit degraded diagnostics warning;
- `field_payload_missing`: disable 3D overlay command for that mode/frequency;
- `capability_gated`: show planner reason and requested/resolved execution.

Command gating:

```text
Open latest spectrum:
  enabled when eigen spectrum resource status is ready

Open latest dispersion:
  enabled when eigen dispersion resource status is ready

Visualize eigen mode:
  enabled when selected mode has field_id and data-plane resource

Animate eigen mode phase:
  enabled when mode field payload is ready and viewport animation controller is idle

Stop eigen mode animation:
  enabled when viewport animation controller is running

Open response sweep:
  enabled when response magnetic-sweep resource is ready

Visualize response field:
  enabled when selected frequency point has response field meta and payload
```

Viewport adapters:

- modal mode overlay uses mode field payloads and modal display controls;
- response overlay uses forced-response field payloads and response display
  controls;
- both may reuse shader/color/vector controls, but the selected resource kind
  must remain distinct;
- animation loop must be owned by one controller with a stop command, not by
  repeated uncontrolled resource fetches.

### Tests

Frontend:

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test -- StageInspectors
pnpm --dir apps/control-room test -- FrequencyDomainInspectorPanel
pnpm --dir apps/control-room test -- resource
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
```

API:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-api frequency_domain
```

Browser:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace pnpm --dir apps/control-room smoke:viewport-3d
```

### Acceptance Criteria

- Eigenmode UI and response UI are separate.
- Progress bars use solver telemetry.
- Heartbeat never overwrites solver phase.
- Result inspectors show residual quality and stop reason.

---

## 14. Milestone 11 - Validation Ladder and Production Promotion

### Objective

Promote capability status only after objective validation, not after a demo run.

### Validation Suites

Analytic:

- macrospin/Kittel mode;
- exchange-dominated standing spin wave;
- reciprocal dispersion with no DMI;
- DMI nonreciprocity sign check;
- response zero-drive test.

Dense oracle:

- small mesh full dense spectrum;
- compare shift-invert window modes against dense spectrum;
- compare contour interval count against dense spectrum;
- compare response solve against dense harmonic validation.

External reference:

- TetraX modal dynamic matrix for comparable modal cases;
- COMSOL modal eigenfrequency project for one simple geometry;
- COMSOL driven frequency-domain project for one forced response case.

Scaling:

- increasing active node count;
- increasing requested mode count;
- narrow and wide frequency windows;
- demag on/off;
- damping on/off for response.

### Required Reports

Create:

```text
docs/performance/fem_modal_eigen_window_baselines.md
docs/performance/fem_frequency_response_baselines.md
docs/validation/fem_modal_eigen_window_validation.md
docs/validation/fem_frequency_response_validation.md
```

Each report records:

- commit;
- runtime manifest;
- PETSc/SLEPc versions;
- mesh statistics;
- material parameters in SI;
- requested/resolved solver settings;
- residuals;
- timings;
- memory estimate;
- pass/fail status.

### Capability Promotion Gates

Promote modal interior-window eigensolve from `semantic_only` to
`partial_production_executable` only when:

- native CPU k=0/free-boundary shift-invert works in managed runtime;
- dense oracle parity passes;
- progress telemetry includes outer and linear iterations;
- residual diagnostics are exported;
- Control Room displays stop reason and residuals.

Promote to `production_executable` only when:

- multi-shift window orchestration passes;
- demag-enabled k=0 cases pass;
- validation reports exist;
- performance gates pass;
- no hidden dense fallback exists.

Promote to `validated` only when:

- analytic, dense, external reference, and scaling suites pass;
- capability matrix documents exact supported interactions and unsupported
  lanes;
- UI and API expose the same status.

### Final Managed Runtime Commands

Run:

```bash
just rebuild-fem-runtime
just verify-fem-frequency-domain-eigen-runtime
just verify-fem-frequency-domain-runtime
just verify-fem-frequency-domain-runtime-suite
```

Expected:

```text
all managed frequency-domain FEM runtime gates pass
```

---

## 15. Control Room Dynamics UI Redesign Plan

### Objective

Replace the current frequency-domain/dynamics UI with a COMSOL-inspired,
problem-driven Study and Results tree. Explorer nodes must be generated from
the authored `StudyIR`, resolved capabilities, stage execution state, and
published artifact resources. The UI must not display static future nodes,
generic "contract" text, or unsupported branches as if they were part of the
current problem.

The target is not to clone COMSOL visually. The target is to adopt the useful
product model:

- Study steps are explicit problem definitions.
- Solver configuration is related to, but separate from, the study step.
- Eigenfrequency/eigenmode solve is not the same product as driven frequency
  response.
- Frequency Domain Modal is a workflow that depends on a prior eigenfrequency
  step, not a single mixed node.
- Linearization point, physics/variables, mesh selection, output storage,
  progress, and solver diagnostics are visible when they matter.

### COMSOL Manual Basis

Use these COMSOL 6.3 manual pages as the interaction reference:

```text
Eigenfrequency:
https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.024.html

Frequency Domain:
https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.027.html

Frequency Domain, Modal:
https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.031.html

Common Study Step Settings:
https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.011.html

Relationship Between Study Steps and Solver Configurations:
https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.006.html
```

Observed COMSOL concepts to carry into Fullmag:

- `Eigenfrequency` computes modes/eigenfrequencies and maps to an eigenvalue
  solver.
- `Frequency Domain` computes harmonic response for one or more drive
  frequencies and maps to a stationary parametric solver or AWE solver.
- `Frequency Domain, Modal` is a two-step workflow: eigenfrequency first,
  modal response second.
- Study settings expose unit-aware frequency lists, search shifts, rectangular
  or elliptical search regions, FEAST/ARPACK/LAPACK-like solver choices,
  linearization point, filtering, sorting, store/output controls, mesh
  selection, and results while solving.
- A study compute command is not the same as directly running an already edited
  solver configuration.

Fullmag implementation consequence:

```text
Study tree:
  authored intent and dependencies

Solver configuration / runtime diagnostics:
  resolved execution, backend, device, precision, solver method, progress

Results tree:
  published resources and artifacts only
```

### Current UI Problems To Remove

The current implementation has useful pieces but the information model is
wrong:

- `EIGENMODES_DETAIL_NODES` and `RESPONSE_DETAIL_NODES` are static arrays. They
  always create nodes such as `Periodic Pairs`, `k-Path`, `k/f Grid`, and
  `Boundary` even when the authored problem does not use those concepts.
- Stage inspectors show many rows whose values are fixed explanatory strings:
  `not applicable`, `backend default until solver contract exposes fields`,
  `not available until resource exists`, or generic `Contract` headings. These
  rows look like product data but are mostly documentation fragments.
- Runtime telemetry is special-cased for eigenmodes and still cannot show a
  clear solver phase, active shift, current frequency, residual, iteration
  count, or stop reason when the backend does not publish structured progress.
- The Results tree mixes product families under a generic `Frequency Domain`
  umbrella, then adds `Calculation Modes`, `FMR`, `Response Map`,
  `Comparison`, and `Exports` nodes even when the current problem did not ask
  for those workflows.
- FMR peak inspectors flatten provenance, resource paths, visualization
  controls, binary payload details, and validation into one long list. The user
  cannot see the scientific object first.
- Mode visualization controls are not treated as one shared visualization
  state across all modes.

Delete or replace:

```text
Static Study child nodes:
  study.stage.eigenmodes.periodic_pairs when no periodic/floquet boundary exists
  study.stage.eigenmodes.k_path when no k sampling or dispersion output exists
  study.stage.frequency_response.periodic_pairs when no periodic/floquet boundary exists
  study.stage.frequency_response.k_grid when no k grid or response map exists

Fields:
  Time integrator: not applicable
  Solver lane: dense/reference now; production eigensolver capability-gated
  Tolerance policy: backend default until solver contract exposes fields
  Mesh DOF estimate: not available until FEM mesh resource is built
  Response readiness: same equilibrium can be reused for modal comparison
  Backend semantics: shared physics contract; execution resolves CPU/GPU later

Titles:
  Modal Setup Contract
  Driven Response Setup Contract
  Modal Solver Contract
  Driven Response Solver Contract
```

These facts belong in capability diagnostics or docs, not as repeated primary
inspector fields.

### Dynamic Explorer Builder Contract

Create a dynamic builder layer instead of static node arrays:

```text
apps/control-room/src/modules/explorer/builders/study/frequencyDomainStageTree.ts
```

Inputs:

```ts
type FrequencyDomainStageTreeInput = {
  stage: ModelTreeStudyStageSnapshot;
  draft: StudyStageDraft | null;
  stageExecution: StudyStageModel | null;
  manifest: FrequencyDomainManifestResource | null;
  capabilities: FrequencyDomainCapabilities | null;
  resources: FrequencyDomainResourceSummary;
};
```

Output:

```ts
type FrequencyDomainStageTree = {
  root: ExplorerNode;
  children: ExplorerNode[];
  suppressed: Array<{
    nodeKind: string;
    reason: string;
  }>;
};
```

Node inclusion rules:

```text
Always include:
  Overview
  Study Settings
  Linearization Point
  Physics and Variables
  Mesh
  Output
  Solver Configuration
  Progress
  Diagnostics

Include Boundary only when:
  spin_wave_bc != "free"
  or static periodic pairs exist
  or resolved planner reports non-default boundary handling

Include Periodic Pairs only when:
  spin_wave_bc == "periodic" or "floquet"
  or mesh.periodic_node_pairs resource exists

Include k-Path only when:
  stage.kind == eigenmodes
  and k_sampling.kind in ["path", "grid", "explicit"]
  or output includes dispersion/branches

Include k/f Grid only when:
  stage.kind == frequency_response
  and response_map/floquet response capability is requested or available

Include Excitation only when:
  stage.kind == frequency_response

Include Frequency Sweep only when:
  stage.kind == frequency_response

Include Eigenfrequency Search only when:
  stage.kind == eigenmodes

Include Mode Filtering and Sorting only when:
  eigen filter/sort fields exist
  or result diagnostics publish non-default filtering/sorting

Include Artifacts only when:
  stage has artifact_refs
  or manifest points to product artifacts
```

No node may exist only because a developer expects the feature to exist in the
future. Future capability belongs under `Diagnostics > Capability Gates`.

### Target Study Explorer Tree

For a simple GPU relaxation followed by CPU modal eigenmodes:

```text
Study
  Steps
    1 Relax
      Overview
      Study Settings
      Solver Configuration
      Progress
      Output
      Diagnostics
    2 Change Device
      Overview
      Device Transfer
      Progress
      Diagnostics
    3 Eigenmodes
      Overview
      Study Settings
      Linearization Point
      Eigenfrequency Search
      Physics and Variables
      Mesh
      Solver Configuration
      Progress
      Output
      Diagnostics
  Solver Configurations
    Generated Sequence
      Relax Solver
      Device Transfer
      Eigenvalue Solver
  Jobs
    Current Run
```

For driven frequency response with explicit harmonic drive:

```text
Study
  Steps
    1 Relax
    2 Frequency Response
      Overview
      Study Settings
      Linearization Point
      Excitation
      Frequency Sweep
      Physics and Variables
      Mesh
      Solver Configuration
      Progress
      Output
      Diagnostics
  Solver Configurations
    Generated Sequence
      Stationary/Linearized Response Solver
      Frequency Sweep
```

For modal frequency response workflow:

```text
Study
  Steps
    1 Relax
    2 Eigenmodes
    3 Frequency Response, Modal
      Overview
      Mode Source
      Frequency Sweep
      Excitation
      Modal Solver Configuration
      Progress
      Output
      Diagnostics
```

Fullmag does not need a public `FrequencyResponseModal` class immediately, but
the UI must be ready to show this workflow when the IR can express it. Until
then, do not fake it with a generic `Calculation Modes` child.

### Study Root Inspector

Selection:

```text
study.root
```

Purpose: high-level compute workflow, not individual solver knobs.

Visible fields:

| Field | Source | Why visible |
|---|---|---|
| Study status | `simulation/stages/execution` | User needs to know whether the study is idle/running/completed/failed. |
| Stage count | `StudyIR.stages.length` | Confirms authored sequence. |
| Active stage | stage execution state | Shows where computation is. |
| Requested execution | authoring intent | Preserves user CPU/GPU/precision request. |
| Resolved execution | planner/runtime | Shows actual backend/device/precision. |
| Generated solver sequence | planner/runtime | Mirrors COMSOL's Study -> Solver Configuration separation. |
| Compute commands | command registry | One visible command source. |
| Latest artifacts | manifest/stage refs | Entry point to results. |
| Validation summary | `ProblemIR` validation | Shows whether the study is executable. |

Actions:

```text
Compute Study
Compute to Selected Step
Compute Selected Step
Stop
Export Canonical Python
Open Solver Configuration
```

Do not show per-mode visualization controls here.

### Steps Parent Inspector

Selection:

```text
study.stages
```

Visible fields:

| Field | Source | Why visible |
|---|---|---|
| Ordered stage table | `StudyIR.stages` | Shows pipeline. |
| Dependency graph | stage refs | Shows relax -> eigen -> response dependencies. |
| Device transitions | change_device stages | Confirms GPU/CPU handoff. |
| Blocking validation | validation issues | Explains why compute is disabled. |
| Dynamic nodes suppressed | builder suppression list | Makes hidden irrelevant nodes auditable in dev diagnostics. |

Actions:

```text
Add Relax
Add Change Device
Add Eigenmodes
Add Frequency Response
Reorder Stages
Validate Study
```

### Eigenmodes Stage Overview Inspector

Selection:

```text
study.stage.eigenmodes
```

Visible fields:

| Field | Source | Contract |
|---|---|---|
| Product | constant `modal_eigen` | Must distinguish from driven response. |
| Equation | physics contract | `K phi = omega G phi` or selected algebraic form. |
| Stage ID | `StudyIR` | Stable stage reference. |
| Status | stage execution | Runtime state. |
| Requested modes | `count` | Primary user intent. |
| Target | `target` | `lowest`, `nearest`, or `frequency_window`. |
| Frequency range | target fields | Auto-display Hz/MHz/GHz but store Hz. |
| Equilibrium source | stage field | Linearization dependency. |
| Boundary/k summary | stage field | Shows if free, periodic, Floquet, k path. |
| Output request | sampling/output IR | Spectrum/modes/dispersion/diagnostics. |
| Current progress | solver progress resource | Phase, count, residual, latest update. |
| Stop reason | execution state | Required after completion/failure. |

Actions:

```text
Save Stage
Compute Selected Step
Compute From Selected
Open Solver Configuration
Open Latest Spectrum
Open Diagnostics
```

### Eigenmodes Study Settings Inspector

Selection:

```text
study.stage.eigenmodes.study_settings
```

Fields:

| Field | Widget | Source | Justification |
|---|---|---|---|
| Mode count | numeric input | `count` | COMSOL exposes desired/approximate number of eigenfrequencies; Fullmag needs the same. |
| Target type | segmented control | `target.kind` | Distinguishes lowest/nearest/window. |
| Target frequency | unit input | `target.frequency_hz` | Needed for around-shift searches. |
| Frequency minimum | unit input | `frequency_min_hz` | Interior window lower bound. |
| Frequency maximum | unit input | `frequency_max_hz` | Interior window upper bound. |
| Display unit | select | UI-only | MHz/GHz display convenience, never IR storage. |
| Completeness policy | select | solver policy | `best_effort` vs `certified_count`. |
| Maximum returned modes | numeric input | solver policy | Prevents ambiguous "first 20" vs "all in window". |
| Store solutions | select | output policy | All accepted, first N, selected modes. |
| Generate default plots | checkbox | UI/result policy | Mirrors COMSOL default plots; Fullmag creates analysis plot suggestions. |

Hide:

- target frequency when target is not `nearest`;
- frequency min/max when target is not `frequency_window`;
- completeness policy when target is `lowest`.

### Eigenmodes Linearization Point Inspector

Selection:

```text
study.stage.eigenmodes.linearization_point
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Source kind | `equilibrium_source` | COMSOL exposes linearization point; Fullmag must show relax/artifact/provided. |
| Source stage | dependency graph | Shows which relax/static step produced `m0`. |
| Artifact path | artifact ref | Reproducibility. |
| `max_norm_error` | diagnostics | Reject non-unit `m0`. |
| `max_torque_T` | diagnostics | Shows whether state is actually relaxed. |
| `material_weighted_torque_T` | diagnostics | Better global acceptance metric. |
| `H_eff` summary | diagnostics | Physics sanity. |
| Reuse policy | planner | Whether same equilibrium feeds modal/response. |

Actions:

```text
Open Equilibrium Field
Open Relax Stage
Run Required Preceding Steps
```

### Eigenmodes Eigenfrequency Search Inspector

Selection:

```text
study.stage.eigenmodes.search
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Search method | resolved solver policy | Around shift, rectangular/window, FEAST/contour. |
| Solver family | resolved solver | ARPACK/Krylov-Schur/FEAST/LAPACK-like product concept. |
| Shift frequency | solver policy | Required for shift-invert. |
| Window bounds | target | Required for interior search. |
| Approximate modes | solver policy | Affects Krylov/subspace dimension and memory. |
| Maximum modes | solver policy | Limits extra discovery. |
| Consistency check | solver policy | Required for certified windows. |
| Ellipse center/semiaxes | contour policy | Required for FEAST-like searches. |
| Stochastic estimate | contour policy | Only when implemented. |
| Memory estimate | planner | Avoids hidden 8-hour runs with no visible reason. |

Do not show FEAST ellipse fields unless the selected or resolved solver family
is contour/FEAST.

### Eigenmodes Physics And Variables Inspector

Selection:

```text
study.stage.eigenmodes.physics_variables
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Active physics | ProblemIR interactions | Shows exchange/demag/anisotropy/DMI/Zeeman included. |
| Solved variables | operator diagnostics | Two tangent components per magnetic node. |
| Variables not solved | planner | Explains fixed fields/material data. |
| Gamma and mu0 | dynamics/material constants | Unit correctness. |
| Damping policy | stage | Modal damping changes solver class. |
| Demag realization | planner/runtime | Dynamic demag is a major capability gate. |
| Boundary condition | stage/planner | Free/periodic/Floquet. |
| k sampling | stage | Dispersion and nonzero-k legality. |

### Eigenmodes Mesh Inspector

Selection:

```text
study.stage.eigenmodes.mesh
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Mesh asset | mesh resource | Reproducibility. |
| Magnetic node count | mesh/operator diagnostics | Predicts tangent DOF. |
| Tangent DOF | operator diagnostics | Solver size. |
| FE order | mesh metadata | Error estimate and performance. |
| Active domains | mesh/selection | Confirms what is solved. |
| Airbox status | demag diagnostics | Needed for Poisson demag. |
| Periodic pair count | periodic resource | Only visible when relevant. |
| Mesh quality summary | mesh diagnostics | Explains solver risk. |

### Eigenmodes Solver Configuration Inspector

Selection:

```text
study.stage.eigenmodes.solver_configuration
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Requested backend/device/precision | authoring | User intent. |
| Resolved backend/device/precision | planner/runtime | Actual execution. |
| Algebraic form | solver diagnostics | `gyrotropic_generalized`, `first_order_complex`, or another documented modal form. |
| Eigen solver | solver diagnostics | Krylov-Schur, FEAST, dense oracle. |
| Spectral transform | solver diagnostics | Shift-invert/contour/direct. |
| Linear solver | solver diagnostics | KSP/direct details. |
| Preconditioner | solver diagnostics | Performance and convergence. |
| Residual tolerance | solver policy | Numerical acceptance. |
| Max outer iterations | solver policy | Runtime bound. |
| Max linear iterations | solver policy | Runtime bound. |
| Candidate mode budget | solver policy | Memory/time implications. |
| Capability gates | capability matrix | Shows unsupported demag/k/GPU lanes. |

This inspector corresponds to COMSOL's Solver Configuration layer, not the
Study Settings layer.

### Eigenmodes Progress Inspector

Selection:

```text
study.stage.eigenmodes.progress
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Solver phase | progress resource | Shows factorizing/solving/filtering/writing. |
| Progress percent | progress resource | Determinate when possible. |
| Current shift/window | progress resource | Interior-window visibility. |
| Candidate modes | progress resource | Shows active search. |
| Converged modes | progress resource | Shows numerical progress. |
| Accepted modes | progress resource | Shows result progress. |
| Current residual | progress resource | Shows convergence. |
| Target residual | solver policy | Context for current residual. |
| Outer iteration | progress resource | Solver activity. |
| Linear iteration | progress resource | KSP activity. |
| Last solver update | progress resource | Detects stuck backend. |
| Heartbeat age | stage execution | Transport liveness. |
| Stop reason | execution state | Completion/failure. |

Heartbeat may never replace solver phase/residual. If heartbeat is fresh but
solver phase is stale, show `stalled_solver_progress` rather than `running`.

### Eigenmodes Output Inspector

Selection:

```text
study.stage.eigenmodes.output
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Spectrum requested | output IR | Spectrum table. |
| Mode indices requested | output IR | Controls field payload storage. |
| Diagnostics requested | output IR | Residual/leakage/orthogonality. |
| Dispersion requested | output IR | k path output. |
| Store solution policy | output policy | All/first N/selected. |
| Field payload format | artifact spec | Zarr/JSON/binary. |
| Visualization profile | visualization state | Shared mode display controls. |

Mode visualization state is shared across all modes:

```text
analysis.eigen.modeDisplay = {
  view: "phase_rotated_real" | "real" | "imag" | "abs" | "phase",
  component: "full" | "x" | "y" | "z" | "magnitude",
  colorSource: "hsl_orientation" | "component" | "colormap" | "solid",
  colormap: "viridis" | "magma" | "coolwarm",
  vectorVisible: boolean,
  vectorScope: "surface" | "volume" | "selection",
  vectorBudget: number,
  phaseRad: number,
  animationEnabled: boolean,
  animationRateHz: number,
  clipPlane: future,
  shaderOpacity: future
}
```

This state is not per mode. Selecting another mode reuses the same display
profile.

### Eigenmodes Diagnostics Inspector

Selection:

```text
study.stage.eigenmodes.diagnostics
```

Fields:

| Field | Source | Justification |
|---|---|---|
| IR validation | validator | Authoring correctness. |
| Planner status | planner | Capability/execution resolution. |
| Operator diagnostics | operator artifact | Physics assembly. |
| Solver diagnostics | eigen diagnostics | Residuals, shifts, counts. |
| Artifact diagnostics | manifest | Missing/partial/cancelled output. |
| API resource status | resource hooks | Explains stale UI. |
| Unsupported reasons | capability matrix | Honest feature gates. |

### Frequency Response Stage Overview Inspector

Selection:

```text
study.stage.frequency_response
```

Visible fields:

| Field | Source | Contract |
|---|---|---|
| Product | constant `driven_response` | Distinguish from modal eigen. |
| Equation | physics contract | `(i omega M - L) q = b`. |
| Frequency count | `frequencies_hz` | Sweep size. |
| Frequency range | derived from list | MHz/GHz display. |
| Excitation summary | stage | Drive vector and phase. |
| Equilibrium source | stage | Linearization dependency. |
| Output observables | output IR | Response field, susceptibility, absorbed power. |
| Current progress | response progress resource | Completed frequency points. |
| Partial artifacts | progress/manifest | Shows whether results are inspectable before completion. |
| Stop reason | execution state | Completion/failure. |

Actions:

```text
Save Stage
Compute Selected Step
Compute From Selected
Stop Sweep
Open Response Sweep
Open Response Diagnostics
```

### Frequency Response Study Settings Inspector

Selection:

```text
study.stage.frequency_response.study_settings
```

Fields:

| Field | Widget | Source | Justification |
|---|---|---|---|
| Frequency list method | segmented control | stage | Manual list, range, file import later. |
| Frequencies | unit list editor | `frequencies_hz` | Core driven response input. |
| Frequency unit | select | UI-only | Hz/MHz/GHz display; IR stays Hz. |
| Relative tolerance | numeric input | solver policy | COMSOL exposes tolerance. |
| Reuse previous solution | select | solver policy | Important for sweeps. |
| AWE / reduced model | capability-gated switch | future solver policy | Only shown when implemented. |
| Auxiliary sweep | capability-gated section | future | Only when additional parameter sweep exists. |

Do not show `Time integrator`.

### Frequency Response Linearization Point Inspector

Same field set as eigenmodes linearization point, but with one additional row:

| Field | Source | Justification |
|---|---|---|
| Perturbation consistency | response diagnostics | Confirms response is around the same `m0` used by the operator. |

### Frequency Response Excitation Inspector

Selection:

```text
study.stage.frequency_response.excitation
```

Fields:

| Field | Widget | Source | Justification |
|---|---|---|---|
| Drive field x/y/z | vector input | `excitation_field_au_per_m` | Harmonic forcing. |
| Drive unit | read-only | A/m | SI clarity. |
| Phase | numeric input + degrees display | `excitation_phase_rad` | Phasor control. |
| Source kind | select | stage | Uniform field now, antenna later. |
| Harmonic perturbation enabled | derived | planner | COMSOL requires harmonic perturbation for modal response loads. |
| Projection | read-only diagnostic | operator | Confirms tangent projection. |
| Drive norm | derived | stage | Fast validation. |

Validation:

```text
Reject zero drive for production response unless user explicitly requests a
zero-drive validation run.
Reject non-finite phase.
Warn when drive is parallel to equilibrium everywhere and tangent projection is
near zero.
```

### Frequency Response Sweep Inspector

Selection:

```text
study.stage.frequency_response.sweep
```

Fields:

| Field | Source | Justification |
|---|---|---|
| Point count | frequencies | Work size. |
| Min/max frequency | frequencies | Range. |
| Step statistics | frequencies | Detect nonuniform sweeps. |
| Current frequency | progress | Runtime visibility. |
| Completed points | progress | Main progress metric. |
| Failed points | diagnostics | Partial result honesty. |
| Partial artifact count | manifest/progress | Whether results can be inspected. |
| Estimated remaining | progress | Optional, only if backend estimates. |

### Frequency Response Physics And Variables Inspector

Same structure as eigenmodes, with response-specific rows:

| Field | Source | Justification |
|---|---|---|
| Unknown | operator diagnostics | `delta_m(omega)` complex response. |
| Drive vector | excitation | RHS source. |
| Damping policy | stage | Usually active in response. |
| Observable basis | output IR | Amplitude/phase/susceptibility/power. |

### Frequency Response Solver Configuration Inspector

Fields:

| Field | Source | Justification |
|---|---|---|
| Solver family | diagnostics | Direct/GMRES/AWE. |
| Matrix form | diagnostics | Complex harmonic or real block. |
| Reuse factorization | solver policy | Performance. |
| Linear tolerance | solver policy | Residual quality. |
| Max linear iterations | solver policy | Runtime bound. |
| Current KSP reason | progress | Active solve status. |
| Response capability slice | capability matrix | Shows supported gamma/free/k0/static-periodic scope. |
| Unsupported lanes | capability matrix | GPU/nonzero-k/demag-k/magnetoelastic gates. |

### Frequency Response Progress Inspector

Fields:

| Field | Source | Justification |
|---|---|---|
| Solver phase | progress | Assembling/factorizing/solving/writing. |
| Current frequency | progress | Main live location. |
| Completed/total | progress | Determinate progress bar. |
| Current residual | progress | Convergence. |
| Linear iteration | progress | Solver activity. |
| Partial artifacts | progress | Inspectability during long runs. |
| Last solver update | progress | Stuck detection. |
| Cancel requested | cancel resource | User control. |
| Stop reason | execution state | Final status. |

### Frequency Response Output Inspector

Fields:

| Field | Source | Justification |
|---|---|---|
| Complex response field | output IR/artifact | 3D visualization. |
| Response amplitude | output IR/artifact | FMR chart. |
| Response phase | output IR/artifact | Phase chart/field. |
| Susceptibility tensor | output IR/artifact | Quantitative response. |
| Absorbed power density | output IR/artifact | FMR absorption. |
| Per-frequency metadata | artifacts | Point inspection. |
| Sweep table | artifact | Plot/table source. |

### Frequency Response Diagnostics Inspector

Same diagnostic groups as eigenmodes, with response-specific rows:

| Field | Source | Justification |
|---|---|---|
| Frequency-point failures | diagnostics | Long sweep partial failure handling. |
| RHS validation | diagnostics | Drive correctness. |
| Linear residual summary | diagnostics | Numerical quality. |
| Partial/cancelled artifact state | manifest | Honest result state. |

### Results Explorer Target

Results must be artifact-driven. The tree below is the target; each child is
created only when the corresponding resource exists, is in progress, or is
explicitly requested by the active stage.

```text
Results
  Modal Eigensolve
    Run Provenance
    Spectrum
    Modes
      Mode 1
      Mode 2
    Mode Visualization
    Dispersion
    Branches
    Diagnostics
    Artifacts
  Driven Frequency Response
    Run Provenance
    Sweep
    Frequency Points
      100 MHz
      125 MHz
    Observables
      Complex m
      Absorbed Power Density
      Susceptibility
    Response Visualization
    Progress
    Diagnostics
    Artifacts
  FMR Comparison
    Peaks
    Modal vs Driven Detuning
```

Creation rules:

```text
Modal Eigensolve:
  show if eigen spectrum, eigen diagnostics, eigen progress, or eigen stage exists

Driven Frequency Response:
  show if response progress, response sweep, response diagnostics, or response stage exists

FMR Comparison:
  show only when both modal and driven result families have compatible frequency
  data

Mode Visualization:
  show only when at least one mode field payload exists

Response Visualization:
  show only when at least one response field payload exists
```

No `Response Map` child unless the authored problem requested response-map
semantics or the manifest reports a response-map resource.

### Result Inspector Contracts

#### Modal Spectrum

Fields:

| Field | Source | Why |
|---|---|---|
| Mode count | spectrum | Result size. |
| Frequency range | spectrum | Scientific summary. |
| Unit | display formatter | MHz/GHz auto display. |
| Residual max | diagnostics/spectrum rows | Quality. |
| Completeness status | diagnostics | Best-effort vs certified. |
| Selected mode | UI selection | Links table/plot/3D. |
| Spectrum artifact | resource | Reproducibility. |

#### Modal Mode

Fields:

| Field | Source | Why |
|---|---|---|
| Mode index | spectrum row | Identity. |
| Frequency | spectrum row | Primary value. |
| Degenerate cluster | diagnostics | Avoid false ordering. |
| Residual | spectrum row | Quality. |
| Mass norm | diagnostics | Normalization. |
| Field payload | manifest/resource | 3D readiness. |
| Available views | field metadata | Real/imag/phase/abs controls. |
| Visualization profile | shared mode display state | Consistent controls across modes. |

Actions:

```text
Select Mode
Plot Mode 3D
Animate Phase
Stop Animation
Open Payload Metadata
```

#### Driven Sweep

Fields:

| Field | Source | Why |
|---|---|---|
| Frequency point count | sweep/progress | Result size. |
| Frequency range | sweep | Scientific summary. |
| Observable count | sweep | Available analysis. |
| Completed points | progress | Partial result state. |
| Failed points | diagnostics | Honesty. |
| Max residual | diagnostics | Quality. |
| Sweep artifact | resource | Reproducibility. |

#### Frequency Point

Fields:

| Field | Source | Why |
|---|---|---|
| Frequency | point metadata | Identity. |
| Solve status | point metadata | Partial failures. |
| Linear residual | point metadata | Quality. |
| Response field payload | resource | 3D readiness. |
| Observables present | point metadata | Available charts. |
| Phase reference | metadata | Correct interpretation. |

Actions:

```text
Plot Response Field 3D
Open Point Diagnostics
Copy Resource Path
```

#### FMR Peak

Replace the current flattened peak inspector with grouped sections:

```text
Identity
  source: modal | driven_response
  frequency
  sample/mode or frequency index
  validation

Physical Quantities
  amplitude
  absorbed power density
  phase
  linewidth
  Q factor

Provenance
  spectrum row or response point
  stage id
  solver family
  artifact path

Visualization
  field id
  payload readiness
  view selector
  shared display profile
  plot/animate/stop commands

Diagnostics
  residual
  missing quantities
  resource errors
```

Do not show binary layout, component count, payload encoding, raw tangent basis,
or transport paths in the primary FMR peak inspector. Those belong in an
advanced Resource Diagnostics section.

### Shared Visualization Controls For Modes And Response Fields

Mode and response visualization use the same control grammar as object field
visualization:

```text
View:
  real
  imaginary
  magnitude
  phase
  phase-rotated real

Component:
  full vector
  x
  y
  z
  magnitude

Color:
  HSL orientation
  component scalar
  colormap
  solid

Vectors:
  visible
  scope
  budget
  glyph scale

Surface shader:
  color source
  colormap
  range
  opacity

Future volume inspection:
  clip plane
  quarter cut
  transparency
```

One shared profile is stored per result family:

```text
analysis.eigen.modeDisplayProfile
analysis.frequency_response.fieldDisplayProfile
```

Not per mode or per frequency point. Selecting another mode/frequency point
must preserve the profile.

### Implementation Tasks

Task UI-1: Replace static stage child arrays.

Files:

```text
apps/control-room/src/modules/explorer/builders/study/eigenmodesStageNode.ts
apps/control-room/src/modules/explorer/builders/study/frequencyResponseStageNode.ts
apps/control-room/src/modules/explorer/builders/study/frequencyDomainStageTree.ts
apps/control-room/src/modules/explorer/builders/study/studyExplorerNodes.ts
```

Steps:

- [x] Add tests that free-boundary eigenmodes do not create Periodic Pairs or
      k-Path children.
- [x] Add tests that frequency response without response-map request does not
      create k/f Grid.
- [x] Add dynamic builder predicates for each child node.
- [x] Delete static `EIGENMODES_DETAIL_NODES` and `RESPONSE_DETAIL_NODES`.
- [x] Verify with `pnpm --dir apps/control-room test -- buildModelTree`.

Task UI-2: Replace generic contract inspectors with data-backed panels.

Files:

```text
apps/control-room/src/modules/inspector/panels/stages/EigenmodesStageInspector.tsx
apps/control-room/src/modules/inspector/panels/stages/FrequencyResponseStageInspector.tsx
apps/control-room/src/modules/inspector/panels/stages/StageInspectorFrame.tsx
apps/control-room/src/modules/inspector/panels/stages/StageInspectors.test.tsx
```

Steps:

- [x] Rename visible titles from `* Contract` to product labels:
      `Study Settings`, `Linearization Point`, `Solver Configuration`,
      `Progress`, `Output`, `Diagnostics`.
- [x] Remove rows that only say `not applicable` or future-gated prose.
- [x] Add missing-data groups that explain absent resources once per section.
- [x] Add progress fields listed above.
- [x] Verify with `pnpm --dir apps/control-room test -- StageInspectors`.

Task UI-3: Build product-split Results tree.

Files:

```text
apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts
apps/control-room/src/modules/explorer/explorerTypes.ts
apps/control-room/src/modules/explorer/explorerSelection.ts
apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts
```

Steps:

- [x] Create `results.modal_eigen.root` or keep existing kind only if naming
      migration cost is explicitly handled.
- [x] Create response root only from response stage/progress/sweep/diagnostics.
- [x] Create comparison only when modal and driven data both exist.
- [x] Remove unsupported `Response Map` from normal tree when not requested.
- [x] Verify selection routing tests.

Task UI-4: Refactor FMR peak inspector.

Files:

```text
apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/FmrPeakInspector.tsx
apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx
```

Steps:

- [x] Extract FMR peak detail into a focused component.
- [x] Group sections as Identity, Physical Quantities, Provenance,
      Visualization, Diagnostics.
- [x] Move binary transport details behind advanced Resource Diagnostics.
- [x] Verify active peak plot/select commands still work.

Task UI-5: Share visualization display profile across all modes.

Files:

```text
apps/control-room/src/modules/inspector/panels/FrequencyDomainModeDisplayControls.tsx
apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts
apps/control-room/src/kernel/visualization/analysisFieldOverlayCommandContributions.ts
apps/control-room/src/modules/viewport-3d/viewport3dStore.ts
```

Steps:

- [x] Add a test proving changing display profile on mode 1 persists when mode
      2 is selected.
- [x] Add a stop command for phase animation if absent.
- [x] Ensure animation does not trigger uncontrolled high-rate backend fetches.
- [x] Verify viewport smoke when this is implemented, because this touches 3D.

### Acceptance Criteria

- Study Explorer contains only nodes relevant to the authored problem, active
  capability, runtime state, or existing resources.
- Eigenmodes and Frequency Response are separate product trees.
- Frequency Domain Modal appears only as an explicit workflow once the IR can
  express it.
- Inspectors show scientific fields first and transport/resource internals only
  in diagnostics.
- Every inspector field has a source and a reason.
- Progress inspectors show solver phase, current iteration/frequency/shift,
  residual, last update, heartbeat age, and stop reason.
- Mode visualization uses one shared display profile across all modes.
- No UI copy uses `Contract` as a user-facing section title.
- No primary inspector row exists only to say that data is unavailable until a
  future resource appears.
- Frontend verification includes:

```bash
pnpm --dir apps/control-room test -- buildModelTree
pnpm --dir apps/control-room test -- explorerSelection
pnpm --dir apps/control-room test -- StageInspectors
pnpm --dir apps/control-room test -- FrequencyDomainInspectorPanel
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
```

When viewport display profile or animation changes are implemented, also run a
browser viewport smoke that checks a nonblank WebGL drawing buffer.

## 16. Implementation Order Summary

1. Freeze product split and docs.
2. Strengthen dense oracle diagnostics.
3. Add native frequency-domain contract skeleton.
4. Add PETSc/SLEPc managed runtime dependency.
5. Implement shared tangent operator.
6. Implement k=0 shift-invert modal solve.
7. Implement multi-shift frequency-window orchestration.
8. Add contour/FEAST interval lane.
9. Implement driven response as separate solver.
10. Wire IR, Python, planner, API, and UI.
11. Run validation ladder and promote capability statuses.

This order is mandatory because each layer proves a dependency for the next.
Skipping dense oracle diagnostics makes residual validation untrustworthy.
Skipping product split makes the UI and capability matrix lie. Skipping managed
runtime proof makes native FEM claims non-authoritative.
