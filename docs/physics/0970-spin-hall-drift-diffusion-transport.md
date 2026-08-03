# Spin Hall drift-diffusion transport

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-08-03
- Related ADRs: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Related specs: `docs/specs/spin-transport-runtime-contract-v1.md`
- Formula versions: `transport_constitutive.one_way.fullmag.v1`,
  `transport_constitutive.reciprocal.fullmag.v1`,
  `magnetoelectronic.fullmag.v2`,
  `sml_reservoir.fullmag.v2`,
  `dos_isotropic_nonmagnetic.fullmag.v1`
- Operator versions: `fv_spin_upwind_v1`, `structured_cross_gradient_v1`,
  `fem_charge_spin_broken_h1_mortar.v1`

The normative identifier categories and exact spellings are frozen by section
8.1 of the runtime contract.

## 1. Problem statement

Spin Hall physics in Fullmag is a solved charge-and-spin transport problem, not
an algebraic torque coefficient. This note defines the M1 one-way steady model,
the M2 reciprocal bidirectional quasistatic model, and the M3 transient model
with common signs, units, interfaces, weak forms, solver constraints, and
angular-momentum accounting across FDM and FEM.

The note is a target contract, not an implementation claim. Until the listed
gates pass, capabilities must remain at their evidence-supported status.

## 2. Physical model

### 2.1 Variables, indices, and electrochemical convention

`e>0`; `J_c` is conventional current. Spin voltage `mu_s` is the **full**
spin-channel splitting: local channels are `V+mu_s/2` and `V-mu_s/2`.
The charge-equivalent spin-current tensor `Q_ia` has first index `i` for flow
direction and second index `a` for spin polarization. For an oriented normal
`n`, positive outgoing spin flux is `q_s,a=n_i Q_ia`.

Define

```text
E_i    = -partial_i V,                         [V/m]
G_ia   = -0.5 partial_i mu_s,a.                [V/m]
mathcal J^s_ia = (hbar/2e) Q_ia.              [J/m^2]
```

`Q` is rank two and may never be reduced to an unlabelled 3-vector.

### 2.2 Charge transport and the M1/M2 constitutive blocks

M1 charge transport on conducting domain `Omega_c` is electroquasistatic:

```text
J_c = sigma E,
div J_c = 0.
```

M1 deliberately omits reciprocal spin-to-charge feedback:

```text
J_c,i = sigma E_i,
Q_ia  = sigma_s G_ia
        + P sigma E_i m_a
        + theta_SH sigma epsilon_ika E_k.
```

Thus M1 has direct SHE and polarized charge-to-spin flow, but neither
longitudinal reciprocal feedback nor iSHE in `J_c`.

M2 first defines the 3-D magnetoresistive current

```text
J_mr = sigma_perp E
       +(sigma_parallel-sigma_perp)(m dot E)m
       +sigma_AHE m x E,
```

where PHE is contained in the symmetric anisotropic term and AHE in the
antisymmetric term. Full reciprocal transport is then

```text
J_c,i = J_mr,i
        + P sigma m_a G_ia
        + theta_SH sigma epsilon_ija G_ja,
Q_ia  = sigma_s G_ia
        + P sigma E_i m_a
        + theta_SH sigma epsilon_ika E_k.
```

Here `sigma` is the scalar reciprocal reference conductivity from the complete
base charge material. In a magnetoresistive material it is exactly
`MagnetoresistiveMaterial.base.sigma_Spm`; `sigma_parallel`, `sigma_perp`, and
`sigma_AHE` define `J_mr` but do not silently replace that reciprocal scalar or
add a second isotropic current. The same base material owns relative
permittivity and quasistatic validity bounds.

These terms are one constitutive block; iSHE is not a separately chosen sign.
Contraction with `(E,G)` makes the `P` block symmetric and SHE/iSHE block
antisymmetric. Let `Sigma_mr^sym` be the symmetric AMR/PHE charge-conductivity
tensor. Positivity of the complete coupled dissipative block requires

```text
lambda_min(Sigma_mr^sym) sigma_s - P^2 sigma^2 > 0.
```

For the parameterization above,
`lambda_min(Sigma_mr^sym)=min(sigma_parallel,sigma_perp)`. In the isotropic
case `sigma_parallel=sigma_perp=sigma`, this reduces to

```text
sigma > 0,
sigma_s-P^2 sigma > 0.
```

Eliminating `E` at fixed `J_c` gives longitudinal spin diffusion coefficient
`sigma_s-P^2 sigma`; `sigma_s=sigma` gives `sigma(1-P^2)`. A symbolic Onsager
and power-production oracle freezes index order and signs before M2 backend
work.

### 2.3 Spin balance and reaction channels

```text
C_s partial_t mu_s,a + partial_i Q_ia
  = -R_sf,a-R_J,a-R_phi,a,
R_sf  = sigma_s/(2 lambda_sf^2) mu_s,
R_J   = sigma_s/(2 lambda_J^2) (mu_s x m),
R_phi = sigma_s/(2 lambda_phi^2) m x (mu_s x m).
```

M1/M2 are quasistatic (`partial_t mu_s=0`). M3 requires a physical,
versioned `C_s`; assigning `C_s=1` is dimensionally invalid. For the canonical
isotropic non-magnetic reduction, the public material may provide the
per-spin density of states `N_0 [J^-1 m^-3]` and the planner derives

```text
C_s = e^2 N_0,
e = 1.602176634e-19 C.
```

An explicit scalar `C_s` remains a calibrated susceptibility reduction. If
both `C_s` and `N_0` are authored, they must agree at relative tolerance
`1e-12`; a ferromagnetic material without a named susceptibility tensor or
documented reduction is fail-closed. Outside a
ferromagnet `P=R_J=R_phi=0`. Every active length is strictly positive;
`lambda=infinity` is represented by an explicit disabled reaction, never a
zero coefficient. Only `R_J+R_phi` transfers angular momentum to the magnet:

```text
T_tr,G = -gamma_e/M_s (hbar/2e)(R_J+R_phi).
```

Spin-flip transfers to a separate reservoir. In transient mode accumulation
prevents replacing this expression by the entire flux divergence.

### 2.4 Boundary conditions and charge gauge

Charge BCs are `VoltageElectrode`, `Ground`, `TotalCurrentElectrode`,
`Insulating`, and explicit periodic potential drop. A reference potential or
zero-mean constraint is mandatory. A total-current electrode has constant
unknown electrode potential plus the prescribed integrated flux.
When no charge boundary is authored, the FEM reference slice may insert natural
zero normal charge flux on every external face only with a compatible zero-mean
gauge; that inserted default is mandatory provenance. Once any charge boundary
is authored, every external face must be covered exactly once.

Spin BCs are `SpinInsulating` (`n_iQ_ia=0`), `SpinSink` (`mu_s=0`),
`SpecifiedSpinPotential`, `SpecifiedSpinFlux`, and `PeriodicSpin`. Default
`SpinInsulating` is permitted only when no spin contact is authored and must be
visible in the UI and provenance. Conflicting BCs fail closed.

The FEM v1 ABI applies BCs by MFEM boundary attribute, but authoring selectors
identify external faces. Before lowering, the planner must retain those face
identities and prove that every face carrying one attribute belongs to the same
charge assignment and, independently, to the same spin assignment. Selecting
only part of a shared attribute is not representable and fails closed; multiple
faces of that attribute are legal when one assignment explicitly owns all of
them. Natural all-external defaults satisfy this proof and remain explicit in
provenance.

### 2.5 Transparent and resistive spin interfaces

For a transparent interface with one fixed normal:

```text
[V]=0, [J_c dot n]=0, [mu_s]=0, [n_iQ_ia]=0.
```

For oriented `N -> F`, set `Delta V=V_N-V_F` and
`Delta mu_s=mu_s,N-mu_s,F`. Because `mu_s` is the full splitting,

```text
j_c,n = (G_up+G_down) Delta V
        +0.5(G_up-G_down) m dot Delta mu_s,
q_s,parallel = [(G_up-G_down) Delta V
        +0.5(G_up+G_down) m dot Delta mu_s]m,
q_abs,perp = G_r m x (Delta mu_s x m)
             +G_i(Delta mu_s x m).
```

All interface conductances have `S/m^2`. In `full_absorption`, the old
`q_SML=G_SML Delta mu_s` wire law is rejected: it does not identify a
reservoir or close the spin balance. The canonical reservoir law is:

```text
q_NR = G_N (mu_s,N-mu_R),
q_FR = G_F (mu_s,F-mu_R),
q_RL = G_R mu_R,
q_NR+q_FR=q_RL,
mu_R=(G_N mu_s,N+G_F mu_s,F)/(G_N+G_F+G_R),
n dot Q_N=q_s,parallel+q_abs,perp+q_NR,
n dot Q_F=q_s,parallel-q_FR.
```

Only `q_abs,perp` torques the magnet; `q_RL` is delivered to the lattice. The
surface production is
`0.5*(G_N|mu_s,N-mu_R|^2+G_F|mu_s,F-mu_R|^2+G_R|mu_R|^2)>=0`, with `G_R>0`
required for the name spin-memory loss. Dimensionless literature `delta`
requires an explicit adapter. Incoming, backflow, absorbed, reservoir-arm,
lattice, and torque fluxes are separately observable and balance to solver
tolerance. `sml_reservoir.fullmag.v2` is currently an authoring/IR contract;
the FDM/FEM production weak-form realization remains fail-closed.

### 2.6 Time coupling M1–M3

Strict M1 evaluates, at every required RK stage:

```text
t_stage=t_n+c_i dt,
J_c=J_c(t_stage),
solve steady mu_s for m_i,
form transport torque,
form the complete Gilbert-explicit RHS.
```

Accepted-step-only torque refresh is an explicitly degraded approximation and
does not retain nominal RK order without evidence.

M2 solves the coupled nonlinear quasistatic block at every required stage:

```text
(V^k,mu_s^k) -> (J_c^k,Q^k) -> (V^(k+1),mu_s^(k+1)).
```

Convergence needs independently scaled charge/spin residuals, relative changes
of `J_c` and `mu_s`, electrode balance, angular-momentum balance, and

```text
dt ||delta T_transport|| <= eta_transport LTE_m
```

The norm is a backend-independent volume-normalized `L2` norm on the union
`Omega_T` of magnetic target regions receiving transport torque:

```text
||delta T_transport||_T =
  sqrt[integral_Omega_T |T_transport^(k+1)-T_transport^k|^2 dV
       / integral_Omega_T 1 dV],             [1/s]

LTE_m = sqrt[integral_Omega_T |delta m_embedded|^2 dV
             / integral_Omega_T 1 dV].       [1]
```

Thus `dt ||delta T_transport||_T` and `LTE_m` are both dimensionless and
`eta_transport` is dimensionless, with starting value `0.1`. Empty
`Omega_T` makes the transport-torque criterion vacuous, but does not disable
charge/spin residual and balance criteria. FDM evaluates the same integral as
`sum_K V_K |.|^2/sum_K V_K` over active target cells. FEM evaluates it with
the consistent vector `L2` mass matrix (or quadrature algebraically equivalent
to that matrix), not an unweighted coefficient-vector norm. Masked/nonmagnetic
degrees of freedom carry zero weight. Both norms use the same target scope and
the embedded LLG estimator before magnetization renormalization; this freezes
cross-backend weighting and prevents mesh-dependent solver tolerances.

Failure of any convergence criterion rejects the outer LLG step; it does not
commit the last nonlinear iterate.

M3 is stiff. Production `coupled_imex_ark2` is the Ascher--Ruuth--Spiteri
L-stable `(2,3,2)` pair, frozen as

```text
gamma = (2-sqrt(2))/2,
delta = -2 sqrt(2)/3,

A_implicit = [[gamma,       0],
              [1-gamma, gamma]],       b_implicit = [1-gamma, gamma],

A_explicit = [[0,       0,       0],
              [gamma,   0,       0],
              [delta, 1-delta,   0]],  b_explicit = [0, 1-gamma, gamma].
```

The leading zero row which pads the implicit tableau is part of the additive
stage alignment. Diffusion and all spin reactions are implicit. Transient
drives and the LLG/local-field partition are explicit or semi-implicit, but
all partitions share stage times and one rollback transaction. The scheme has
no invented embedded pair: adaptive error control uses one full step versus
two half steps, scales their difference by `1/(2^2-1)`, and accepts the two
half-step state. Both trials start from the same committed state and may not
publish fields, caches, nonlinear history, or telemetry until acceptance.

The small fully implicit reference is constant-step BDF2,

```text
C_s (3 mu_s^(n+1)-4 mu_s^n+mu_s^(n-1))/(2 dt)
  + div Q(mu_s^(n+1), V^(n+1), m^(n+1))
  = -R(mu_s^(n+1),m^(n+1)),
```

bootstrapped by backward Euler from an authored initial state or an explicitly
requested equilibrium solve. A step-size change invalidates this constant-step
history in v1 and restarts with backward Euler; silently applying the
constant-step formula to unequal steps is prohibited. `explicit_dp45` is
unsupported for transient spin until a compatible partitioned-order proof
exists. Subcycling requires a coupled error/order proof.

The public owner of this coupled time algorithm is the stage dynamics choice:
transient spin requires `LLG(integrator="coupled_imex_ark2")`. The
`SpinSolverPolicy.engine` field continues to select the spatial linear/nonlinear
transport solver and must not be overloaded with time-integration semantics.
The existing adaptive-timestep contract controls ARS step doubling; fixed-step
execution disables error-based rejection but still executes the same versioned
ARS stages. `coupled_bdf2_small_oracle.v1` remains validation-only and is not a
production authoring choice in M3.

### 2.7 Symbols and SI units

| Symbol | Meaning | SI unit / condition |
|---|---|---|
| `V`, `mu_s` | charge potential, full spin splitting | V |
| `E`, `G` | charge/spin driving gradients | V/m |
| `J_c`, `Q_ia`, interface fluxes | charge-equivalent current density | A/m^2 |
| `sigma`, `sigma_s`, `sigma_parallel/perp`, `sigma_AHE` | conductivity | S/m |
| `P`, `theta_SH` | signed dimensionless coefficients | 1, finite |
| `C_s` | spin capacitance/susceptibility | A s V^-1 m^-3, `>0` in M3 |
| `N_0` | per-spin density of states for the canonical DOS adapter | J^-1 m^-3, `>0`; `C_s=e^2N_0` |
| `lambda_sf/J/phi` | reaction lengths | m, `>0` when active |
| `R_sf/J/phi` | volumetric spin sink | A/m^3 |
| `G_up/down/r/i/SML` | interface conductance | S/m^2 |
| `m` | reduced magnetization | 1 |
| `T_tr,G` | Gilbert torque source | s^-1 |
| `delta T_transport` | change of transport Gilbert-source torque between nonlinear iterates | s^-1 |
| `||.||_T` | volume-normalized vector `L2` norm on active magnetic torque targets | unit of its argument |
| `delta m_embedded`, `LTE_m` | embedded LLG state error and its target-domain norm before renormalization | 1 |
| `eta_transport` | allowed transport-to-outer-error fraction | 1; initial contract `0.1` |
| `dt` | current outer LLG step size | s, `>0` |

### 2.8 Assumptions and validity limits

The model is local, diffusive, and electroquasistatic. Its anisotropic
reciprocal material must satisfy
`min(sigma_parallel,sigma_perp) sigma_s-P^2 sigma^2>0`; checking only
`sigma_s-P^2 sigma>0` is valid solely for the isotropic specialization. It excludes ballistic
transport, first-principles tunnelling, full Maxwell displacement current,
unresolved interfacial quantum chemistry, and implicit spin pumping. Planner
warns or rejects when device dimensions approach the mean free path. NaN/Inf,
nonpositive dissipative coefficients, invalid references, missing charge gauge,
nonpositive active lengths, M1+iSHE, or transient without `C_s` are invalid.

## 3. Numerical interpretation

### 3.1 FDM finite-volume contract

`V`, `mu_s`, `m`, and materials are cell-centred. `J_c` and normal `Q` are
single oriented face fluxes. For cell `K`,

```text
sum_f A_f J_c,f dot n_Kf = 0,
C_s V_K d(mu_s,K)/dt+sum_f A_f Q_f dot n_Kf
  = -V_K(R_sf+R_J+R_phi)_K.
```

For orthogonal M1 faces `K|L`,

```text
sigma_f = 2 sigma_K sigma_L/(sigma_K+sigma_L),
J_c,f dot n_Kf = -sigma_f(V_L-V_K)/d_KL,
Q_diff,f,a dot n_Kf = -0.5 sigma_s,f
  (mu_s,L,a-mu_s,K,a)/d_KL.
```

Inside one material, `fv_spin_upwind_v1` uses

```text
q_f,a = Q_diff,f,a
 +P_f sigma_f(E_f dot n_f)m_f,a
 +theta_SH,f sigma_f n_i epsilon_ika E_f,k.
```

`m_f` is upwind with the signed polarized flux; central averaging exists only
as `fv_spin_central_reference_v1`. `structured_cross_gradient_v1` obtains the
normal electric field from the two-cell difference and tangential components
from averaged central cell gradients (9-point in 2-D, 27-point in 3-D), with
BC-consistent one-sided reconstruction. Direct SHE and polarized contributions
are summed before one face flux is inserted with opposite cell signs.
Material interfaces use the explicit interface law, never arithmetic averaging.

For the CPU-double structured oracle, `SpecifiedSpinFlux` is always the
outward-normal quantity `n_i Q_ia`; storage in the globally positive face
orientation therefore negates it on minimum-coordinate faces. The operator
identifier is explicit: `fv_spin_upwind_v1` selects `m_f` from the upstream
cell using the signed polarized face flux, while
`fv_spin_central_reference_v1` uses the central magnetization only as a
convergence oracle. Cross-region faces fail closed without one oriented
transparent or mixing-conductance descriptor. Mixing records longitudinal
injection/backflow, transverse absorption, and spin-memory loss separately;
only transverse absorption contributes to magnetic torque. Internal contacts
are likewise oriented structured faces with independent outward BCs on their
selected sides.

CPU double engines are matrix-free CG/AMG for symmetric M1 charge and block
GMRES for spin; M2 uses block GMRES because Hall/iSHE make the system
nonsymmetric. Residual and charge/spin balance are independently recomputed.
CUDA engines keep operators and state resident; FP64 parity and transfer audit
precede separate FP32 high-contrast/thin-layer qualification.

For the FDM M2 block, GMRES stopping is defined in the block-preconditioned
dimensionless norm. If `b_p = P b`, the relative stopping scale is
`max(abs_tol, rel_tol ||b_p||_2)` for a nonzero right-hand side; a zero
right-hand side uses `abs_tol` directly. There is no arbitrary `max(||b_p||,1)`
floor. Such a floor changes a relative tolerance into an unrelated absolute
residual for thin, highly anisotropic cells (for example, a `100 nm x 100 nm x
1 nm` stack), and can reject a physically converged N/F solve. The independently
recomputed integrated electrode and angular-momentum balance gates remain
mandatory after the linear solve.

`gmres_restart` is the initial Krylov basis length, not a hard promise that a
short basis will remain stable on every mesh. If a completed restart cycle still
has a residual above `100 * max(abs_tol, rel_tol ||b_p||_2)`, the FDM reference
solver doubles the basis up to the remaining iteration budget. This bounded
adaptive restart preserves the low-memory policy for easy cases while avoiding
false non-convergence of long-wavelength modes on refined, thin N/F stacks.
Boundary flux evaluation reuses the cell gradients assembled for the operator;
it must not recompute a full-grid gradient field once per boundary face.

The FDM CPU reference lane uses a multiplicative block-line preconditioner on
grids with at least two nontrivial axes. Each line factors a four-variable
block-tridiagonal approximation (charge plus three spin-potential components)
with diffusion, reaction, interface, and boundary diagonal terms. Consecutive
line sweeps apply a residual correction; they do not replace the physical
operator and deliberately omit tangential SHE skew terms and `G_i` from the
approximation. One-dimensional grids retain the block-Jacobi fallback. A
neutral paired-voltage cold start is used only when the mesh has at least two
nontrivial axes; otherwise the zero state remains the safe fallback. The source
map is `coupled_charge_spin.rs::initial_state_guess`,
`coupled_charge_spin.rs::line_preconditioners`, and
`coupled_block_linear.rs::BlockLinePreconditioner`.

### 3.2 FEM/MFEM weak-form contract

Transparent interfaces may use conforming `H1`. Finite-resistance/mixing/SML
interfaces require subdomain/broken `H1 P1` for `V` and `[H1 P1]^3` for
`mu_s`, with independent traces. A globally conforming space that forces
`Delta V=Delta mu_s=0` is prohibited.

For charge test `w` and spin test `v`:

```text
integral grad(w) dot J_c(V,mu_s,m) dOmega
 = integral_boundary w j_n dGamma,

integral v dot C_s partial_t(mu_s) dOmega
 -integral grad(v):Q dOmega
 +integral v dot(R_sf+R_J+R_phi)dOmega
 +integral_Gamma v dot q_out dGamma = 0.
```

The interface contribution is assembled once on an oriented shared surface
using both traces. Baseline uses subdomain spaces plus mortar coupling;
Nitsche/DG requires a new stability-qualified formula version. M1 is block
triangular and may solve charge before spin. M2 has both off-diagonal blocks,
is nonsymmetric, and may not use CG.

CPU production ownership separates spaces, assembly, BC, solve, projection,
and telemetry under native MFEM modules. GPU realization uses hypre/libCEED
device operators and persistent state. `mfem_bridge.cpp` carries descriptors;
it does not own physics. Strict GPU forbids CPU solves and hidden hot-loop
vector transfers.

### 3.3 Hybrid

No hybrid spin-transport capability is validated here. Any future coupling
must conserve the same oriented face/interface flux, preserve `Q_ia` component
order and units, publish transfer/projection error, and demonstrate convergence
against independent FDM and FEM double oracles.

## 4. API, IR, planner, runtime, and workspace impact

### 4.1 Python API surface

Canonical public constructs are `CurrentTransport`, `SpinDriftDiffusion`,
`DriftDiffusionSpinTorque`, transport materials, oriented interfaces, spin
boundaries, and solver parameters. Drives use one `TimeEnvelope`. Materials
carry signed `theta_sh/P`, conductivities, lengths, and optional physical
`spin_capacitance`. `DriftDiffusionSpinTorque` consumes a named solve and may
not accept a private current or polarization shortcut.

For the reciprocal M2 authoring contract, `CurrentTransport` accepts
`coupling="bidirectional"` (or the resolved model name
`model="magnetoresistive_poisson"`) only with a complete Ohmic charge solve.
Every charge-material assignment must carry the base `sigma_Spm` plus finite,
positive `sigma_parallel_Spm` and `sigma_perpendicular_Spm`, and finite
`sigma_AHE_Spm`. The charge policy is the block operator
`fdm_coupled_charge_spin_fv_block_gmres.v1`; its physical residual is
`transport_balance_integrated_l2.v1`. `ReciprocalNonlinearSolverPolicy`
provides positive `gmres_restart` and `max_picard_iterations`, positive
`relative_update_tolerance`, and `0 < eta_transport <= 1`.

`Problem` owns the source coupling and lowers the linked spin module to
`transport_constitutive.reciprocal.fullmag.v1`; a spin module cannot override
the source with an independent coupling. Reciprocal authoring is steady-only
until a transient M2 contract is published. Python, SceneDocument, the
resource-first Rust authoring schema, and the Control Room inspector preserve
these fields. This is an authoring/reference contract: the UI advertises the
M2 lane as `semantic_only`, and it must not be interpreted as a production
FDM/FEM/GPU execution guarantee.

### 4.2 ProblemIR representation

Typed IR includes `SpinTransportModuleIR`, charge/spin materials,
`SpinInterfaceIR`, `SpinBoundaryIR`, `DriftDiffusionTorqueIR`, and resolved
transport/integrator plans. It stores formula/interface versions, full units,
oriented region/surface references, BC, tolerances, source identity, derived
resolved coupling, and requested execution. Public coupling is owned only by
the referenced `CurrentTransport`; the spin module has no independent coupling
field. Lowering copies and validates the source value, while normalization
rejects a conflicting legacy spin-side value. A legacy placeholder lacking
domains/materials/BCs cannot migrate automatically and fails with a versioned
diagnostic.

### 4.3 Planner and capability matrix

Capabilities are separately scoped:
`transport.charge.ohmic`, `transport.charge.magnetoresistive`,
`transport.spin.steady_drift_diffusion`,
`transport.spin.transient_drift_diffusion`, `transport.spin.direct_she`,
`transport.spin.inverse_she`, `transport.spin.mixing_conductance`, and
one-way/bidirectional coupling. Planner resolves one engine, enforces solver
symmetry, positivity, validity, stage cadence, strict residency, and records
requested/resolved lane. `validated` is workload/lane/precision/BC scoped.

### 4.4 Runtime, quantities, provenance, OpenAPI, and UI

Transport workflow owns `V`, `mu_s`, `J_c`, and `Q`; torque only consumes
outputs. Quantities include `V_electric [V]`, `J_charge [A/m^2]`,
`spin_potential [V]`, `spin_current_tensor [A/m^2]`, interface normal flux,
and transport torque. `Q` uses nine FMVP components with metadata
`row_major_Q_ia`, flow/spin axes, location, and scope.

Telemetry includes scaled residuals, iterations, reason, preconditioner,
operator revision, balances, stage refreshes, timings, nonlinear iterations,
and H2D/D2H counts. Provenance records full splitting convention, index order,
interfaces, normalized materials, BC/tolerances, formula versions,
requested/resolved execution, and revisions.

Resource-first API projects current transports, spin transports, interfaces,
and torques from one revisioned SceneDocument; heavy tensors remain on the
binary data plane. Dedicated Explorer/Inspector nodes author and inspect model,
units, orientation, qualification, residual, and freshness. UI/Python export
must satisfy normalized four-path round-trip equality. The current inspector
round-trips M2 conductivity tensors and reciprocal nonlinear solver policy as
typed fields; unknown or incomplete M2 records stay read-only/fail-closed, and
the capability result remains `semantic_only` until the workload gates below
are closed.

The executable FEM M1 v1 slice is deliberately narrower than the general
model: CPU, double precision, `execution_mode=strict`, conforming H1/P1,
transparent interfaces, and no LLG/Oersted stage coupling. Its C ABI has one
linear tolerance/iteration policy shared by the charge CG and spin GMRES
solves. Planning therefore requires the authored charge and spin linear
policies to be exactly equal; it must never synthesize a hidden policy with
minimum tolerances or maximum iteration counts. The resolved descriptor keeps
the distinct `cg` and `gmres` engine identities, the charge/spin domain masks,
explicit insulating marker sets, transparent interface identities, and any
authored torque target. Capability status is `reference_executable`; the
independent evidence axes are `implementation_state=executable` and
`validation_state=algebra_validated` for the exact bounded validation scope.
Mixing/SML, specified spin flux, periodic spin boundaries, and normal current
electrodes fail before native execution.

Every successful FEM M1 solve publishes revisioned canonical field records for
`V_electric` (`V`, scalar), `J_charge` (`A/m^2`, `xyz`), `spin_potential`
(`V`, `xyz`), `spin_current_tensor` (`A/m^2`, nine components in
`row_major_Q_ia` order), and `torque_stt` (`1/s`, `xyz`). These are node-located
and scoped to the named transport module's full resolved solve domain. The
runner publishes them through the canonical `ExecutedRun.field_snapshots`
carrier with monotonic revisions; the v2 field resource/data plane reads the
persisted field artifacts. The summary transport artifact is supplementary and
is not a substitute for these quantity records.

Artifact persistence is owned by the run's `ArtifactRecorder`: streaming runs
must enqueue these records before the pipeline is closed, while in-memory runs
must serialize the same catalog-owned units and component metadata. M1 accepts
exactly one steady FEM transport module per run because the current v2 field
resource identity is the canonical quantity id; multiple module-scoped records
with the same quantity id fail before native execution rather than overwriting
one another. Requested field schedules for these steady quantities select the
already-solved records and must not query the time-domain FEM preview ABI.

## 5. Validation strategy

### 5.1 Analytical and algebraic checks

| Workload | Oracle |
|---|---|
| `charge_uniform_bar_v1` | linear `V`, constant conserved current |
| `charge_layered_series_v1` | exact series resistance |
| `spin_1d_diffusion_v1` | sinh/cosh profile |
| `spin_relaxation_modes_v1` | reaction eigenvalues |
| `she_1d_film_v1` | SHE profile with zero-flux/mixing BC |
| `mixing_flux_balance_v2` | reservoir interface algebra, entropy and torque sign |
| `theta_sh_zero_v1` | no SHE source |
| `lambda_limits_v1` | disabled-reaction limits |
| M2 Onsager oracle | reciprocal signs and nonnegative dissipation |
| M3 decay | exponential and diffusion-eigenmode decay |

### 5.2 Cross-backend and convergence qualification targets

The production qualification still requires each continuum workload at at least
three spatial resolutions and independent FDM/FEM mesh families. Common-limit
FDM/FEM convergence, GPU-double vector/tensor parity, M3 temporal order, and
stiff-limit convergence to steady M1/M2 are not established by the current M1
reference slice. BORIS and published models remain planned comparisons after
explicit unit/sign conversion, not primary proof.

The current FDM CPU-double M2 reference slice has an executable six-case
matrix (three N/F resolutions and two tolerances) with independent charge and
spin residuals; its artifact and binary identity are recorded in the audit
plan. The corresponding BORIS matrix is intentionally diagnostic only: after
the explicit `Q_ia=Js_ia/MUB_E` normalization, potential profiles improve with
refinement but `mu_s`, interface fluxes, and torque do not meet the comparison
contract. This does not promote either solver to cross-backend validation.

### 5.3 Regression and quantitative gates

Tests cover local FV residual, electrode balance, anisotropic N/F balance,
material jumps, normal
involution, tensor component order, missing gauge/conflicting BC, positivity,
stage refresh, nonlinear rejection/rollback, checkpoint/restart, strict-GPU
transfer audit, and full authoring/export/data-plane inspection. Starting
double linear residual is `1e-10`; FP32 is `1e-6`. Charge balance targets
`1e-10` double and `1e-6` single; spin flux/torque balance is at most ten times
linear-solver relative tolerance.

## 6. Completeness checklist

- [ ] Python transport API and validation
- [ ] ProblemIR, migration, planner, and capabilities
- [ ] FDM CPU M1 oracle and M2/M3 implementations
- [ ] FEM CPU/MFEM M1 oracle and M2/M3 implementations
- [ ] FDM/FEM GPU FP64 parity and strict residency
- [ ] Physical M3 IMEX integrator and common rollback
- [ ] Quantities, tensor codec, telemetry, and provenance
- [ ] Resource-first API and dedicated workspace inspectors
- [ ] Cross-backend convergence and managed/browser evidence

Unchecked items are not implied by publication of this note.

## 7. Known limits and deferred work

Ballistic and tunnelling transport, first-principles interfaces, Rashba–Edelstein
physics, spin pumping, eddy/displacement currents, higher-order FEM, and hybrid
domain coupling require separate notes. Spin pumping cannot be hidden in
`alpha`; dimensionless SML parameters need explicit conversion.

### 7.1 FEM CPU M1.3 implementation evidence

The native module `backends/fem/cpu/mfem/transport/steady_transport.*`
implements the CPU-double, conforming `H1 P1` M1 oracle for transparent
interfaces under formula
`transport_constitutive.one_way.fullmag.v1` and operator
`fem_charge_spin_conforming_h1_p1.transparent.v1`. It owns charge/spin spaces,
assembly, essential voltage/spin-potential boundary data, insulating natural
boundaries, charge gauge validation, CG/GMRES solves, consistent `L2` torque
projection, independently reassembled weak residuals, and global conservative
flux/reaction balance outside `Context` and `mfem_bridge.cpp`.

The managed gate `just verify-fem-steady-transport-native-contract` executes a
linear charge bar, an aligned two-material series-resistance interface, missing
gauge rejection, the one-dimensional spin-diffusion `sinh` profile, direct-SHE
sign and balance, torque projection, and fail-closed mixing-interface behavior.
This evidence publishes only the named `reference_executable`, CPU-double,
conforming-`H1 P1`, transparent-interface M1 slice through ProblemIR, planner,
native runtime, canonical quantities, artifacts, and v2 reads. It is not a full
production transport capability. Total-current and periodic electrodes,
specified spin flux, `H(curl)`/broken-H1 mortar mixing or SML,
hypre/libCEED production preconditioners, GPU residency, stage coupling, and
FDM/FEM common-limit convergence remain unchecked work in sections 5 and 6.

## 8. References

1. T. Valet and A. Fert, Phys. Rev. B 48, 7099 (1993), DOI: 10.1103/PhysRevB.48.7099.
2. S. Zhang, P. M. Levy, and A. Fert, Phys. Rev. Lett. 88, 236601 (2002), DOI: 10.1103/PhysRevLett.88.236601.
3. C. Abert et al., Comput. Math. Appl. 68, 639–654 (2014), DOI: 10.1016/j.camwa.2014.07.010.
4. C. Abert et al., Sci. Rep. 5, 14855 (2015), DOI: 10.1038/srep14855.
5. J. L. García-Cervera and X.-P. Wang, J. Comput. Phys. 224 (2007), DOI: 10.1016/j.jcp.2006.10.029.
6. J. E. Hirsch, Phys. Rev. Lett. 83, 1834 (1999), DOI: 10.1103/PhysRevLett.83.1834.
7. S. Zhang, Phys. Rev. Lett. 85, 393 (2000), DOI: 10.1103/PhysRevLett.85.393.
8. Y.-T. Chen et al., Phys. Rev. B 87, 144411 (2013), DOI: 10.1103/PhysRevB.87.144411.
9. A. Brataas, Yu. V. Nazarov, and G. E. W. Bauer, Phys. Rev. Lett. 84, 2481 (2000), DOI: 10.1103/PhysRevLett.84.2481.
10. K. Xia et al., Phys. Rev. B 65, 220401(R) (2002), DOI: 10.1103/PhysRevB.65.220401.
11. Y. Tserkovnyak, A. Brataas, and G. E. W. Bauer, Phys. Rev. Lett. 88, 117601 (2002), DOI: 10.1103/PhysRevLett.88.117601.
12. U. M. Ascher, S. J. Ruuth, and R. J. Spiteri, Appl. Numer. Math. 25,
    151--167 (1997), DOI: 10.1016/S0168-9274(97)00056-1; the published
    `(2,3,2)` tableaus and L-stability contract define `coupled_imex_ark2`.
13. BORIS transport sources under `external_solvers/BORIS/Boris`, used as comparative implementation evidence only.
