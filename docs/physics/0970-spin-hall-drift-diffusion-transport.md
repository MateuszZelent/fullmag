# Spin Hall drift-diffusion transport

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-08-12
- Related ADRs: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Related specs: `docs/specs/spin-transport-runtime-contract-v1.md`
- Formula versions: `transport_constitutive.one_way.fullmag.v1`,
  `transport_constitutive.reciprocal.fullmag.v1`,
  `magnetoelectronic.fullmag.v2`,
  `sml_reservoir.fullmag.v2`,
  `dos_isotropic_nonmagnetic.fullmag.v1`
- Operator versions: `fv_charge_harmonic_v1`,
  `fv_charge_mixing_series_trace.v1`,
  `fv_spin_upwind_v1`, `structured_cross_gradient_v1`,
  `fdm_exact_face_current_electric_reconstruction.v1`,
  `fdm_transport_torque_cell_surface_balance.v1`,
  `fem_charge_spin_broken_h1_mortar.v1`,
  `fem_charge_spin_conforming_h1_p1.transparent.v1`,
  `fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1`

The normative identifier categories and exact spellings are frozen by section
8.1 of the runtime contract.

(problem-statement)=
## 1. Problem statement

Spin Hall physics in Fullmag is a solved charge-and-spin transport problem, not
an algebraic torque coefficient. This note defines the M1 one-way steady model,
the M2 reciprocal bidirectional quasistatic model, and the M3 transient model
with common signs, units, interfaces, weak forms, solver constraints, and
angular-momentum accounting across FDM and FEM.

The note is a target contract, not an implementation claim. Until the listed
gates pass, capabilities must remain at their evidence-supported status.

(governing-equations)=
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

Charge BCs are `VoltageElectrode`, `Ground`, `NormalCurrentElectrode`,
`Insulating`, and explicit periodic potential drop. A reference potential or
zero-mean constraint is mandatory. The public `NormalCurrentElectrode`
prescribes a uniform outward-normal current density in `A/m^2` on each selected
surface. The native FDM CPU binding now materializes that public density
boundary as exact selected external structured faces, each with area,
outward-normal sign, adjacent active cell, and density in `A/m^2`. Every face
selected by the authored surface scope must border an active charge conductor;
one inactive adjacent cell rejects the complete source with its source ID, face
index, and adjacent-cell index. The planner never silently intersects or clips
the authored electrode scope to the active domain. It is an
opt-in executable development prototype behind managed contract gates. The
current worktree implements fixes for ABI extent checks, per-face interface
identity, order-independent owner observations, fail-closed artifact mapping,
full-result validation, exact persistent E2E provenance, per-quantity oracle
tolerances, build invalidation, and warning-clean ABI compilation. A fresh
independent review of this exact worktree reached `final5 independent review APPROVE, no Critical/Important`.
The approved review scope does not make the
lane stable, public-qualified, validated, or production-qualified: its
canonical capability remains `semantic_only`, with
`implementation_state=executable` and `validation_state=unvalidated`. The separate
implementation-local total-current electrode in `A`, with one unknown
equipotential per coordinate boundary, remains a distinct API and must not be
used as an implicit density conversion. The FDM GPU ABI and binding remain
deferred to the contract frozen below.
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

The one-way M1 reduction keeps the charge law independent of spin while
retaining complete longitudinal spin injection and backflow:

```text
j_c,n^(M1) = (G_up+G_down) Delta V_Gamma,
q_s,parallel^(M1) = [(G_up-G_down) Delta V_Gamma
        +0.5(G_up+G_down) m dot Delta mu_s]m.
```

Here `Delta V_Gamma` is the difference of the two accepted charge-interface
traces, not an arbitrary difference of cell-centred values. M2 alone adds
`0.5(G_up-G_down) m dot Delta mu_s` to `j_c,n`; omitting that reciprocal term
in M1 does not permit omitting the spin-independent charge-interface law.
Every M1 mixing solve therefore consumes one accepted charge snapshot that
binds the oriented interface descriptor, both charge traces, and the single
conservative face `J_c`. Independently supplied arrays of `V` and `J_c` are
not an admissible M1 mixing input.

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

(symbols-and-si-units)=
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

The machine-readable symbol contract used by the source map is:

| id | latex | meaning | si_unit |
|---|---|---|---|
| V | V | charge electrochemical potential | \mathrm{V} |
| b_K | $b_K$ | assembled finite-volume charge right-hand side for cell $K$ | $\mathrm{A}$ |
| K | $K$ | deterministic finite-volume cell index | $1$ |
| C | $C$ | one numerically connected conducting-cell component | $1$ |
| V_bar_C | $\bar V_C$ | arithmetic mean charge potential on component $C$ | $\mathrm{V}$ |
| mu_s | \mu_s | full spin-channel splitting | \mathrm{V} |
| E | E_i | electric field, negative charge-potential gradient | \mathrm{V\,m^{-1}} |
| G | G_{ia} | spin-voltage gradient | \mathrm{V\,m^{-1}} |
| J_c | J_{c,i} | conventional charge-current density | \mathrm{A\,m^{-2}} |
| Q | Q_{ia} | charge-equivalent spin-current tensor; first index is flow and second is spin polarization | \mathrm{A\,m^{-2}} |
| sigma | \sigma | reciprocal reference charge conductivity | \mathrm{S\,m^{-1}} |
| sigma_s | \sigma_s | spin conductivity | \mathrm{S\,m^{-1}} |
| sigma_parallel | \sigma_{\parallel} | magnetoresistive conductivity parallel to magnetization | \mathrm{S\,m^{-1}} |
| sigma_perpendicular | \sigma_{\perp} | magnetoresistive conductivity transverse to magnetization | \mathrm{S\,m^{-1}} |
| sigma_AHE | \sigma_{\mathrm{AHE}} | anomalous-Hall antisymmetric conductivity coefficient | \mathrm{S\,m^{-1}} |
| P | P | charge-to-spin polarization | $1$ |
| theta_SH | \theta_{\mathrm{SH}} | spin-Hall angle with stored sign convention | $1$ |
| lambda_sf | \lambda_{\mathrm{sf}} | spin-flip diffusion length | \mathrm{m} |
| lambda_J | \lambda_J | transverse exchange length | \mathrm{m} |
| lambda_phi | \lambda_\phi | transverse dephasing length | \mathrm{m} |
| Sigma_mr | \Sigma_{\mathrm{mr}} | symmetric AMR/PHE charge-conductivity tensor | \mathrm{S\,m^{-1}} |
| R_sf | R_{\mathrm{sf}} | spin-flip reaction density | \mathrm{A\,m^{-3}} |
| R_J | R_J | transverse exchange reaction density | \mathrm{A\,m^{-3}} |
| R_phi | R_\phi | transverse dephasing reaction density | \mathrm{A\,m^{-3}} |
| G_up | G_{\uparrow} | majority-spin interface conductance per area | \mathrm{S\,m^{-2}} |
| G_down | G_{\downarrow} | minority-spin interface conductance per area | \mathrm{S\,m^{-2}} |
| G_r | G_r | real spin-mixing conductance per area | \mathrm{S\,m^{-2}} |
| G_i | G_i | imaginary spin-mixing conductance per area | \mathrm{S\,m^{-2}} |
| delta_V_Gamma | \Delta V_{\Gamma} | accepted oriented interface potential-trace jump | \mathrm{V} |
| r_K | r_{K,a} | component-wise local finite-volume spin-balance residual | \mathrm{A\,m^{-3}} |
| S_K | S_K | local finite-volume spin-flux and reaction scale | \mathrm{A\,m^{-3}} |
| S_Gamma | S_{\Gamma,K} | one-sided mixing-interface correction scale | \mathrm{A\,m^{-3}} |
| tau_abs | \tau_{\mathrm{abs}} | absolute local spin-balance tolerance | \mathrm{A\,m^{-3}} |
| tau_rel | \tau_{\mathrm{rel}} | relative local spin-balance tolerance | $1$ |
| gamma_e | \gamma_e | positive electron gyromagnetic ratio magnitude | \mathrm{s^{-1}\,T^{-1}} |
| M_s | M_s | saturation magnetization | \mathrm{A\,m^{-1}} |
| hbar | \hbar | reduced Planck constant | \mathrm{J\,s} |
| e | e | positive elementary charge | \mathrm{C} |
| q_abs | q_{\mathrm{abs},\perp} | transversely absorbed interface spin-current density | \mathrm{A\,m^{-2}} |
| T_tr_G | T_{\mathrm{tr},G} | transport-derived Gilbert-source torque | \mathrm{s^{-1}} |
| m | $m$ | reduced magnetization direction | $1$ |
| alpha | $\alpha$ | Gilbert damping | $1$ |
| B_eff | $B_{\mathrm{eff}}$ | effective magnetic induction | $\mathrm{T}$ |
| T_P | $T_P$ | polarization-driven contribution to transport torque | $\mathrm{s^{-1}}$ |
| T_SHE | $T_{\mathrm{SHE}}$ | direct-SHE contribution to transport torque | $\mathrm{s^{-1}}$ |
| seed_xy | $x,y$ | world-space coordinates in the racetrack plane | $\mathrm{m}$ |
| seed_center | $x_c,y_c$ | frozen world-space skyrmion centre | $\mathrm{m}$ |
| seed_rho | $\rho$ | radial distance from the frozen centre | $\mathrm{m}$ |
| seed_phi | $\phi$ | polar angle about the frozen centre | $\mathrm{rad}$ |
| seed_theta | $\theta$ | skyrmion polar profile angle | $\mathrm{rad}$ |
| seed_phase | $\chi$ | in-plane phase; equals $\phi$ for the frozen outward Néel wall | $\mathrm{rad}$ |
| seed_radius | $R$ | frozen seed radius | $\mathrm{m}$ |
| seed_wall_width | $\Delta$ | frozen seed wall width | $\mathrm{m}$ |
| seed_polarity | $p$ | serialized polarity multiplier in the repository profile | $1$ |
| seed_m_raw | $\mathbf m_{\mathrm{raw}}$ | pre-normalization seed vector | $1$ |

```{math}
:label: m1-constitutive-block
J_{c,i}=\sigma E_i,\qquad
Q_{ia}=\sigma_sG_{ia}+P\sigma E_i m_a
       +\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k.
```

```{math}
:label: m2-reciprocal-constitutive-block
\begin{aligned}
J_{c,i}&=J_{\mathrm{mr},i}+P\sigma m_aG_{ia}
       +\theta_{\mathrm{SH}}\sigma\epsilon_{ija}G_{ja},\\
Q_{ia}&=\sigma_sG_{ia}+P\sigma E_i m_a
       +\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k,
\end{aligned}
```

```{math}
:label: m2-schur-positivity
\lambda_{\min}(\Sigma_{\mathrm{mr}})\sigma_s-P^2\sigma^2>0,
\qquad
\lambda_{\min}(\Sigma_{\mathrm{mr}})=
\min(\sigma_{\parallel},\sigma_{\perp}).
```

```{math}
:label: spin-balance-reaction
\partial_iQ_{ia}=-R_{\mathrm{sf},a}-R_{J,a}-R_{\phi,a},
\quad
R_{\mathrm{sf}}=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\mu_s,
\quad
R_J=\frac{\sigma_s}{2\lambda_J^2}(\mu_s\times m),
\quad
R_\phi=\frac{\sigma_s}{2\lambda_\phi^2}m\times(\mu_s\times m).
```

```{math}
:label: m1-mixing-interface-reduction
\begin{aligned}
j_{c,n}^{(\mathrm{M1})}
  &=\begin{cases}
    (G_{\uparrow}+G_{\downarrow})\Delta V_{\Gamma},
      &G_{\uparrow}+G_{\downarrow}>0,\\
    0,&G_{\uparrow}=G_{\downarrow}=0,
  \end{cases}\\
q_{s,\parallel}^{(\mathrm{M1})}
  &=\left[(G_{\uparrow}-G_{\downarrow})\Delta V_{\Gamma}
    +\frac{G_{\uparrow}+G_{\downarrow}}{2}
      m\cdot\Delta\mu_s\right]m,\\
q_{\mathrm{abs},\perp}
  &=G_r m\times(\Delta\mu_s\times m)
    +G_i(\Delta\mu_s\times m).
\end{aligned}
```

The zero-longitudinal-conductance branch is a charge-insulating interface: it
does not connect charge components, its accepted traces are the two adjacent
cell potentials, and its charge observation is exactly zero. Non-negative
finite `G_up` and `G_down` with zero sum are legal; a negative or non-finite
entry and a non-finite sum fail closed. Nonzero finite `G_r` and `G_i` remain
legal in this branch and contribute only to transverse spin absorption.

```{math}
:label: fdm-exact-face-current-electric-reconstruction
E_{K,x}=\frac{J_{c,x-}+J_{c,x+}}{2\sigma_K},\qquad
E_{K,y}=\frac{J_{c,y-}+J_{c,y+}}{2\sigma_K},\qquad
E_{K,z}=\frac{J_{c,z-}+J_{c,z+}}{2\sigma_K}.
```

```{math}
:label: fdm-local-fv-balance-and-torque
\begin{aligned}
r_{K,a}&=\left[
\frac{1}{|K|}\sum_{f\subset\partial K}|f|Q_f\cdot n_{Kf}
+R_{\mathrm{sf},K}+R_{J,K}+R_{\phi,K}
\right]_a,\\
S_K&=\frac{1}{|K|}\sum_{f\subset\partial K}|f|\lVert Q_f\rVert_2
+\lVert R_{\mathrm{sf},K}\rVert_2+\lVert R_{J,K}\rVert_2
+\lVert R_{\phi,K}\rVert_2+S_{\Gamma,K},\\
\max_a|r_{K,a}|&\le \tau_{\mathrm{abs}}+\tau_{\mathrm{rel}}S_K,
\end{aligned}
\qquad
T_{\mathrm{tr},G,K}=-\frac{\gamma_e}{M_{s,K}}\frac{\hbar}{2e}
\left(R_{J,K}+R_{\phi,K}
+\frac{1}{|K|}\sum_{f\in\Gamma_K}|f|q_{\mathrm{abs},\perp,f}\right).
```

(assumptions-and-validity)=
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

(racetrack-m1-v1-contract)=
### 2.9 Frozen solved-current racetrack fixture `racetrack_m1_v1`

`racetrack_m1_v1` jest syntetycznym fixture walidacyjnym. Nie reprezentuje
jednego rzeczywistego materiału ani dopasowanego stosu HM/FM. Wartości
magnetyczne korzystają ze skali klasycznego workloadu ultracienkiego skyrmionu
Sampaio et al.; model dyfuzyjny i interfejsowy opierają się odpowiednio na
Valet--Fert, Abert et al. i Brataas--Nazarov--Bauer. Geometria, kontrast
przewodności, mixing conductance i symetryczny sweep są jawnymi wyborami
benchmarkowymi służącymi pokryciu gałęzi oraz testom znaków. Normatywną wersją
maszynową jest
`tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json`.

#### 2.9.1 Osie, current i komplet równań M1

Układ jest prawoskrętny: $+x$ biegnie wzdłuż toru, $+y$ jest osią poprzeczną,
a $+z$ biegnie od HM do FM. Dodatni $J_x$ oznacza conventional current, $e>0$,
a moment elektronu nie zmienia tej definicji prądu. Normalna interfejsu HM→FM
wynosi $n=+e_z$. Z równania charge continuity otrzymujemy:

```{math}
:label: racetrack-charge-continuity
\nabla\!\cdot\mathbf J_c=0,
\qquad
\mathbf J_c=\sigma\mathbf E=-\sigma\nabla V.
```

Direct SHE jest częścią jednego tensora $Q_{ia}$, a nie nieopisanym wektorem:

```{math}
:label: racetrack-direct-she
Q^{\mathrm{SHE}}_{ia}
=\theta_{\mathrm{SH}}\epsilon_{ika}J_{c,k},
\qquad
J_{c,x}>0,\ \theta_{\mathrm{SH}}>0
\Longrightarrow Q^{\mathrm{SHE}}_{zy}>0.
```

Steady M1 rozwiązuje trzy składowe akumulacji spinowej z kompletem reakcji:

```{math}
:label: racetrack-steady-spin-balance
\begin{aligned}
\partial_iQ_{ia}&=-R_{\mathrm{sf},a}-R_{J,a}-R_{\phi,a},\\
R_{\mathrm{sf}}&=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\mu_s,\\
R_J&=\frac{\sigma_s}{2\lambda_J^2}(\mu_s\times m),\\
R_\phi&=\frac{\sigma_s}{2\lambda_\phi^2}m\times(\mu_s\times m).
\end{aligned}
```

Dla skoku $\Delta\mu_s=\mu_{s,HM}-\mu_{s,FM}$ i zaakceptowanego skoku
$\Delta V_\Gamma=V_{HM}-V_{FM}$ warunek mixing ma postać:

```{math}
:label: racetrack-mixing-boundary
\begin{aligned}
j_{c,n}&=(G_\uparrow+G_\downarrow)\Delta V_\Gamma,\\
q_{s,\parallel}&=\left[(G_\uparrow-G_\downarrow)\Delta V_\Gamma
+\frac{G_\uparrow+G_\downarrow}{2}m\cdot\Delta\mu_s\right]m,\\
q_{\mathrm{abs},\perp}&=G_r m\times(\Delta\mu_s\times m)
+G_i(\Delta\mu_s\times m).
\end{aligned}
```

Moment pędu przekazany do jednej komórki FM $K$ jest sumą reakcji
objętościowych i zorientowanej absorpcji powierzchniowej. Spin-flip nie należy
do torque magnetycznego:

```{math}
:label: racetrack-torque-balance
T_{\mathrm{tr},G,K}=-\frac{\gamma_e}{M_{s,K}}\frac{\hbar}{2e}
\left[R_{J,K}+R_{\phi,K}
+\frac{1}{|K|}\sum_{f\in\Gamma_K}|f|q_{\mathrm{abs},\perp,f}\right].
```

`T_tr,G` jest źródłem w kanonicznej postaci Gilberta. Dla
$B_{\mathrm{eff}}=\mu_0H_{\mathrm{eff}}$ pełny jawny RHS wynosi:

```{math}
:label: racetrack-gilbert-llg
(1+\alpha^2)\partial_t m=
-\gamma_e\left[m\times B_{\mathrm{eff}}
+\alpha m\times(m\times B_{\mathrm{eff}})\right]
+T_{\mathrm{tr},G}+\alpha m\times T_{\mathrm{tr},G}.
```

#### 2.9.2 Pełna tabela znaków

Tabela opisuje model liniowy M1 przed nieliniową odpowiedzią trajektorii.
`odd` oznacza dokładne odwrócenie znaku przy ustalonym deskryptorze i stanie
$m$. Kąt Halla jest surowo zdefiniowany przez `atan2(v_y,v_x)`; po odwróceniu
obu składowych prędkości zmienia gałąź o $\pi$, a nie po prostu znak.

Produkcyjny fixture ma $P=0.4$, dlatego odwrócenie samego
$\theta_{\mathrm{SH}}$ nie odwraca całej $\mu_s$, całego $Q$ ani całego
torque. Dla ustalonego $m$, zaakceptowanego snapshotu charge i wszystkich
pozostałych parametrów odpowiedź rozdziela się na część polaryzacyjną oraz
SHE. Dla torque zapis jest następujący:

```{math}
:label: racetrack-theta-sh-torque-decomposition
T(+\theta_{\mathrm{SH}})=T_P+T_{\mathrm{SHE}},
\qquad
T(-\theta_{\mathrm{SH}})=T_P-T_{\mathrm{SHE}}.
```

Tak samo rozkładają się $\mu_s$ i $Q$. Ich całkowita odpowiedź przy $P=0.4$
nie jest ogólnie odd. Dokładny oracle odwrócenia czystego SHE używa kopii
fixture z jedyną zmianą $P=0$; zachowuje $G_\uparrow=G_\downarrow$, ten sam
$m$ i ten sam charge snapshot. Wtedy $\mu_s$, $Q$ i $T_{\mathrm{tr},G}$ muszą
być dokładnie odd względem $\theta_{\mathrm{SH}}$ w tolerancji numerycznej
orakla. Dla pełnej nieliniowej dynamiki obowiązuje jawne ograniczenie:
`no exact oddness claim for nonlinear trajectory velocity`.

| Operacja | $J_c$ | $Q^{SHE}$, $\mu_s$, oriented flux | $T_{tr,G}$ | $(v_x,v_y)$ w granicy liniowej | $\Theta_H$ | Warunek legalności |
|---|---:|---:|---:|---:|---:|---|
| `identity` | bez zmiany | bez zmiany | bez zmiany | bez zmiany | bez zmiany | osie jak wyżej |
| `reverse_J` | odd | odd | odd | $(-v_x,-v_y)$ | `wrap(Theta_H +/- pi)` | odwrócić oba zbilansowane terminale; moduł nadal istnieje |
| `reverse_theta_SH` | bez zmiany | część polaryzacyjna bez zmiany, część SHE odd | $T_P+T_{\mathrm{SHE}}\to T_P-T_{\mathrm{SHE}}$ | brak dokładnego prawa dla pełnej trajektorii; w oracle $P=0$ odd jest transport przy ustalonym $m$ | brak ogólnego prawa | nie zmieniać charge snapshotu; dokładny oracle czystego SHE ustawia wyłącznie $P=0$ |
| `reverse_normal` | bez zmiany | oriented flux zmienia znak | fizyczny torque bez zmiany | bez zmiany | bez zmiany | tylko spójna zamiana HM↔FM, $n\to-n$ i $\Delta\to-\Delta$; sam flip normalnej fail-closed |
| `reverse_transverse_axis` | bez zmiany | składowe z indeksem $y$ zmieniają znak prezentacji | fizyczny torque bez zmiany | $(v_x,-v_y)$ | $-\Theta_H$ w gałęzi głównej | jest to zmiana osi raportowania, nie lewoskrętny frame solvera |

#### 2.9.3 Znormalizowany deskryptor geometrii, BC, masek i etapów

Normatywny JSON zamraża jedną reprezentację bez domyślnych pól. Siatka ma
dokładnie `counts=[256,64,4]`, `cell_size_m=[2e-9,2e-9,1e-9]`, początek
`[0,0,0]` i porządek `x_fastest_then_y_then_z`. HM zajmuje półotwarty zakres
komórek $[0,256)\times[0,64)\times[0,3)$, czyli
$0\le z<3\,\mathrm{nm}$. FM zajmuje
$[0,256)\times[0,64)\times[3,4)$, czyli
$3\,\mathrm{nm}\le z<4\,\mathrm{nm}$. Wspólna płaszczyzna interfejsu ma
$z=3\,\mathrm{nm}$.

Charge BC ma gauge `zero_mean` i pokrywa każdą zewnętrzną powierzchnię
dokładnie raz. Terminal `terminal_x_minus` zawiera `hm:x-` i `fm:x-`, obie z
orientacją $(-1,0,0)$, a jego outward density wynosi $-J_x$. Terminal
`terminal_x_plus` zawiera `hm:x+` i `fm:x+`, obie z orientacją $(1,0,0)$, a
jego outward density wynosi $+J_x$. `insulating_outer` obejmuje dokładnie
`hm:y-`, `hm:y+`, `hm:z-`, `fm:y-`, `fm:y+` i `fm:z+` z odpowiadającymi
zewnętrznymi orientacjami. Spin BC `spin_insulating_outer` obejmuje wszystkie
dziesięć zewnętrznych powierzchni HM i FM, łącznie z czterema powierzchniami
terminali charge.

Interfejs `hm_fm` ma `kind=mixing_conductance`, `normal_side=hm`,
`ferromagnet_side=fm`, `normal_to_ferromagnet=[0,0,1]`, stronę HM `hm:z+` o
orientacji $+z$ i stronę FM `fm:z-` o orientacji $-z$. Sam wektor normalny bez
tej pary stron i powierzchni nie jest kompletnym deskryptorem.

Trzy maski używają tego samego kształtu i porządku komórek:

| Maska | Aktywny zakres $z$ | Liczba aktywnych komórek | Własność |
|---|---:|---:|---|
| `transport_active` | $[0,4)$ | `65536` | HM i FM |
| `magnetic_active` | $[3,4)$ | `16384` | tylko FM |
| `torque_target` | $[3,4)$ | `16384` | tylko FM |

Obowiązuje `torque_target subset magnetic_active subset transport_active`.
Deskryptor `cell_bounds` wraz z `shape` i `cell_order` wyznacza każdy bit maski;
runtime nie może rekonstruować maski z $M_s$, z amplitudy prądu ani z samej
obecności materiału.

Kanoniczny stan początkowy nie jest jednorodnym $m$. Publiczny konstruktor
`fm.texture.neel_skyrmion` zapisuje `preset_texture` w
`magnets[0].initial_magnetization`, z mapowaniem `world`, płaszczyzną `xy`,
centrum `[256e-9,64e-9,3.5e-9]`, `R=30e-9`, `Delta=5e-9`,
`chirality=+1`, Néel `helicity=0` i serializowanym
`core_polarity=+1`. Dla $\rho$ liczonego od tego centrum repozytoryjny profil
jest dokładnie

```{math}
:label: racetrack-neel-seed
\rho=\sqrt{(x-x_c)^2+(y-y_c)^2},\qquad
\phi=\operatorname{atan2}(y-y_c,x-x_c),\qquad
\theta(\rho)=2\operatorname{atan}\!\left[\exp\!\left(\frac{R-\rho}{\Delta}\right)\right],
\qquad
\chi=\phi,
\qquad
\mathbf m_{\mathrm{raw}}=
(\sin\theta\cos\chi,\sin\theta\sin\chi,p\cos\theta),\quad p=+1,
\qquad
\mathbf m=\frac{\mathbf m_{\mathrm{raw}}}{\lVert\mathbf m_{\mathrm{raw}}\rVert_2}.
```

Zatem ściana przy $\rho=R$ jest radialnie skierowana na zewnątrz,
`core m_z<0`, a `background m_z->+1`. Normalizacja jest wykonywana osobno dla
każdej próbki; tylko hipotetyczna zerowa norma używa deterministycznego
fallbacku `[0,0,1]`. Seed jest wejściem do relaksacji, nie dowodem stabilności
ani kwalifikacji skyrmionu.

Etap `relax_zero_current` zachowuje moduł transportu, ustawia $J_x=0$, wyłącza
transportowy torque i publikuje checkpoint `relaxed_zero_current`. Etap
`drive_solved_current` wykonuje sześć niezależnych przebiegów w porządku
$(-1.5,-1.0,-0.5,+0.5,+1.0,+1.5)\times10^{12}\,\mathrm{A\,m^{-2}}$.
Każdy przebieg zaczyna się od tego samego checkpointu, trwa $2\,\mathrm{ns}$,
używa stałego kroku $0.1\,\mathrm{ps}$, zapisuje próbkę co $5\,\mathrm{ps}$ i
aktualizuje transport przy każdej ewaluacji RHS LLG. Dla każdego $J_x$ JSON
zapisuje obie konkretne outward densities, więc znak terminali nie jest
wyprowadzany później z nazwy powierzchni.

Spin solver fixture jest jawnie i dokładnie `native_m1_v1`. Wartości `auto`,
`gmres` i każdy fallback są zabronione. Pełny zamrożony zakres zabroniony to
CPU, FP32, prescribed torque, prescribed current density, Oersted, iSHE, M2,
M3, MTJ, PBC, thermal noise, multi-GPU oraz `adaptive_geometry`. Ostatni zakaz
oznacza, że geometria, siatka, maski i indeksowanie komórek pozostają identyczne
we wszystkich przebiegach.

`normalized_problem_ir_contract.expected_lowering` jest kompletną, typowaną
projekcją bieżącego `ProblemIR`, zbudowaną przez publiczne konstruktory
`Box`, `Translate`, `Material`, `Ferromagnet` i `Problem`. Zawiera rzeczywiste
tablice `geometry.entries` i `materials`, pełny `CurrentTransport`, steady
`SpinDriftDiffusion`, `DriftDiffusionSpinTorque`, energy terms `Exchange`,
`Demag` i `InterfacialDMI(D=3e-3, interface_normal=(0,0,1))`, jeden bazowy
`TimeEvolution`, `BackendPolicyIR` oraz `ValidationProfileIR`. Test Python
porównuje całą projekcję z publicznym loweringiem i dereferencjonuje każdą
ścieżkę parametru. Test Rust deserializuje cały `ProblemIR`, osobno parsuje
`ValidationProfileIR` i sprawdza selection w jego rzeczywistym położeniu
`problem_meta.runtime_metadata.runtime_selection`. Kolejność BC jest
normatywna: terminale mają indeksy `0` i `1`, a zewnętrzny
charge-insulating boundary indeks `2`.

Pełny workload nie jest jeszcze publicznie lowerowalny jako jeden `Problem`.
Obiekt HM i jego charge/spin material assignments są reprezentowalne, ale
brakuje mutacji wartości BC pomiędzy etapami oraz restartu każdego drive z
nazwanego checkpointu. Dlatego maski i sześcioprzebiegowy harmonogram pozostają jawnym kontraktem
workflow fixture, a nie fikcyjnymi polami `ProblemIR`. Każdy drive zapisuje
konkretne istniejące cele `current_modules[0].boundaries[0|1].outward_current_density_Apm2`;
nie istnieje cel `boundaries[current_sweep]`. Granica ta jest zamrożona w
`public_lowering_boundary` i nie może zostać uznana za implementację ani
kwalifikację `fdm/gpu/double/strict`.

#### 2.9.4 Pełna tabela liczb fixture

Każdy wiersz ma status `numerical_validation_fixture`; pole `ProblemIR` jest
ścieżką semantyczną zweryfikowaną względem obecnych konstruktorów Python,
struktur `ProblemIR` i ich nazw serializowanych. Motywacja `paper-scale` nie
oznacza przypisania zestawu jednemu materiałowi.

| id | symbol | si_unit | value | validity | problem_ir_path | motivation |
|---|---|---|---:|---|---|---|
| `track.length` | $L_x$ | $\mathrm m$ | `512e-9` | 256 cells; FM must equal HM | `geometry.entries[1].base.size[0]` | Sampaio scale + bounded grid |
| `track.width` | $L_y$ | $\mathrm m$ | `128e-9` | 64 cells; FM must equal HM | `geometry.entries[1].base.size[1]` | Sampaio scale + edge margin |
| `hm.thickness` | $t_{HM}$ | $\mathrm m$ | `3e-9` | 3 z cells | `geometry.entries[1].base.size[2]` | diffusive HM benchmark |
| `fm.thickness` | $t_{FM}$ | $\mathrm m$ | `1e-9` | 1 z cell | `geometry.entries[0].base.size[2]` | ultrathin DMI benchmark |
| `cell.x` | $h_x$ | $\mathrm m$ | `2e-9` | exact divisor of $L_x$ | `backend_policy.discretization_hints.fdm.cell[0]` | bounded in-plane resolution |
| `cell.y` | $h_y$ | $\mathrm m$ | `2e-9` | exact divisor of $L_y$ | `backend_policy.discretization_hints.fdm.cell[1]` | bounded in-plane resolution |
| `cell.z` | $h_z$ | $\mathrm m$ | `1e-9` | exact 3+1 layer ownership | `backend_policy.discretization_hints.fdm.cell[2]` | interface ownership |
| `fm.Ms` | $M_s$ | $\mathrm{A\,m^{-1}}$ | `580e3` | finite, $>0$ in FM | `materials[0].saturation_magnetisation` | Sampaio paper-scale |
| `fm.A` | $A$ | $\mathrm{J\,m^{-1}}$ | `15e-12` | finite, $>0$ | `materials[0].exchange_stiffness` | Sampaio paper-scale |
| `fm.alpha` | $\alpha$ | $1$ | `0.3` | finite, $\ge0$ | `materials[0].damping` | deterministic relaxation scale |
| `fm.Ku` | $K_u$ | $\mathrm{J\,m^{-3}}$ | `0.8e6` | finite, axis $+z$ | `materials[0].uniaxial_anisotropy` | Sampaio paper-scale |
| `fm.D` | $D$ | $\mathrm{J\,m^{-2}}$ | `3e-3` | finite, Fullmag DMI sign, interface normal $+z$ | `energy_terms[2].D` | Sampaio paper-scale |
| `hm.sigma_charge` | $\sigma_{HM}$ | $\mathrm{S\,m^{-1}}$ | `5e6` | finite, $>0$ | `current_modules[0].materials[0].material.sigma_Spm` | metallic benchmark |
| `hm.sigma_spin` | $\sigma_{s,HM}$ | $\mathrm{S\,m^{-1}}$ | `5e6` | finite, $>0$ | `spin_transport_modules[0].materials[0].material.sigma_s_Spm` | unpolarized HM benchmark |
| `hm.theta_SH` | $\theta_{SH,HM}$ | $1$ | `0.2` | finite, signed | `spin_transport_modules[0].materials[0].material.theta_sh` | sign-sensitive SHE benchmark |
| `hm.lambda_sf` | $\lambda_{sf,HM}$ | $\mathrm m$ | `1.5e-9` | finite, $>0$ | `spin_transport_modules[0].materials[0].material.lambda_sf_m` | short metallic scale |
| `fm.sigma_charge` | $\sigma_{FM}$ | $\mathrm{S\,m^{-1}}$ | `1e6` | finite, $>0$ | `current_modules[0].materials[1].material.sigma_Spm` | HM/FM contrast benchmark |
| `fm.sigma_spin` | $\sigma_{s,FM}$ | $\mathrm{S\,m^{-1}}$ | `1e6` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.sigma_s_Spm` | FM transport benchmark |
| `fm.P` | $P_{FM}$ | $1$ | `0.4` | finite in $[-1,1]$ | `spin_transport_modules[0].materials[1].material.polarization_p` | moderate polarization |
| `fm.lambda_sf` | $\lambda_{sf,FM}$ | $\mathrm m$ | `5e-9` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.lambda_sf_m` | longitudinal reaction coverage |
| `fm.lambda_J` | $\lambda_{J,FM}$ | $\mathrm m$ | `1e-9` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.lambda_j_m` | transverse exchange coverage |
| `fm.lambda_phi` | $\lambda_{\phi,FM}$ | $\mathrm m$ | `1e-9` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.lambda_phi_m` | dephasing coverage |
| `interface.G_up` | $G_\uparrow$ | $\mathrm{S\,m^{-2}}$ | `2.5e14` | finite, $\ge0$ | `spin_transport_modules[0].interfaces[0].g_up_Spm2` | symmetric longitudinal branch |
| `interface.G_down` | $G_\downarrow$ | $\mathrm{S\,m^{-2}}$ | `2.5e14` | finite, $\ge0$ | `spin_transport_modules[0].interfaces[0].g_down_Spm2` | symmetric longitudinal branch |
| `interface.G_r` | $G_r$ | $\mathrm{S\,m^{-2}}$ | `5e14` | finite, $\ge0$ | `spin_transport_modules[0].interfaces[0].g_r_Spm2` | damping-like branch coverage |
| `interface.G_i` | $G_i$ | $\mathrm{S\,m^{-2}}$ | `5e13` | finite, signed | `spin_transport_modules[0].interfaces[0].g_i_Spm2` | field-like branch coverage |
| `drive.J_minus_1_5` | $J_x^{(-1.5)}$ | $\mathrm{A\,m^{-2}}$ | `-1.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep; paired x-minus override is explicit in `current_schedule` |
| `drive.J_minus_1_0` | $J_x^{(-1.0)}$ | $\mathrm{A\,m^{-2}}$ | `-1.0e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_minus_0_5` | $J_x^{(-0.5)}$ | $\mathrm{A\,m^{-2}}$ | `-0.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_plus_0_5` | $J_x^{(+0.5)}$ | $\mathrm{A\,m^{-2}}$ | `0.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_plus_1_0` | $J_x^{(+1.0)}$ | $\mathrm{A\,m^{-2}}$ | `1.0e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_plus_1_5` | $J_x^{(+1.5)}$ | $\mathrm{A\,m^{-2}}$ | `1.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |

#### 2.9.5 Kryteria kwalifikacji fixture

Task 1 zamraża wyłącznie kontrakt. `she_1d_film_v1` musi później przejść
analityczny profil, residual, zbieżność i odwrócenia znaków. Racetrack wymaga
trzech siatek relaksacji, stabilnego podpisanego $Q$, dodatnich i ujemnych
prądów, co najmniej trzech amplitud, bilansu charge/spin/torque, atomowego
rollback/restart, CPU↔CUDA FP64 parity, zarządzanej tożsamości GPU oraz
algorytmu `skyrmion_hall_angle_v1` z niepewnością i reason codes. Do czasu
świeżego manifestu Task 12 exact tuple pozostaje niezakwalifikowany; obecność
źródła, fixture, testu dokumentacji lub natywnego kernela nie promuje statusu.

(discrete-realization)=
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

For an oriented finite-conductance charge interface `N -> F`, the FDM M1
operator `fv_charge_mixing_series_trace.v1` eliminates the two interface
traces through the series resistance

```text
R_f = d_N/(2 sigma_N) + 1/(G_up+G_down) + d_F/(2 sigma_F),
j_c,n = (V_N-V_F)/R_f,
V_N,Gamma = V_N-j_c,n d_N/(2 sigma_N),
V_F,Gamma = V_F+j_c,n d_F/(2 sigma_F).
```

When `G_up=G_down=0`, the series-resistance expression is not evaluated:
`j_c,n=0`, `V_N,Gamma=V_N`, and `V_F,Gamma=V_F`. This charge-insulating face
does not connect the two charge components. It still publishes the oriented
descriptor, two accepted traces, and the zero charge-flux observation required
by the spin owner; nonzero `G_r/G_i` may therefore realize transverse-only
mixing.

The stored globally oriented face current is `j_c,n` or `-j_c,n` according to
whether `N -> F` agrees with the positive coordinate direction. The two cell
balances consume that one value with opposite signs. Gauge, BC, component
balance, and local charge residual checks use the same operator. A successful
charge solve alone constructs the immutable accepted snapshot containing the
grid, immutable charge-active mask, material identity, face-current arrays,
interface descriptors, traces,
and observations; the spin owner validates and consumes that snapshot rather
than accepting forgeable parallel arrays.

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

The bounded native FDM CPU M1 owner instead uses the separately named
`fdm_exact_face_current_electric_reconstruction.v1`. It reconstructs the
electric field exclusively from the accepted conservative face current:

```text
E_K,k^J = (J_c,k,- + J_c,k,+)/(2 sigma_K),
E_f,i^J = J_c,f/sigma_f,
E_f,k!=i^J = 0.5(E_K,k^J+E_L,k^J).
```

At an external face the sole adjacent cell supplies tangential components.
The normal component is the exact oriented `J_c,f/sigma`; direct SHE is then
`theta_SH,f sigma_f n_i epsilon_ika E_f,k^J`. This operator does not read
cell-centred `V` when no mixing interface is present. It is therefore invariant
under changes to otherwise unused `V`, including heterogeneous `sigma`, and
MUST NOT publish `structured_cross_gradient_v1` provenance.

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

The bounded owner implemented by
`fdm_spin_block_gmres_matrix_free_reference_v1` is an unpreconditioned,
restarted, matrix-free FP64 reference engine. It is not the production
`fdm_spin_block_gmres_csr_v1` engine and makes no AMG/ILU or scaling claim.
`fdm_transport_torque_cell_surface_balance.v1` maps independently recomputed
volumetric `R_J+R_phi` and surface transverse absorption to the authored
magnetic target using `-gamma_e hbar/(2eM_s)`.

The accepted local FV residual gate is component-wise and dimensionally
explicit. For cell `K`, let `r_K,a [A/m^3]` be the independently recomputed
flux divergence plus reaction and let

```text
s_K = sum_f A_f ||Q_f||_2/|K|
    + ||R_sf,K||_2 + ||R_J,K||_2 + ||R_phi,K||_2 + S_Gamma,K  [A/m^3],
t_K = local_abs_tol_Apm3 + local_rel_tol s_K.       [A/m^3]
```

Here `S_Gamma,K` is zero except on the positive cell of an oriented mixing
interface, where it is the norm of the difference between its two one-sided
spin fluxes divided by the face-normal cell spacing. This is the same explicit
interface correction used in the recomputed local residual.

Every cell must satisfy `max_a |r_K,a|<=t_K`; global closure and integrated L2
remain additional gates and cannot hide equal-and-opposite local defects.

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

(fdm-gpu-m1-fp64-contract)=
### 3.1.1 FDM GPU/FP64 M1 realization contract (PR-15; partial native implementation)

This section freezes the first native CUDA milestone for one-way M1 charge,
steady spin/direct-SHE, interface mixing, and transport torque. It is a
realization contract for the common equations above, not a second physical
model. CPU and GPU use the same signs, SI units, formula and operator IDs,
face orientation, interface observations, and balance identities. They do not
share mutable solver state or implementation workspaces.

Ogólny agregat pozostaje `semantic_only`, ponieważ poza bounded
`CurrentTransport` charge-only nie ma jeszcze publicznej ścieżki dla tego ABI.
Agregat FDM GPU M1 ma `implementation_state=partial`: oprócz ograniczonego
charge-only FP64 slice istnieje natywny solver steady spin/direct-SHE,
mixing i torque oraz niekwalifikowane etapowe sprzężenie torque z FP64
Heun/RK4. Wyłączny claim wiąże jeden kontekst LLG z jednym accepted charge
snapshotem. Rozwiązania spinowe etapów są stanem trial; dopiero przyjęcie
całego kroku LLG promuje trial policzony dla końcowego zaakceptowanego `m` do
`spin_accepted`; wybór poziomu statystyk nie uruchamia dodatkowego solve i nie
zmienia stanu naukowego. Awaria późnego etapu przywraca bitowo `m`, czas i
liczniki accepted oraz usuwa trial i mutowalny sparse cache. `t_stage` jest
sprawdzany pod kątem skończoności i niemalejącej kolejności, lecz ten ograniczony
slice używa jednego niemutowalnego accepted charge snapshotu przez wszystkie
kroki danego wiązania.
Realizuje więc tylko stałe w czasie $J_c$; wymuszenie $J_c(t)$ z ogólnego
kontraktu sekcji 2.6 pozostaje niewykonywalne i nie może być deklarowane jako
obsługiwane. Stan
walidacji pozostaje `validation_state=unvalidated`, z
`validated_workloads=[]`. Managed lifecycle gate po zmianach
final-state/statistics/rollback i stream-local pin/drain przechodzi testy
Heun/RK4, błędy launch/event-record/event-sync, teardown rejection podczas
in-flight, C11/Rust ABI oraz dwa przebiegi `compute-sanitizer` bez błędów. Jest
to dowód testów kontraktowych, a nie promocja capability ani kwalifikacja
produkcyjna; globalna serializacja registry i pełna ścieżka publicznego
ProblemIR/plannera/runnera pozostają otwarte.

#### Stan ograniczonej implementacji M1 charge z 2026-08-11

Właściciel `backends/fdm/gpu/cuda/transport/charge/**` realizuje rzeczywisty
FP64 charge solve na urządzeniu: konserwatywny operator FV z harmoniczną
przewodnością ścian, device CG, fixed-tree redukcje oraz dwupoziomowy device AMG.
Agregaty AMG są geometrycznymi blokami `2 x 2 x 2` kanonicznej ortogonalnej
siatki FDM, z deterministycznym przypisaniem i jawnym coarse operatorem
$A_c=P^TAP$. Ten wybór wykorzystuje regularną topologię tej realizacji,
zapewnia co najwyżej osiem fine cells na agregat i stabilną tożsamość cache;
nie jest adaptacyjnym strength-graph AMG. Puste agregaty wynikające z legalnej
maski nieaktywnej mają zerową korektę coarse i nie wykonują dzielenia przez
zero. Skuteczność tej dwupoziomowej preconditioner realization musi być
kwalifikowana osobno dla skoków materiałowych, finite-$G$, nieparzystych
wymiarów, masek nieaktywnych i rozłącznych komponentów; sama liczba coarse DOF
nie dowodzi poprawności $P^TAP$ ani skalowalności solve.
Typed cell/material/face/formula payloads są walidowane fail-closed przed
publikacją. Voltage, exact-density i insulating external faces mają jeden
globalnie zorientowany prąd ścianowy, a odrzucony descriptor lub solve nie
publikuje accepted state. Snapshot posiada własne bufory device dla $V$ i
$J_x/J_y/J_z$; artefakty oraz checkpoint wymagają jawnej cadence.

```{math}
:label: fdm-gpu-m1-charge-fv
\begin{aligned}
g_{KL}&=\frac{|f|}{d_K/\sigma_K+d_L/\sigma_L},
&g_{Kf}^{V}&=\frac{2\sigma_K|f|}{h_f},\\
(A V)_K&=\sum_{L\sim K}g_{KL}(V_K-V_L)
 +\sum_{f\subset\Gamma_V\cap\partial K}g_{Kf}^{V}V_K,
&b_K&=\sum_{f\subset\Gamma_V\cap\partial K}g_{Kf}^{V}V_f
 -\sum_{f\subset\Gamma_J\cap\partial K}|f|J_{n,f}.
\end{aligned}
```

Tutaj $J_{n,f}$ jest prądem zadanym dodatnio na zewnątrz komórki. Ściana
insulating nie wnosi składnika do $A$ ani $b$, a komórki nieaktywne nie tworzą
połączeń przewodzących. To równanie opisuje wyłącznie ograniczony slice charge;
nie obejmuje strumienia spinowego $Q$, SHE, mixing ani torque.

#### Zero-mean gauge dla swobodnych komponentów Neumanna

Dla komponentu przewodzącego bez żadnej ściany voltage operator jest
semidefinitny i jego jądrem jest stała na tym komponencie. Solver nie może
wybrać stałej przez przypadkowy pivot ani przez niejawny fallback CPU. Wymagana
jest najpierw zgodność Neumanna

```{math}
:label: fdm-gpu-m1-neumann-compatibility
\sum_{K\in C} b_K = 0,
\qquad
\bar V_C = \frac{1}{|C|}\sum_{K\in C} V_K = 0
\quad\text{dla każdego komponentu bez voltage datum}.
```

W implementacji `label_reference_components_kernel` buduje graf wyłącznie z
dodatnich przewodności ścian wewnętrznych, oznacza komponenty zakotwiczone
przez voltage BC i sprawdza `|sum b| <= 64 eps ||b||_1` dla każdego wolnego
komponentu. Niespełnienie zgodności kończy solve statusem
`FULLMAG_FDM_GPU_TRANSPORT_ERROR_BALANCE_FAILURE`. Dla polityki
`ZERO_MEAN_PER_FREE_COMPONENT` device PCG stosuje ortogonalną projekcję na
podprzestrzeń zerowej średniej po inicjalizacji $V$, prawej stronie, residuale,
preconditionerze, kierunku $p$ i iloczynie $Ap$. Dzięki temu rozwiązywany jest
układ $PAP\,V=Pb$ bez sztucznego usuwania jednego węzła; komponenty z voltage
datum zachowują ich wartość referencyjną. `BOUNDARY_REFERENCE_PER_COMPONENT`
pozostaje osobną polityką i odrzuca wolny komponent.

To jest obecnie bounded, device-side realization: identyfikacja grafu i
projekcja są deterministyczne, lecz celowo serializowane w jednym bloku CUDA.
Nie jest to jeszcze dowód skalowalności dla dużych rozłącznych domen ani
kwalifikacja publicznego runnera. Test uniform zawiera trzy nowe kontrakty:
niezerowy, zbilansowany pure-Neumann solve z odczytem średniej $V$,
niezbilansowany strumień, który musi zakończyć się `BALANCE_FAILURE`, oraz
typed mixed anchored/free fixture z wewnętrznym charge-insulating interfejsem,
który sprawdza niezależną średnią komponentu swobodnego i zachowanie datum
komponentu zakotwiczonego.

Zarządzana bramka
`just verify-fdm-gpu-m1-charge-native-contract` zakończyła się kodem 0 na GPU
o UUID `fcb9fbf1828437c7af5b76bcbf2d2937`, dla build digest
`700e798c56bdde3029759e3460a39762e325d5108401e5907819a7b064a9ca3d`.
`charge_uniform_v1` użył 45 iteracji, osiągnął residual algebraiczny
$4.696365845897086\times10^{-15}$, residual fizyczny i bilans komponentu
$2.911545681350832\times10^{-16}$ oraz bilans elektrod
$1.7294921875001357\times10^{-13}$. Hierarchia miała poziomy $512\to64$,
jeden build, jedno trafienie cache i 90 zastosowań AMG. `charge_layered_v1`
osiągnął residual algebraiczny $5.931538386041357\times10^{-15}$, residual
fizyczny $2.2775813048401056\times10^{-16}$ i względny skok strumienia na
interfejsie $2.08984375\times10^{-14}$. Oba workloady oraz snapshot/mutation
gate raportują `host_fallback_count=0`.

Checkpoint ma dwa rozłączne tory dowodowe. **Tor A** jest syntetycznym,
zamrożonym oraclem kodeka: ma 4352 bajty, sequence 7, payload SHA-256
`ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5`
i embedded file hash
`bc3bcc1b51314fe46e0bbd2f71e94f1517f8e438943853e33b8e79b1495c7b60`.
Validator musi go zaakceptować, lecz jego syntetyczna tożsamość device/build/
static descriptor musi zostać odrzucona przez rzeczywisty exact-identity import
jako `checkpoint_incompatible`. **Tor B** eksportuje 4352-bajtowy sequence-7
checkpoint z aktualnego runtime; jego identity-dependent SHA-256 w powyższym
buildzie wyniosło
`d2b25960eb31376b1b2fe6aa8ba07944ba69a695125a381a398da46f891123f9`.
Świeży kontekst o tej samej tożsamości importuje go bez ponownego solve, a
odczytane $V$ i $J_c$ są bitowo równe stanowi przed eksportem. SHA toru B nie
jest stałym oraclem między buildami i nie może być utożsamiane z SHA toru A.

Powyższe liczby opisują wcześniejszy run bazowy; jego otwarte granice były
blokujące dla szerszego M1: implementacja swobodnego, zgodnego Neumannowskiego
komponentu z narzuconą zerową średnią nie miała wtedy managed device proof.
Zaimportowany iterate jest
odtwarzany jako accepted snapshot, ale następny solve nie konsumuje jeszcze
tego stanu jako persistent Krylov warm start. Nie ma publicznego runnera,
ProblemIR stage ani stabilnych artefaktów/proweniencji tego slice'u. Nie ma też
publicznego dispatchu spin, FP32, periodic, multi-device, konwergencji siatkowej
ani kwalifikacji wydajnościowej. W historycznym runie wiersze
`component_gauge_v1`, `determinism_restart_v1`, `public_path_v1`, spin/SHE/mixing/torque,
`convergence_v1` i `performance_v1` pozostają niezamknięte.

### Aktualizacja managed zero-mean (2026-08-11)

Ponowna bramka
`just verify-fdm-gpu-m1-charge-native-contract` zakończyła się kodem 0 po
przebudowie w tym samym managed container-backed runtime. Urządzenie to NVIDIA
GeForce RTX 4080 SUPER, UUID `fcb9fbf1828437c7af5b76bcbf2d2937`, CC 8.9,
CUDA runtime `12040`, driver `13010`, build digest
`d396670cc86f5b79b208d812b7a1aca52a73ead18ab48b6c00141dd3c558c96a`.

Wraz z dotychczasowymi uniform/layered/snapshot/mutation/strict-residency
workloadami uruchomiono trzy kontrakty gauge w tym samym executable:

- pure Neumann, zbilansowany: `zero_mean_pure_mean =
  -8.131516293641283e-19 V`, `zero_mean_pure_max_abs =
  0.03149999999999938 V`;
- pure Neumann, niezbilansowany: solve kończy się kodem ABI
  `ERROR_BALANCE_FAILURE = 8`;
- typed mixed anchored/free: średnia komponentu zakotwiczonego
  `0.12499999999999592 V`, średnia komponentu swobodnego
  `-2.710505431213761e-20 V`, maksimum bezwzględne komponentu swobodnego
  `0.0015000000000000352 V`, dwa rozłączne komponenty.

Pozostałe obserwable tego runu pozostały zgodne z bazowym kontraktem:
uniform ma 26 iteracji, residual algebraiczny
`4.4700700269648826e-15`, fizyczny `3.6043853964842183e-14`,
`hierarchy_levels=2`, jeden build, jeden cache hit i `host_fallback_count=0`;
layered ma skok strumienia `5.46875e-14`, a strict-residency potwierdza
19 zdarzeń źródłowych, 14 restore i dokładną kolejność. Komunikat o PCG
przerwanym po jednej iteracji pochodzi z celowej fault-injection w transfer-audit
i nie jest błędem bramki.

Ten wynik zamyka managed proof bounded zero-mean realization, ale nie zmienia
granic publicznej kwalifikacji: publiczny zero-mean gauge istnieje wyłącznie
dla opisanego w sekcji 7.3 pełnopowierzchniowego profilu dwóch elektrod
`NormalCurrentElectrode`. Nie ma persistent Krylov warm start w tym przepływie,
publicznego dispatchu spin/SHE/mixing/torque, mesh convergence,
cross-backend parity ani produkcyjnego statusu. Ogólna capability pozostaje
`semantic_only`.

#### Ownership, lifecycle, and immutable charge state

The sole implementation owner is `backends/fdm/gpu/cuda/transport/**`. It owns
an opaque `GpuTransportContext` with device identity, compute stream and
events, allocator/pool, immutable geometry/material/operator revisions,
separate persistent charge and spin Krylov workspaces, snapshot generation,
transfer audit, and convergence telemetry. Transport must not extend the LLG
`Context`, add transport physics to `mfem_bridge.cpp`, or place operator/solver
work in Rust engine or runner code. Rust may materialize descriptors, invoke
the append-only ABI, publish artifacts, and preserve provenance only.

The lifecycle is:

1. create the context for one explicit CUDA device and FP64 precision;
2. upload and validate one immutable static descriptor;
3. solve charge entirely on that device;
4. atomically accept an immutable device snapshot;
5. solve steady spin against that snapshot and device `m_stage`;
6. compute torque device-to-device for the LLG RHS;
7. read back bounded scalar telemetry and configured artifacts only;
8. destroy snapshots, workspaces, and context with explicit ownership checks.

An accepted charge state is an **immutable device snapshot**, not a host object
with borrowed device pointers. It contains at least:

- `V[N]` in FP64;
- exactly one globally positive oriented face-current family:
  `Jx[(nx+1)ny nz]`, `Jy[nx(ny+1)nz]`, and `Jz[nx ny(nz+1)]` in FP64;
- charge-active/conductor masks and the immutable conductivity/operator
  revision used to interpret them;
- every oriented mixing descriptor, its two accepted charge traces, and its
  single conservative charge observation;
- every exact-density external face selected by
  `NormalCurrentElectrode [A/m2]`, including axis, face index, adjacent active
  cell, outward-normal sign, area, and density;
- context, source, operator, snapshot-generation, and convergence identities.

Spin accepts only the snapshot handle plus its generation. It may not accept
parallel host arrays for $V$, $J_c$, traces, or reconstructed $E$. A new charge
acceptance creates a new generation; it never mutates a snapshot already
visible to spin. Context mismatch, source/operator revision mismatch, a stale
generation, pre-acceptance consumption, or use after destroy fails before any
spin kernel launch.

#### Frozen typed static payloads for steady spin

The outer v1 operation records and their 18-record manifest remain byte-for-byte
frozen. In particular, `steady_spin_solve_request_v1` remains 176 bytes and
`steady_spin_solve_result_v1` remains 176 bytes. The following payload records
are append-only records selected by the six buffer views of
`static_descriptor_v1`; they are not additional manifest records. Every record
starts with the common 32-byte v1 prefix, is aligned to 8 bytes, accepts only a
larger optional tail at `struct_version=1`, and rejects an unknown required bit,
short record, nonzero reserved field, invalid stride, or arithmetic overflow
before pointer access.

| C payload type | Bytes | Exact ordered tail (`offset:name:type`) | Known features |
|---|---:|---|---:|
| `fullmag_fdm_gpu_transport_spin_cell_v1` | 72 | `32:active:u32;36:conductor:u32;40:material_index:u32;44:reserved1:u32;48:spin_active:u32;52:torque_target:u32;56:region_id:u32;60:reserved2:u32;64:saturation_magnetization:f64` | `0x0c` |
| `fullmag_fdm_gpu_transport_spin_material_v1` | 112 | existing charge-material prefix `32:material_index:u32;36:reserved1:u32;40:conductivity:f64;48:material_revision:u64`, then `56:spin_conductivity:f64;64:polarization:f64;72:spin_hall_angle:f64;80:spin_flip_length:f64;88:exchange_length:f64;96:dephasing_length:f64;104:spin_revision:u64` | `0x0c` |
| `fullmag_fdm_gpu_transport_spin_boundary_face_v1` | 104 | `32:kind:u32;36:axis:u32;40:side:i32;44:outward_sign:i32;48:adjacent_cell:u64;56:canonical_face_index:u64;64:area:f64;72:potential_xyz:f64[3];96:source_id:u64` | `0x08` |
| `fullmag_fdm_gpu_transport_spin_interface_v1` | 176 | `32:kind:u32;36:axis:u32;40:orientation:i32;44:reserved1:u32;48:negative_cell:u64;56:positive_cell:u64;64:from_cell:u64;72:to_cell:u64;80:canonical_face_index:u64;88:area:f64;96:G_up:f64;104:G_down:f64;112:G_r:f64;120:G_i:f64;128:magnetization_xyz:f64[3];152:source_id:u64;160:topology_id:u64;168:charge_edge_enabled:u32;172:reserved2:u32` | `0x1c` |
| `fullmag_fdm_gpu_transport_formula_ids_v1` | 144 | existing charge formula fields through offset 63, then `64:spin_formula_id:u32;68:spin_operator_id:u32;72:electric_reconstruction_id:u32;76:interface_formula_id:u32;80:torque_operator_id:u32;84:spin_engine_id:u32;88:preconditioner_id:u32;92:spin_residual_id:u32;96:local_residual_id:u32;100:reserved2:u32;104:spin_operator_revision:u64;112:preconditioner_revision:u64;120:gamma_e:f64;128:gmres_restart:u64;136:reserved3:u64` | `0x1c` |
| `fullmag_fdm_gpu_transport_spin_observation_record_v1` | 288 | `32:kind:u32;36:axis:u32;40:orientation:i32;44:reserved1:u32;48:cell_index:u64;56:source_id:u64;64:topology_id:u64;72:canonical_face_index:u64;80:negative_cell:u64;88:positive_cell:u64;96:from_cell:u64;104:to_cell:u64;112:region_id:u32;116:reserved2:u32;120:charge_from_trace_v:f64;128:charge_to_trace_v:f64;136:charge_delta_trace_v:f64;144:lane0_xyz:f64[3];168:lane1_xyz:f64[3];192:lane2_xyz:f64[3];216:lane3_xyz:f64[3];240:lane4_xyz:f64[3];264:lane5_xyz:f64[3]` | exactly `0x48` |

The six views retain their frozen meanings and order: cells, materials,
interfaces, charge faces, spin boundary faces, and formula IDs. Spin-aware cell,
material, and formula records preserve the existing charge record as their
leading byte-compatible subrecord, so a charge-only v1 consumer reads exactly
the same charge fields and ignores the larger stride. A descriptor that requests
steady spin requires the spin-aware forms and complete external spin-face
coverage. The supported bounded boundary registry is `invalid=0`,
`insulating=1`, `sink=2`, `specified_potential=3`; other values, including
specified flux and periodic, fail closed. The interface registry is
`transparent=1`, `mixing_conductance_v2=2`, `sml_reservoir_v2=3`, but the
bounded M1 GPU realization rejects SML. `charge_edge_enabled` must be one for a
transparent or longitudinal mixing edge and exact zero for the legal
transverse-only branch.

Each interface is identified by the tuple `(source_id, topology_id, axis,
canonical_face_index, negative_cell, positive_cell, from_cell, to_cell)`.
Records may arrive in any order; matching by array position is forbidden. The
two endpoint cells must be adjacent, active and spin-active, `from -> to` is the
authored N-to-F direction, and exactly one observation must be published for
each identity. `G_up`, `G_down`, and `G_r` are finite and nonnegative; `G_i` is
finite and signed; the interface magnetization is unit length. A torque target
has finite positive $M_s$, and the formula record carries one finite positive
$\gamma_e$. Disabled reaction lengths are exact zero; enabled lengths are
finite and positive. Polarization is in $[-1,1]$ and the signed spin Hall angle
is finite.

The closed spin ID registries are: formula
`transport_constitutive.one_way.fullmag.v1=1`, operator
`fv_spin_upwind_v1=1`, electric reconstruction
`fdm_exact_face_current_electric_reconstruction.v1=1`, interface
`magnetoelectronic.fullmag.v2=1`, torque
`fdm_transport_torque_cell_surface_balance.v1=1`, engine
`fdm_spin_block_gmres_cuda_v1=1`, preconditioner
`component_amg_block_jacobi_v1=1`, integrated residual
`transport_balance_integrated_l2.v1=1`, and local residual
`transport_balance_local_fv.v1=1`. Zero and unknown values fail closed. The
production policy requires `gmres_restart=50`; policy 2 uses a separately named
prototype engine and cannot publish these production IDs.

For a descriptor with `M1_CHARGE|STEADY_SPIN`, all six views are
`host_read_only`, `element_type=raw_bytes`, `component_order=scalar` and have
8-byte-aligned non-overlapping ranges. The exact contracts are:

| View | Count | Byte stride | Empty rule | Payload `required_features` |
|---|---:|---:|---|---:|
| cells | `nx*ny*nz` | 72 | forbidden | exactly `0x04` |
| materials | number of unique referenced material IDs, at least one | 112 | forbidden | exactly `0x04` |
| interfaces | number of authored internal interfaces | 176 | allowed only with address/length zero | transparent exactly `0x04`; mixing exactly `0x14` |
| charge faces | exactly all external structured faces | 88 | forbidden | exactly `0x04` |
| spin boundary faces | exactly all external structured faces | 104 | forbidden | exactly `0x08` |
| formula IDs | 1 | 144 | forbidden | exactly `0x04` |

`byte_length` is exactly `element_count*byte_stride` under checked arithmetic;
an empty interface view still carries stride 176. The three spin-aware records
with a charge prefix deliberately retain `required_features=0x04`, so an old
charge parser accepts the prefix and larger stride. The descriptor feature graph
(`required_features` contains `0x0c`, or `0x1c` when mixing is authored), the
exact spin stride and each tail field then make the spin extension mandatory;
the payload prefix is not overloaded to advertise its optional tail. All six
nonempty byte ranges are pairwise disjoint, and no device/unified pointer is
legal during static upload.

After a successful solve, the accepted snapshot token also owns immutable
device-resident $\mu_s$, complete oriented $Q_x/Q_y/Q_z$, separate
$R_{sf}/R_J/R_\phi$ channels, order-independent interface observations
(incoming, backflow, absorbed, both one-sided fluxes and reserved zero SML
channels), volume and surface torque terms, final torque in $\mathrm{s^{-1}}$,
all four physical balances, the deterministic compute digest, and the
scientific continuation digest. Artifact record 11 remains frozen with feature
mask `0x44`; legality of `mu_s`, `Q_ia`, torque and observations is determined
from the accepted spin state and `field_id`, not by changing that record mask.

Artifact field 7 is the only transport-observation stream; the closed artifact
field registry remains 0--7. Its destination is a range-bounded array of
`fullmag_fdm_gpu_transport_spin_observation_record_v1` records with
`raw_bytes/scalar`, 288-byte stride, exact record feature mask `0x48`, and the
closed kind registry `0 invalid`, `1 reaction`, `2 torque`, `3 interface`.
Unknown kinds, nonzero reserved fields, a different stride/component order, or
any smaller record are invalid. The stream order is independent of authored
interface order: reaction records for cells in increasing linear-cell order,
then torque records in that order, then interface records sorted
lexicographically by `(source_id, topology_id, axis, canonical_face_index,
negative_cell, positive_cell, from_cell, to_cell)`.

Every lane is an `xyz` vector. Reaction records use lanes 0--2 for
$(R_{sf},R_J,R_\phi)$ in $\mathrm{A\,m^{-3}}$; torque records use lanes 0--2
for `(volume,surface,total)` in $\mathrm{s^{-1}}$; interface records use lanes
0--5 for `(incoming,backflow,absorbed,negative-positive-axis-flux,
positive-positive-axis-flux,SML)` in $\mathrm{A\,m^{-2}}$. Unused metadata and
lanes are exact zero. `cell_index` and `region_id` are populated only for cell
records; the complete source/topology/orientation/face/from/to identity is
populated only for interface records. The bounded M1 lane emits an exact-zero
SML vector because `sml_reservoir_v2` remains unsupported. Artifact field 5
continues to expose the final total torque SoA and is not reinterpreted.
Interface records additionally preserve the accepted oriented charge traces
`charge_from_trace_v`, `charge_to_trace_v`, and their exact difference used by
the M1 mixing law; cell records keep those three fields exact zero.

#### Discrete operator invariants

The GPU charge operator is the same conservative finite-volume map as the CPU
oracle: harmonic bulk conductivity, one globally oriented current per face,
equal-and-opposite cell balance, explicit component gauge, and one-way series
trace elimination. The public density boundary is applied to the exact face
list; total current, a whole-plane mask, or a host-side redistribution is not
an equivalent input. Host and device validation both reject an internal,
inactive, duplicate, nonfinite, wrong-area, or outward-sign-inconsistent face.

The spin operator uses
`fdm_exact_face_current_electric_reconstruction.v1`. Its normal electric
component is the exact accepted $J_{c,f}/\sigma_f$; cell and tangential
components are reconstructed from the same accepted face currents. Reading
cell-centred $V$ to form another electric field is forbidden. Direct SHE must
exercise all six signed Levi-Civita contractions separately:

| Nonzero contraction | Sign |
|---|---:|
| $\epsilon_{xyz}$ | $+1$ |
| $\epsilon_{yzx}$ | $+1$ |
| $\epsilon_{zxy}$ | $+1$ |
| $\epsilon_{xzy}$ | $-1$ |
| $\epsilon_{zyx}$ | $-1$ |
| $\epsilon_{yxz}$ | $-1$ |

For one face globally oriented from its negative-axis cell $K^-$ to its
positive-axis cell $K^+$, define
$q_p=P_fJ_{c,f}$ with $P_f=(P_{K^-}+P_{K^+})/2$. The backend-neutral
`fv_spin_upwind_v1` rule is exact: $q_p>0$ selects $m_{K^-}$, $q_p<0$ selects
$m_{K^+}$, and exact zero selects the negative-axis cell and multiplies it by
exact zero, so the polarized contribution is exactly zero in every component.
No epsilon, signbit, previous-flow direction, thread order, or
central average may break the zero tie. This is the frozen rule implemented by
the CPU oracle, not an implementation-dependent referral to it. Transparent
faces preserve one charge and one spin flux. Full one-way mixing preserves longitudinal injection/backflow and
the transverse absorption
$G_r m\times(\Delta\mu_s\times m)+G_i(\Delta\mu_s\times m)$.
The `transverse-only` case $G_{\uparrow}=G_{\downarrow}=0$ with nonzero
$G_r$ or $G_i$ is legal: charge is insulating and does not join gauge
components, but transverse spin and torque remain active. No kernel may divide
by $G_{\uparrow}+G_{\downarrow}$ in that branch.

Volumetric $R_J+R_\phi$ and absorbed surface flux feed exactly one magnetic
owner through `fdm_transport_torque_cell_surface_balance.v1`. Longitudinal
spin-flip is reported as a nonmagnetic sink and is never counted again as
torque. Cell-local FV residual, global spin balance, interface balance, and
integrated volume-plus-surface torque closure are independent acceptance
checks; the Krylov residual cannot substitute for them.

#### Solver policy and bounded first executable slice

Charge uses `fdm_charge_cg_cuda_v1`: device CG, component-wise gauge handling,
fixed-tree FP64 reductions, and device AMG. Spin uses
`fdm_spin_block_gmres_cuda_v1`: restarted device GMRES with component
AMG/block-Jacobi, a bounded restart/memory budget, and device convergence
reductions. A Jacobi-only charge prototype must publish a distinct prototype
engine identity; it cannot claim the production AMG engine. Likewise, a local
$3\times3$ reaction inverse may be a named prototype preconditioner but cannot
silently replace the frozen component AMG/block-Jacobi policy.

Production GPU memory resolution uses `memory_policy=auto`. After static state
has been materialized on the selected CUDA context, the runtime reads
`cudaMemGetInfo`, freezes a safety reserve, and computes `usable_bytes` from the
actual free memory. Before any solve-owned allocation it must estimate and
publish separate `first_required_bytes` and `warm_required_bytes`; the latter
includes the immutable accepted state, the candidate state and every live
hierarchy/workspace phase. For cold AMG construction, where device-side
coarsening may reduce storage only after inspection of the operator,
`first_required_bytes` is a conservative pre-allocation upper bound rather
than a measured peak; provenance must identify estimate kind and the later
measured high-water value separately. Warm-cache requirements are computed
from the resolved resident hierarchy and must not be labelled as cold bounds.
An insufficient budget fails closed before the
first allocation and never enables CPU fallback. Because cache identity also
depends on the assembled `m_stage` digest, a warm attempt uses the same cold
upper bound for its pre-allocation gate; its exact retained-hierarchy
requirement is published only as a post-cache-hit audit, never misreported as
the earlier preflight. Provenance records the
resolved policy, device total/free memory, static baseline, safety reserve,
usable bytes, estimate kind, first/warm required bytes and measured high-water
bytes. `memory_policy=fixed`
is reserved for reproducible tests and qualification workloads. In particular,
512 MiB is the frozen external envelope of `performance_v1`, and 2 GiB is its
warm transactional high-water envelope; neither value is a global production
cap.

The first executable slice is intentionally bounded to one structured
single-grid domain on one CUDA device, FP64-only, explicit static materials,
axis-aligned external density/voltage/insulating charge faces, component
gauge, insulating/sink/specified-potential spin boundaries, transparent faces
or one oriented N-to-F mixing family, one accepted charge snapshot, and one
steady spin/torque evaluation for a supplied device `m_stage`. It includes the
six direct-SHE signs and the legal transverse-only branch. Periodic transport,
M2/iSHE/AMR/PHE/AHE, M3, SML reservoir, multiple devices, MPI, FP32, dynamic
Oersted, and production-scale performance remain later milestones. FP32
remains fail-closed and `auto` cannot select it.

#### Strict residency, determinism, failure, and provenance

Strict execution permits zero vector transfers per stage outside explicitly
configured output/checkpoint cadence. It permits bounded scalar reductions and
status readback, but every transfer and synchronization has versioned transfer
telemetry and provenance: direction, byte count, reason, count, stage,
iteration scope, stream/event identity, and whether it was allowed by cadence.
There is no CPU fallback, CPU operator/preconditioner, host convergence loop,
or host reconstruction of $E$, $J_c$, $\mu_s$, $Q$, or torque. A violation
returns `strict_gpu_residency_violation` and aborts the run.

Deterministic mode owns each face and interface torque exactly once and uses a
fixed launch geometry and reduction tree. Provenance records GPU name/UUID,
compute capability, driver/runtime, build identity and compiler flags including
FMA/fast-math policy. The promise is bitwise repetition on the same
device/runtime/build; CPU-to-GPU comparisons use the physical tolerances below.

Every solve is provisional until all algebraic and physical gates pass. A
rejected attempt appends its reason but cannot advance accepted revisions,
publish fields, replace warm starts, or mutate immutable accepted snapshots.
The cache key includes normalized descriptor, grid/material/operator/source
revisions, precision, device identity, formula/operator/engine/residual IDs,
and snapshot generation. Restart uses the versioned
`fullmag.fdm_gpu_transport_checkpoint.v1` export/import contract, not an
identity-only record and not a deterministic re-solve. Its committed payload
contains bitwise FP64 $V$, face $J_c$, traces and observations; accepted
$\mu_s$, face $Q$, reactions, interface observations and torque when present;
charge/spin Krylov warm starts; lineage, accepted sequence, revisions,
deterministic policy, work budgets and telemetry cursor. SHA-256 section and
payload digests, little-endian layout, exact device/runtime/build/operator
identity and an atomic provisional restore are mandatory. A successful restore
creates a fresh process-local token while preserving the lineage, accepted
sequence and content digest. Any incompatibility or partial payload restores
nothing; there is no cross-device migration, partial commit or re-solve
fallback.

Restart uses two deliberately separate digest lanes. The
`scientific_continuation_digest` covers accepted arrays and deterministic
solver continuation state; it excludes export/import/readback operations. The
append-only `operation_audit_digest` covers every actual transfer,
synchronization, and explicitly classified rejected attempt, including a
failed import after H2D. Pure handle/state calls without CUDA activity do not
invent zero-byte transfer records. Consequently the
full telemetry stream is not compared between uninterrupted and restarted
runs. Qualification compares the next deterministic compute and scientific
continuation digests exactly, then verifies the expected checkpoint events and
their audit parent chain separately.

Successful telemetry/provenance includes requested and resolved
`fdm/gpu/double/strict`, formula/operator/engine/residual IDs, iteration and
convergence reasons, algebraic plus physical residuals, charge/electrode/spin/
interface/torque balances, snapshot/cache identity, transfer/synchronization
audit, `host_fallback_count=0`, peak device/workspace bytes,
`row_major_Q_ia`, and face/interface orientation.

#### TDD and qualification matrix

Each row requires a non-skipped managed CUDA run on an identified physical
device. Compilation, host emulation, and source inspection are not device
evidence.

| Gate ID | Fixture and frozen parameters | Exact oracle | Metric and tolerance/budget | Required device/artifact proof |
|---|---|---|---|---|
| `layout_abi_v1` | `fdm_gpu_m1_layout_abi_v1`: every v1 prefix, numeric enum/ID/flag registry, `MIN_SIZE_V1`, four-slot token registry, create/destroy/reuse, stale generation, double destroy, generation exhaustion, and codec-only golden | `oracle.generated_c_header_layout_v1`: exact C `sizeof`/`alignof`/`offsetof` and numeric tables plus independent decoder of codec-only golden length=1600 bytes and codec-only golden SHA-256=ad8d00c7c4d3c349ee203946145b9d02f8e34f331ee9687645c9c981bb33b803 | every byte, discriminant, legal mask and status exact; 100% invalid/unknown values and tuple/subrecord mutations reject before pointer access | non-skipped managed lifecycle/decoder run with GPU UUID and `fdm-gpu-m1-layout-abi-v1.json` |
| `charge_uniform_v1` | `fdm_gpu_m1_charge_uniform_v1`: $64\times4\times2$, $\Delta x=1\,\mathrm{nm}$, $\sigma=5\times10^6\,\mathrm{S/m}$, $V(0)=64\,\mathrm{mV}$, $V(64\,\mathrm{nm})=0$ | `oracle.charge_uniform_linear_v1`: $E_x=10^6\,\mathrm{V/m}$ and every positive-x face $J_c=5\times10^{12}\,\mathrm{A/m^2}$ | $V,J_c$ `rtol<=1e-12`, charge balance `<=1e-10` of flux scale | non-skipped managed FP64 run with GPU UUID and `fdm-gpu-m1-charge-uniform-v1.json` containing fields, residuals and snapshot digest |
| `charge_layered_v1` | `fdm_gpu_m1_charge_layered_v1`: two $32\,\mathrm{nm}$ layers, $\sigma_1=2\times10^6$, $\sigma_2=8\times10^6\,\mathrm{S/m}$, $\Delta V=50\,\mathrm{mV}$ | `oracle.charge_layered_series_v1`: $R_A=2.0\times10^{-14}\,\Omega\,\mathrm{m^2}$, every oriented face $J_c=2.5\times10^{12}\,\mathrm{A/m^2}$ and analytic piecewise-linear $V$ | current and $V$ `rtol<=1e-10`; interface flux jump `<=1e-12` of $J_c$ | non-skipped managed CPU/GPU FP64 run with GPU UUID and `fdm-gpu-m1-charge-layered-v1.json` |
| `density_face_bc_v1` | `fdm_gpu_m1_density_face_bc_v1`: $4\times2\times1$ grid with four ordered external faces, areas $[1,1,2,2]\times10^{-18}\,\mathrm{m^2}$ and outward densities $[1,-2,3,-4]\times10^{11}\,\mathrm{A/m^2}$ | `oracle.density_face_descriptor_v1`: accepted values match descriptor order and $I=\sum_f A_f j_f=-3\times10^{-7}\,\mathrm{A}$; internal, duplicate, inactive, wrong-area and wrong-sign mutations are rejected | each face value/sign/identity exact; integrated $I$ `rtol<=1e-12`; 100% invalid mutations reject | non-skipped managed run with GPU UUID and `fdm-gpu-m1-density-face-bc-v1.json` containing the authored and accepted face lists |
| `component_gauge_v1` | `fdm_gpu_m1_component_gauge_v1` bounded fixture in `fdm_gpu_m1_charge_uniform_v1_contract`: two disconnected 512-cell conductors separated by a transverse-only charge-insulating interface; left component has $V=0.125\,\mathrm{V}$ datum, while free component B has no voltage datum and has balanced exact-density Neumann flux | `oracle.component_graph_gauge_v1`: typed graph has two components, no charge edge across the interface, left datum is preserved, and right component has arithmetic mean zero | anchored mean `atol<=1e-10 V`; free mean `atol<=1e-14 V` relative to its nonzero profile; unbalanced pure-Neumann returns `ERROR_BALANCE_FAILURE` | non-skipped managed run with GPU UUID; `fdm-gpu-m1-charge-uniform-v1.json` records `zero_mean_pure_mean`, `zero_mean_unbalanced_status`, mixed anchored/free means, and `host_fallback_count=0` |
| `charge_snapshot_v1` | `fdm_gpu_m1_charge_snapshot_v1`: validate the synthetic frozen IDs 1--9/18/20 sequence-7 payload as codec oracle A and reject its identity in the actual context; separately solve/export an actual-runtime sequence-7 one-cell payload B, then import B in a fresh exact-matching context | `oracle.snapshot_registry_checkpoint_v1`: A has length=4352 bytes, SHA-256=ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5 and embedded hash `bc3bcc1b51314fe46e0bbd2f71e94f1517f8e438943853e33b8e79b1495c7b60`; B has the same canonical length/sections but an identity-dependent SHA | A byte grammar and SHA exact plus cross-identity `checkpoint_incompatible`; B length exactly 4352 bytes, identity exact, committed SHA self-consistent, fresh-context $V/J_c$ bitwise exact without re-solve; failed operations leave accepted state unchanged | non-skipped managed lifecycle run with GPU UUID and `fdm-gpu-m1-charge-snapshot-v1.json` containing both A-oracle and B-runtime results |
| `spin_diffusion_v1` | `fdm_gpu_m1_spin_diffusion_v1`: $L=100\,\mathrm{nm}$, $\lambda_{sf}=10\,\mathrm{nm}$, $\mu_s(0)=(1,0,0)\,\mathrm{mV}$, $\mu_s(L)=0$, grids 64/128/256 | `oracle.spin_diffusion_sinh_v1`: $\mu_x(x)=1\,\mathrm{mV}\,\sinh((L-x)/\lambda_{sf})/\sinh(L/\lambda_{sf})$, other components exact zero | profile `rtol<=1e-9`; local/global balance `<=1e-10`; forbidden components exact zero | non-skipped managed CPU/GPU FP64 run with GPU UUID and `fdm-gpu-m1-spin-diffusion-v1.json` containing three grids |
| `direct_she_six_signs_v1` | `fdm_gpu_m1_direct_she_six_signs_v1`: six one-gradient cases with $E_k=10^5\,\mathrm{V/m}$, $\theta_{SH}=0.1$, $\sigma=5\times10^6\,\mathrm{S/m}$ plus $\theta_{SH}=0$ | `oracle.levi_civita_six_v1`: amplitude $5\times10^{10}\,\mathrm{A/m^2}$ with signs $xyz,yzx,zxy=+1$ and $xzy,zyx,yxz=-1$; all other components zero | active component `rtol<=1e-12`; sign and zero components exact | non-skipped managed kernel run with GPU UUID and `fdm-gpu-m1-direct-she-six-signs-v1.json` containing seven outputs |
| `face_current_e_v1` | `fdm_gpu_m1_face_current_e_v1`: $\sigma_-=2\times10^6$, $\sigma_+=8\times10^6\,\mathrm{S/m}$, harmonic $\sigma_f=3.2\times10^6\,\mathrm{S/m}$, accepted $J_{c,f}=4\times10^{12}\,\mathrm{A/m^2}$, then perturb unused cell $V$ | `oracle.face_current_e_v1`: $E_{n,f}=1.25\times10^6\,\mathrm{V/m}$ and unchanged direct-SHE $Q$ from the accepted face current | $E,Q$ bitwise unchanged by $V$ mutation; CPU/GPU values `rtol<=1e-12` | non-skipped managed mutation run with GPU UUID and `fdm-gpu-m1-face-current-e-v1.json` plus face-current digest |
| `upwind_three_way_v1` | `fdm_gpu_m1_upwind_three_way_v1`: $P_f=0.4$, $m_-=(1,0,0)$, $m_+=(0,1,0)$ and $J_{c,f}=+2\times10^{12},-2\times10^{12},+0.0\,\mathrm{A/m^2}$ | `oracle.upwind_three_way_v1`: polarized terms $(8\times10^{11},0,0)$, $(0,-8\times10^{11},0)$ and exact `(+0.0,+0.0,+0.0)` with the negative-axis endpoint selected for the zero tie | nonzero vectors `rtol<=1e-12`; owner ID and all exact-zero bits exact | non-skipped managed three-case run with GPU UUID and `fdm-gpu-m1-upwind-three-way-v1.json` |
| `mixing_interface_v2` | `fdm_gpu_m1_mixing_interface_v2`: transparent case with two $1\,\mathrm{m}$ cells, $\sigma_s=2\,\mathrm{S/m}$, $\mu_-=(1,0,0)\,\mathrm{V}$, $\mu_+=0$, $P=\theta_{SH}=J_c=0$; plus oriented $N\to F$ cases with $m=(0,0,1)$, $\Delta V=2\,\mathrm{mV}$, $\Delta\mu_s=(3,4,5)\,\mathrm{mV}$, $G_\uparrow=7\times10^{14}$, $G_\downarrow=3\times10^{14}$, $G_r=2\times10^{14}$, $G_i=-10^{14}\,\mathrm{S/m^2}$; repeat reversed storage orientation and with $G_\uparrow=G_\downarrow=0$ | `oracle.mixing_one_way_numeric_v2`: transparent one-sided fluxes $(1,0,0)\,\mathrm{A/m^2}$; full $q_\parallel=(0,0,3.3\times10^{12})$, $q_{abs}=(2\times10^{11},1.1\times10^{12},0)$, N/F fluxes $(2\times10^{11},1.1\times10^{12},3.3\times10^{12})$ and $(0,0,3.3\times10^{12})\,\mathrm{A/m^2}$; reversed positive-axis fluxes are their signed swapped values; transverse-only has $j_c=0$, N flux $q_{abs}$ and F flux zero | every one-sided component `rtol<=1e-12`; charge/interface/absorption closure `<=1e-10`; transverse-only gauge edge count exact zero | non-skipped managed four-case run with GPU UUID and `fdm-gpu-m1-mixing-interface-v2.json` containing all public interface observations |
| `torque_balance_v1` | `fdm_gpu_m1_torque_balance_v1`: one $2\,\mathrm{nm}$ cube, $M_s=8\times10^5\,\mathrm{A/m}$, volume reaction $R_J+R_\phi=(1,-2,0)\times10^{15}\,\mathrm{A/m^3}$ and one $4\,\mathrm{nm^2}$ face with $q_{abs}=(0.8,4.4,0)\times10^6\,\mathrm{A/m^2}$ | `oracle.torque_volume_surface_v1`: bracket $(1.4,0.2,0)\times10^{15}\,\mathrm{A/m^3}$ and $T_{tr,G}=-(\gamma_e\hbar/(2eM_s))(1.4,0.2,0)\times10^{15}\,\mathrm{s^{-1}}$ | cell torque `rtol<=1e-12`; integrated angular-momentum closure `<=1e-10`; spin-flip contribution exact zero | non-skipped managed CPU/GPU FP64 run with GPU UUID and `fdm-gpu-m1-torque-balance-v1.json` containing volume and surface terms separately |
| `strict_residency_v1` | `fdm_gpu_m1_strict_residency_v1`: one public charge-to-spin-to-torque stage without cadence, followed by readback of exactly 64 FP64 `V` values and export of an actual-runtime complete charge checkpoint | `oracle.transfer_reason_accounting_v1`: zero stage-vector events, then one `artifact_readback_d2h` and one `checkpoint_export_d2h`; `artifact D2H=512 bytes`, `checkpoint D2H=4352 bytes`, identity-dependent committed payload SHA, `host_fallback_count=0` | stage H2D/D2H bytes exactly zero; authorized totals/counts and runtime payload SHA self-consistent; every synchronization reason classified | non-skipped managed device timeline with GPU UUID and `fdm-gpu-m1-strict-residency-v1.json` plus exported runtime checkpoint |
| `determinism_restart_v1` | `fdm_gpu_m1_determinism_restart_v1`: two uninterrupted repeats and one actual-runtime export/destroy/new-context/import continuation of a 4352-byte sequence-7 checkpoint; the separate frozen oracle A supplies codec mutations for truncation, corruption, unknown required ID, nonzero or surplus-zero padding, wrong ID-1 tuple, subrecord `record_bytes`, field type, extra inter-section block and missing required section | `oracle.checkpoint_bitwise_continuation_v1`: runtime payload B preserves exact device/build/static identity, lineage/sequence/content, and next field/balance/iteration/`deterministic_compute_digest`/`scientific_continuation_digest`; frozen payload A retains exact SHA-256 `ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5` solely as codec oracle and must reject across actual identity; `operation_audit_digest` independently proves export/import or failed-import events | scientific/compute digests exact; full telemetry stream is not compared; 100% semantic decoder/import mutation rejection and every actual transfer remains in the audit chain | non-skipped same-GPU UUID managed triplet with `fdm-gpu-m1-determinism-restart-v1.json`, audit records and complete runtime checkpoint payload |
| `public_path_v1` | `fdm_gpu_m1_public_path_v1`: normalized ProblemIR for $8\times4\times2$, double/strict GPU, $\sigma=5\times10^6\,\mathrm{S/m}$, $\theta_{SH}=0.1$, x-min density $10^{11}\,\mathrm{A/m^2}$, x-max $V=0$, insulating spin BC and one torque target | `oracle.public_artifact_manifest_v1`: exact requested/resolved tuple plus required artifacts `V,J_c,mu_s,Q_ia,torque_stt`, charge/spin/interface balances, transfer audit and checkpoint identity with frozen SI units/components | normalized ProblemIR, requested/resolved identity and artifact key set 100% exact; numeric fields meet their gate tolerances | non-skipped managed ProblemIR-planner-runner-ABI-CUDA run with GPU UUID and `fdm-gpu-m1-public-path-v1.json` plus artifact manifest |
| `convergence_v1` | `fdm_gpu_m1_convergence_v1`: uniform/layered charge and 1-D spin on 32/64/128 cells; transverse-only N/F interface with $y\in[0,1]\,\mathrm{m}$, unit depth, $m=(0,0,1)$, $G_\uparrow=G_\downarrow=G_i=0$, $G_r=2\,\mathrm{S/m^2}$, $\Delta\mu_s=(y^2,0,0)\,\mathrm{V}$, and mixing grids 2x16x1, 2x32x1, and 2x64x1 | `oracle.richardson_orders_v1`: analytic charge/spin solutions and mixing $q_{abs}=(2y^2,0,0)\,\mathrm{A/m^2}$ with exact integral $2/3\,\mathrm{A/m}$; composite midpoint error $e_n=1/(6n^2)\,\mathrm{A/m}$ | charge/spin order `>=1.8`, ratio `>=3.5`; mixing order `>=1.99`, successive ratio `[3.99,4.01]`, pointwise `rtol<=1e-13`; all balances `<=1e-10` | non-skipped managed mesh sweep with GPU UUID and `fdm-gpu-m1-convergence-v1.json` containing raw norms, exact errors, ratios and fitted orders |
| `performance_v1` | `fdm_gpu_m1_performance_v1`: $1024\times128\times8=1,048,576$ cell racetrack, fixed solver tolerances, output/checkpoint disabled, `memory_policy=fixed`, one first solve then five warm transactional solves on one recorded GPU UUID/runtime/build | `oracle.absolute_fdm_gpu_m1_budget_v1`: workload-specific fixed qualification envelope, not a global runtime cap | first-solve external envelope `<=536870912` bytes; warm transactional peak `<=2147483648` bytes; setup <=5 s; median total solve <=30 s; p95 total solve <=36 s; forbidden transfer bytes exact zero | five non-skipped managed runs with GPU UUID and `fdm-gpu-m1-performance-v1.json` containing raw setup/apply/solve/reduction times, first/warm required bytes, total/free/baseline/reserve/usable memory, resolved policy and high-water marks |

These gates define qualification. The bounded charge rows named in the status
section have actual-device contract evidence, while every other row remains a
future gate; the table as a whole is not evidence that a public GPU runner,
broader M1 executable workload, parity result or production qualification
exists.

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

(python-api)=
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
these fields. The general M2 lane remains semantic_only until the workload
gates below close; the bounded FEM CPU slice is reference_executable only for
the exact scope in section 7.2 and must not be interpreted as a general
FDM/FEM/GPU execution guarantee.

(round-trip-and-failure-semantics)=
### 4.1.1 Requested intent, resolved execution, and failure semantics

The authoring round trip preserves requested intent separately from resolved
execution. The Python fields for coupling, material tensor, solver policy,
requested discretization, device, precision, and execution mode lower into
ProblemIR; planner normalization then records the resolved constitutive model,
operator version, lane, and qualification state. A successful bounded M2 run
must expose both records in its descriptor and provenance. No resolver may
silently substitute M1, FDM, or a different device when the requested
combination is unsupported.

Validation errors are fail-closed and identify the owning field and the
physical reason. Examples are a missing reciprocal conductivity, a nonpositive
Schur complement, a mixed charge tensor outside the bounded FEM scope, an
incompatible nonlinear policy, a missing charge gauge, or a GPU request without
an executable transport operator. Unsupported combinations remain visible as
diagnostics and do not produce a plausible-looking fallback artifact.

The following table is the complete public parameter inventory for the bounded
M2 authoring slice. The ProblemIR column is the canonical normalized path; an
export/import cycle must preserve the value and its units.

| Python parameter | Type | Default | SI unit | Validation | Physical meaning | Executable scope | ProblemIR mapping |
|---|---|---|---|---|---|---|---|
| CurrentTransport.coupling | Literal['one_way','bidirectional'] | one_way | $1$ | bidirectional requires the complete reciprocal material and a steady FEM M2/FDM M2-compatible solver policy | source-owned charge/spin reciprocity | FEM CPU bounded M2; FDM CPU bounded reference; GPU semantic-only | current_modules[].coupling |
| ChargeTransportMaterial.sigma_Spm | float | required | $\mathrm{S\,m^{-1}}$ | finite and positive | reciprocal scalar charge conductivity | FEM/FDM CPU reference lanes | current_modules[].definition.materials[].material.sigma_spm |
| ChargeTransportMaterial.sigma_parallel_Spm | float-or-none | required for bounded FEM M2 | $\mathrm{S\,m^{-1}}$ | finite and positive; uniform across the bounded FEM domain | AMR/PHE conductivity parallel to magnetization | FEM CPU bounded M2; FDM M2 reference | current_modules[].definition.materials[].material.sigma_parallel_spm |
| ChargeTransportMaterial.sigma_perpendicular_Spm | float-or-none | required for bounded FEM M2 | $\mathrm{S\,m^{-1}}$ | finite and positive; uniform across the bounded FEM domain | AMR/PHE conductivity transverse to magnetization | FEM CPU bounded M2; FDM M2 reference | current_modules[].definition.materials[].material.sigma_perpendicular_spm |
| ChargeTransportMaterial.sigma_AHE_Spm | float-or-none | required for bounded FEM M2 | $\mathrm{S\,m^{-1}}$ | finite; uniform across the bounded FEM domain | anomalous-Hall coefficient | FEM CPU bounded M2; FDM M2 reference | current_modules[].definition.materials[].material.sigma_ahe_spm |
| SpinDriftDiffusion.solver | SpinSolverPolicy | required | $1$ | bounded FEM M2 requires block_gmres-compatible charge/spin linear policies and no reciprocal_nonlinear policy | spatial transport solve and residual policy | FEM CPU bounded M2; GPU rejected | spin_transport_modules[].solver |

The table is intentionally narrower than the complete physical contract:
boundaries, interfaces, spin capacitance, transient policies, torque targets,
and nonlinear reciprocal iteration parameters remain represented in ProblemIR,
but are rejected by the bounded native FEM M2 lane when their implementation
contract is not present.

The following executable Python cell is the minimal authoring-to-IR round trip
for this bounded slice. The charge policy is authored with the public block
policy; planner resolution changes the requested FDM operator to the explicit
bounded FEM operator only after all FEM scope checks pass.

```python
# %%
from fullmag.model.current_transport import (
    ChargeInsulating,
    ChargePotentialGauge,
    ChargeSolverPolicy,
    ChargeTransportMaterial,
    ChargeTransportMaterialAssignment,
    CurrentTransport,
    VoltageElectrode,
)
from fullmag.model.spin_torque import RegionRef
from fullmag.model.spin_transport import (
    SpinDriftDiffusion,
    SpinSolverPolicy,
    SpinTransportMaterial,
    SpinTransportMaterialAssignment,
    SurfaceRef,
    TransportExecution,
)

strip = RegionRef("strip")
x_min = SurfaceRef("strip", "x_min", (-1.0, 0.0, 0.0))
x_max = SurfaceRef("strip", "x_max", (1.0, 0.0, 0.0))
side_faces = tuple(
    SurfaceRef("strip", name, normal)
    for name, normal in (
        ("y_min", (0.0, -1.0, 0.0)),
        ("y_max", (0.0, 1.0, 0.0)),
        ("z_min", (0.0, 0.0, -1.0)),
        ("z_max", (0.0, 0.0, 1.0)),
    )
)

charge = CurrentTransport(
    name="charge",
    model="ohmic_poisson",
    coupling="bidirectional",
    domain=(strip,),
    materials=(
        ChargeTransportMaterialAssignment(
            region=strip,
            material=ChargeTransportMaterial(
                sigma_Spm=4.0e6,
                sigma_parallel_Spm=4.4e6,
                sigma_perpendicular_Spm=4.0e6,
                sigma_AHE_Spm=0.2e6,
            ),
        ),
    ),
    boundaries=(
        VoltageElectrode("left", (x_min,), potential_V=0.0),
        VoltageElectrode("right", (x_max,), potential_V=1.0e-3),
        ChargeInsulating("sides", side_faces),
    ),
    gauge=ChargePotentialGauge("dirichlet_reference"),
    solver=ChargeSolverPolicy(
        engine="block_gmres",
        relative_tolerance=1.0e-10,
        absolute_tolerance=0.0,
        max_iterations=500,
        operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
        physical_residual_version="transport_balance_integrated_l2.v1",
    ),
)

spin = SpinDriftDiffusion(
    id="spin",
    current_source_id="charge",
    domain=(strip,),
    materials=(
        SpinTransportMaterialAssignment(
            region=strip,
            material=SpinTransportMaterial(
                sigma_s_Spm=5.0e6,
                polarization_p=0.2,
                theta_sh=0.1,
                lambda_sf_m=2.0e-9,
            ),
        ),
    ),
    solver=SpinSolverPolicy(
        engine="gmres",
        relative_tolerance=1.0e-10,
        absolute_tolerance=0.0,
        max_iterations=500,
        operator_version="fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        default_external_boundary="spin_insulating",
    ),
    requested_execution=TransportExecution(
        discretization="fem",
        device="cpu",
        precision="double",
        execution_mode="strict",
    ),
)

charge_ir = charge.to_ir()
spin_ir = spin.to_ir(coupling=charge.coupling)
assert charge_ir["coupling"] == "bidirectional"
assert charge_ir["model"] == "magnetoresistive_poisson"
assert spin_ir["constitutive_version"] == "transport_constitutive.reciprocal.fullmag.v1"
assert spin_ir["requested_execution"]["discretization"] == "fem"
```

(problem-ir)=
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
requested/resolved lane. `ResolvedSpinTransportPlanIR` retains authored intent
in `requested_execution` and publishes the complete typed resolved tuple as
`resolved_discretization`, `resolved_device`, `resolved_precision`, and
`resolved_execution_mode`; the bounded GPU M1 lane resolves exactly to
FDM/GPU/double/strict. `validated` is workload/lane/precision/BC scoped.

(implementation-mapping)=
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

The opt-in FDM CPU native M1 path is explicit end to end:
`native_m1_v1` resolves to the C declarations in
`native/include/fullmag_fdm.h`, the dedicated warning-clean adapter translation
unit in `backends/fdm/api/cpu_transport_v1.cpp`, Rust FFI records in
`crates/fullmag-fdm-sys/src/lib.rs`, and the fail-closed runner adapter
`solve_native_m1_snapshot` in
`crates/fullmag-runner/src/fdm/cpu/native_transport.rs`. Its managed public
ProblemIR--planner--runner gate is
`crates/fullmag-runner/tests/native_m1_v1_public_e2e.rs`. It publishes complete
cell and face charge/spin fields, reaction channels, interface observations,
transport torque, and requested/resolved provenance without fallback. These
are executable contract observations only; `validated_workloads` stays empty.

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

(validation)=
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
| M2 affine constitutive oracle | exact affine `V=x`, `mu_s=(u_x,u_y,u_z)x` cube solution and projected `J_c`, `Q_ia` values |
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

The bounded FEM CPU M2 lane also has a nontrivial managed constitutive oracle,
`just verify-fem-steady-transport-m2-affine-contract`. It uses a
six-tetrahedron unit cube with Dirichlet faces at `x=0` and `x=1`, uniform
`m=e_x`, `sigma=3 S/m`, `sigma_parallel=6 S/m`, `sigma_perpendicular=4 S/m`,
`sigma_s=5 S/m`, `P=0.25`, zero SHE/AHE, and disabled spin-reaction lengths.
The exact solution is

```text
V=x,  mu_s,a=u_a x,  u=(0.2,0.3,0.4),  E_x=-1 V/m,  G_xa=-u_a/2 V/m.
```

Consequently the expected nonzero constitutive entries are

```text
J_c,x = -6 - 0.5*0.25*3*u_x A/m^2,
Q_xa = -0.5*5*u_a - 0.25*3*delta_{a,x} A/m^2,
```

with all transverse flow components zero. The managed native ABI contract
checks the nodal fields, the node-major vector/tensor projection, convergence,
and these values to `1e-8` absolute error. It then executes two additional
single-gradient affine drives: a charge-only state with $E_x=-1\,\mathrm{V/m}$
and a spin-only state with $G_{xx}=-1/2\,\mathrm{V/m}$. The measured cross
responses satisfy

```text
Q_xx(E_x)/E_x = J_x(G_xx)/G_xx
```

to `1e-8`, and both diagonal powers $E\mathbin{\cdot}J_c$ and
$G\mathbin{:}Q$ are positive. This is an executable two-drive Onsager and
dissipation oracle for the bounded FEM M2 constitutive block. It does not
close a parameter/mesh sweep, heterogeneous-material balance, FDM/FEM
reciprocal common-limit, or production qualification.

The managed FEM contract also runs the bounded reciprocal problem on three
conforming tetrahedral meshes (`N_x=8,16,32`) with finite
`lambda_sf=0.3 m`, nonzero polarization, and natural transverse boundaries.
The midpoint values were `V=(0.527052,0.526914,0.526879) V` and
`mu_{s,x}=(0.175368,0.177036,0.177449) V`; the coarse-to-fine versus
medium-to-fine errors were respectively `1.72849e-4/3.42662e-5 V` and
`2.08109e-3/4.12567e-4 V`. Both errors decrease under refinement. This is a
bounded one-dimensional-invariant FEM convergence gate, not a full 3-D
parameter sweep, an FDM/FEM common-limit, or a production qualification.

The managed runner now also executes a reciprocal FDM↔FEM common-limit fixture
with the same SI data on both discretizations: `sigma=4 S/m`,
`sigma_s=5 S/m`, `sigma_parallel=6 S/m`, `sigma_perpendicular=3 S/m`,
`P=0.25`, `theta_SH=sigma_AHE=0`, `lambda_sf=0.3 m`, `m=e_z`, and matched
charge/spin Dirichlet data on the `z` electrodes. The cell-centred FDM values
are compared with volume-consistent FEM plane averages on `N_z=8,16,32`
conforming tetrahedral meshes. The maximum potential differences are
`5.60270e-4`, `1.62324e-4`, and `4.35987e-5 V`; the maximum `mu_{s,z}`
differences are `6.72230e-3`, `1.94772e-3`, and `5.23159e-4 V`. Both
discretizations satisfy their independent residual/balance gates and the
cross-backend error decreases under refinement. This closes only the uniform,
finite-spin-flip, no-Hall reciprocal common-limit fixture; heterogeneous
materials, interfaces, GPU parity, and production qualification remain open.
A separate bounded 3-D nonzero-SHE/iSHE/AHE gate is documented below.

An executable managed BORIS N/F smoke now completes at `coarse`, `medium`, and
`fine` resolutions in the pinned CUDA image
`nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f`
with BORIS 2022 version 4 on an RTX 4080 SUPER (compute capability 8.9). The
stage marker, all N/F OVF fields, and an immutable runtime identity are present.
This is execution evidence only: the artifact deliberately remains
`qualification.status=diagnostic`. The coarse and medium meshes have no
interior cells for the residual stencil, so their zero residuals are vacuous;
the fine normal-metal spin residual is `3.7620952779e-2`, above the declared
`1e-5` tolerance (the fine ferromagnet residual is `1.0362313921e-9`). The
interface charge and spin-torque closures are retained as raw diagnostics and
are not accepted as balanced. Consequently the run does not close BORIS
convergence, N/F interface balance, or Fullmag↔BORIS parity.

#### 5.2.1 BORIS residual units and scope

The BORIS display contract is not dimensionally identical to the Fullmag field
catalog. In `Transport_Spin_Display.cpp`, the native spin accumulation is
`S [A/m]` and the displayed tensor `Js_ia` is `A/s`; the latter is an angular
momentum-current representation, not a charge-equivalent current density. The
adapter therefore uses

```text
V_s       = De S/(sigma MUB_E),
mu_s      = 2 V_s,
Q_ia      = Js_ia/MUB_E [A/m^2].
```

An independent residual must use one unit system consistently. In native BORIS
variables, a homogeneous normal-metal interior obeys

```text
R_S,a = partial_i Js_ia + De S_a/lambda_sf^2 = 0,
```

where the direct-SHE contribution is already present in `Js`. The equivalent
Fullmag form is

```text
R_Q,a = partial_i Q_ia + sigma mu_s,a/(2 lambda_sf^2) = 0.
```

Adding `partial_i Js_ia` to the Fullmag reaction term mixes `A/(m s)` and
`A/(m^3)` and introduces a spurious factor `1/MUB_E`. A residual scale must
also have divergence units (for example `max(|Js|/h, |De S|/lambda_sf^2)`),
not the current magnitude `max(|Js|)`. A validator that violates either rule
can report orders-of-magnitude false residuals even when BORIS' discrete
Poisson equation is satisfied.

The ferromagnetic BORIS equation is a separate scope: it adds transverse
exchange/dephasing terms (`l_ex`, `l_ph`) and, when enabled, magnetization-drift,
topological-Hall, or pumping sources. A normal-metal scalar residual must never
be applied to an F mesh; an N/F comparison either evaluates those terms from an
explicit material/magnetization manifest or marks the F residual unsupported.

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

(limitations)=
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
general heterogeneous FDM/FEM common-limit convergence remain unchecked work;
the bounded uniform M1/M2 fixtures are documented below.

### 7.2 FEM CPU M2 bounded reciprocal implementation evidence

The native FEM CPU lane now contains a deliberately bounded M2 realization. It
uses one monolithic conforming `H1 P1` block system for
`(V,mu_sx,mu_sy,mu_sz)` and the reciprocal constitutive tensor from section
2.2. The charge block includes the symmetric AMR/PHE tensor and AHE term;
the `P` and SHE/iSHE off-diagonal blocks are assembled together and solved by
GMRES. The C ABI is a separate symbol,
`fullmag_fem_solve_steady_transport_m2_v1`, and its request appends
`sigma_parallel`, `sigma_perpendicular`, and `sigma_AHE` after a nested,
self-describing `fullmag_fem_steady_transport_request_v1` prefix. This keeps
the M1 ABI layout stable while making the reciprocal material explicit.

The executable scope is intentionally narrower than the physical M2 contract:
CPU, FP64, `execution_mode=strict`, full-domain conforming H1/P1, one uniform
anisotropic charge tensor, one uniform spin material, a Dirichlet charge
reference, no internal spin interfaces, no mixing/SML, no reciprocal nonlinear
Picard policy, and no LLG/Oersted stage coupling. The planner rejects a missing
or non-positive Schur complement
`min(sigma_parallel,sigma_perpendicular)*sigma_s - P^2*sigma^2`, rejects
heterogeneous charge tensors in this lane, and never falls back to FDM or to
the M1 one-way solver. The native wrapper publishes the constitutive/operator
versions and reciprocal residual/balance diagnostics in provenance.

The managed evidence is split into four independent gates: the Rust ABI layout
test, the planner test
`resolves_bounded_fem_m2_to_reciprocal_descriptor_without_fallback`, the exact
runner-to-FFI materialization test, and the native runtime test
`native_m2_solver_publishes_reciprocal_diagnostics`. Together with the managed
`just verify-fem-steady-transport-native-contract` M1 regression gate they prove
an executable bounded FEM M2 slice, not a general FEM M2 qualification. No
`validated_workloads` entry is claimed: Onsager/dissipation sweeps,
heterogeneous materials, N/F/T interfaces, GPU residency, BORIS parity,
transient coupling, and production qualification remain open. A separate
managed runner gate now covers the uniform reciprocal FDM↔FEM common limit;
it is evidence for that exact fixture only and does not promote the general
capability.

The common-limit gate uses the same SI descriptor in both backends and compares
FDM cell-centred values against FEM plane-averaged values on `N_z=8,16,32`.
For `sigma=4`, `sigma_s=5`, `sigma_parallel=6`, `sigma_perpendicular=3`
S/m, `P=0.25`, `lambda_sf=0.3 m`, `m=e_z`, and zero Hall coefficients, the
maximum potential differences are `5.60270e-4`, `1.62324e-4`, and
`4.35987e-5 V`; the corresponding `mu_{s,z}` differences are `6.72230e-3`,
`1.94772e-3`, and `5.23159e-4 V`. Both independent residual/balance checks
pass and the cross-backend error decreases under refinement. This remains a
uniform, no-interface, no-Hall CPU-double reference gate.

The FDM side also has a managed heterogeneous-interface gate:
`just verify-fdm-m2-heterogeneous-interface-contract` executes the anisotropic
N/F balance fixture and the nonzero mixing-conductance fixture with separate
backflow, transverse absorption, SML, and torque accounting. Both tests pass in
the managed CUDA image (CPU-double engine lane). This demonstrates that the
FDM reference can carry explicit region IDs and oriented interface laws; it is
not FEM interface support or FDM↔FEM parity, and it does not qualify a
production N/F/T workload.

The reciprocal common-limit sweep now also has a genuinely three-dimensional
SHE/iSHE/AHE fixture, executed by
`just verify-fem-steady-transport-m2-3d-common-limit-contract`. It uses
`m=(1,0,0)`, `theta_SH=0.1`, `sigma_AHE=0.2 S/m`, the same reciprocal
conductivities and finite `lambda_sf=0.3 m` as the uniform fixture, and
insulating transverse faces. FDM and conforming tetrahedral FEM are refined
together at `(n_x,n_y,n_z)=(2,2,4),(4,4,8),(8,8,16)`. The managed run passed
with independent charge/spin residual gates and produced maximum
FDM↔FEM plane-profile differences of
`(1.14404e-4,1.93287e-2)`, `(1.59387e-4,6.51759e-3)`, and
`(5.65483e-5,1.88431e-3)` for `(V,mu_s)`; the transverse spin potential is
nonzero in every resolution. The charge cross-error is not required to be
monotone at every intermediate mixed refinement because the FVM and P1 mass
weights are different; the gate requires a lower fine-grid charge error than
both coarser runs, strictly decreasing spin error, and a fine envelope below
`1e-3 V`/`5e-2 V`. This is bounded CPU-double 3-D common-limit evidence, not
FEM interface support, GPU transport parity, BORIS parity, or a
`validated_workloads` promotion.

The native ABI contract additionally executes the affine cube oracle described
in section 5.2. It is deliberately a separate `just` target so a zero-gradient
ABI smoke cannot mask a constitutive sign or `G=-\nabla\mu_s/2` factor error.

### 7.3 Bounded public FDM GPU charge-only path

The public `CurrentTransport` path has two deliberately bounded executable
profiles. `resolve_fdm_gpu_charge_transports` lowers the Python/ProblemIR
module to a versioned `ResolvedFdmGpuChargeTransportIR` only when the request
is explicit FDM/CUDA, FP64, strict, one-way OhmicPoisson and a full rectangular
active grid. The first profile uses two opposite voltage faces, four insulating
faces and `boundary_reference_per_component`. The second uses exactly two
opposite, single-surface `NormalCurrentElectrode` faces on one axis, four
insulating faces, `zero_mean_per_free_component`, and the native-equivalent
compatibility condition obtained after assembling every exterior
$-A_fJ_{n,f}$ term into its adjacent-cell RHS. Before either profile reaches
the ABI, the planner and runner reproduce the native scalar internal-face
conductance in finite precision,
$g_a=[2/(1/\sigma_i+1/\sigma_j)]A_a/h_a$, for every adjacent cell pair. The
bounded full-grid profile is admitted only when every such $g_a$ is finite and
strictly positive. Together with the already-required full active rectangle,
this proves exactly one numerically connected component; zero, NaN, or infinite
conductance fails closed with
`charge_domain=not_single_numerically_connected_component`. The component rule
in the CUDA owner is therefore normative: the public single-component slice may
use one global assembled RHS compatibility reduction, but it does not silently
reinterpret a numerically disconnected grid as a multi-component transport
problem. The runner adapter
`execute_public_gpu_charge_only` maps both profiles to the append-only CUDA M1
charge ABI and publishes `V_electric`, `J_charge`, and a transport provenance
artifact. CPU, `auto`, unknown execution values, partial masks, PBC,
spin/SHE/STT/SOT, Oersted coupling and implicit fallback are rejected before
execution.

The managed gate `just verify-fdm-gpu-public-charge-runtime` executes the
fixture `examples/fdm_gpu_charge_public.py` on a 2 x 1 x 1 grid. An independent
oracle script checks the cell-centred affine solution
$V=(0.025,0.075)\,\mathrm{V}$ and
$J_x=-\sigma\,\partial_xV=-2.0\times10^{13}\,\mathrm{A/m^2}$ for
$\sigma=4.0\times10^6\,\mathrm{S/m}$ and a 0.1 V drop over 20 nm; the
transverse current is zero. The run completes on the identified RTX 4080
SUPER with no fallback, algebraic residual
`8.201001214742106e-21`, physical residual
`1.3810679320049756e-16`, and `iterations=2`. This is a bounded executable
reference slice with actual-device evidence, not a `validated_workloads`
entry or general production qualification.

The first managed attempt exposed an ABI indexing error: `canonical_face_index`
is local to each flux axis (`Jx`, `Jy`, `Jz`), not a globally offset index
stream. The Rust adapter now uses axis-local formulas and validates uniqueness
on `(axis, canonical_face_index)`; the regression test
`expanded_boundary_faces_use_axis_local_canonical_indices` freezes this rule.

The pure-Neumann managed gate
`just verify-fdm-gpu-public-charge-zero-mean-runtime` runs
`examples/fdm_gpu_charge_zero_mean_public.py` through the same public path.
For a $20\times10\times10\,\mathrm{nm^3}$ bar with two $10\,\mathrm{nm}$
x-cells, $\sigma=4.0\times10^6\,\mathrm{S/m}$,
$J_n(x_{\min})=+2.0\times10^{13}\,\mathrm{A/m^2}$ and
$J_n(x_{\max})=-2.0\times10^{13}\,\mathrm{A/m^2}$, the stored axis current
is $J_x=-2.0\times10^{13}\,\mathrm{A/m^2}$ because $J_n=\mathbf n\cdot
\mathbf J_c$ and $\mathbf J_c=-\sigma\nabla V$. Hence the zero-mean
cell-centre oracle in increasing x order is
$V=(-0.025,+0.025)\,\mathrm{V}$. Publiczny preflight odtwarza każdy rekord
zewnętrznej ściany pełnej siatki (łącznie
$2(n_y n_z+n_x n_z+n_x n_y)$), wymaga dokładnego pokrycia bez duplikatów oraz
sprawdza zgodność `axis`, `side`, `canonical_face_index`, `adjacent_cell` i
`area_m2=hy*hz`, `hx*hz` albo `hx*hy` z relatywną tolerancją $10^{-12}$.
Następnie planner i runner wykonują tę samą kolejność składania ownera CUDA:
dla każdej komórki i jej zewnętrznych ścian odejmują skończony termin
$A_fJ_{n,f}$ od $rhs_i$, a dopiero potem liczą
$r=\sum_i rhs_i$ i $\|rhs\|_1=\sum_i|rhs_i|$. Warunek kompatybilności brzmi
$|r|\le64\,\epsilon_{\mathrm{f64}}\|rhs\|_1$; przy zerowej skali legalne jest
wyłącznie dokładne zero. Dzięki temu przypadek $1\times1\times1$, w którym
dwie przeciwne elektrody trafiają do tej samej komórki, ma identyczną decyzję
Rust i CUDA. The verifier also requires finite,
non-negative physical, component and electrode balances below $10^{-12}$ and
provenance `gauge_policy=zero_mean_per_free_component`. This is an electrical prerequisite
for later solved-current racetrack/SHE-to-SOT/STT/Hall and current-derived
Oersted work; it does not itself enable any spin torque, Hall observable or
Oersted field.

The managed CUDA run completed with `iterations=1`, algebraic residual
`4.1150157270026995e-17`, physical residual `0.0`, component balance `0.0`,
and electrode balance `0.0`. It returned the prescribed cell-centre values
`[-0.024999999999999994, 0.024999999999999994] V` and
`[-2.0e13, 0, 0, -2.0e13, 0, 0] A/m^2`. The identified device was the RTX
4080 SUPER UUID `fcb9fbf1828437c7af5b76bcbf2d2937`, CUDA runtime `12040`,
driver `13010`, build digest
`d396670cc86f5b79b208d812b7a1aca52a73ead18ab48b6c00141dd3c558c96a`.

The remaining public charge work includes larger and masked domains,
convergence and sanitizer gates, cross-backend parity, and the complete
spin/SHE/M2/M3/FEM paths.

(source-code-index)=
## 8. Source-code index

The source map binds every executable claim in this note to a path and symbol.
These rows are implementation-specific; they do not promote a source file to
a qualified workload without the validation gates above.

| Claim | Path | Symbol | Responsibility | Evidence |
|---|---|---|---|---|
| M1 charge realization | backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_charge | FEM CPU charge assembly and solve | managed native M1 contract |
| M1 spin realization | backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_spin | FEM CPU spin assembly and solve | managed native M1 contract |
| M2 reciprocal realization | backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_reciprocal | monolithic reciprocal FEM block solve | focused managed M2 runtime test |
| M2 C ABI | native/include/fullmag_fem.h | fullmag_fem_solve_steady_transport_m2_v1 | stable request and result contract | native ABI contract |
| Planner resolution | crates/fullmag-plan/src/spin_transport.rs | resolve_m1_fem_spin_transport | bounded M1/M2 descriptor and Schur checks | planner M2 test |
| Resolved transport execution tuple | crates/fullmag-plan/src/spin_transport.rs | resolve_spin_transport_with_active_graph | complete typed requested/resolved discretization, device, precision, and execution-mode provenance | bounded FDM GPU M1 planner and serde round-trip test; unvalidated |
| Descriptor materialization | crates/fullmag-runner/src/native_fem/steady_transport/descriptor.rs | materialize_native_fem_steady_transport_request | fail-closed descriptor-to-FFI mapping | runner materialization test |
| Native dispatch | crates/fullmag-runner/src/native_fem/steady_transport.rs | solve_native_fem_steady_transport | explicit M1/M2 ABI selection and provenance | runner runtime test |
| FDM reference | crates/fullmag-runner/src/fdm/cpu/spin_transport.rs | solve_coupled_module | CPU FDM coupled charge/spin realization | FDM reference/common-limit tests |
| Native FDM M1 C ABI | native/include/fullmag_fdm.h | fullmag_fdm_cpu_charge_solve_v1; fullmag_fdm_cpu_steady_spin_solve_v1 | append-only request/result and accepted-snapshot contract | managed ABI layout and canary gate |
| Native FDM M1 ABI adapter | backends/fdm/api/cpu_transport_v1.cpp | fullmag_fdm_cpu_charge_solve_v1; fullmag_fdm_cpu_steady_spin_solve_v1 | checked record extents, owner translation, exact topology mapping, and result publication | fdm_cpu_transport_abi_v1_contract |
| Native FDM M1 Rust FFI | crates/fullmag-fdm-sys/src/lib.rs | fullmag_fdm_cpu_charge_result_v1; fullmag_fdm_cpu_steady_spin_result_v1 | byte-exact Rust records and symbol declarations | layout-manifest and compile-fail ownership tests |
| Native FDM M1 record extent guard | backends/fdm/api/cpu_transport_v1.cpp | input_records | reject overflowing public record byte extents before dereference | excessive-count pointer canaries |
| Native FDM M1 observation mapping | backends/fdm/api/cpu_transport_v1.cpp | unique_interface_observation | match each owner observation exactly once by full topology | unsorted multi-interface ABI contract |
| Native FDM M1 charge Rust symbol | crates/fullmag-fdm-sys/src/lib.rs | fullmag_fdm_cpu_charge_solve_v1 | declare the native charge solve to Rust | layout-manifest and public E2E gate |
| Native FDM M1 spin Rust symbol | crates/fullmag-fdm-sys/src/lib.rs | fullmag_fdm_cpu_steady_spin_solve_v1 | declare the native spin solve to Rust | layout-manifest and public E2E gate |
| Native FDM M1 runner adapter | crates/fullmag-runner/src/fdm/cpu/native_transport.rs | solve_native_m1_snapshot | fail-closed descriptor/result mapping and complete artifact carrier | native_m1_v1 full-result mutation tests |
| Native FDM M1 public E2E | crates/fullmag-runner/tests/native_m1_v1_public_e2e.rs | public_native_m1_v1_transparent_and_mixing_artifacts_match_reference_and_provenance | unchanged public planning/running, persistent fields, and honest provenance | opt-in managed contract; unvalidated, not production qualification |
| Native FDM M1 charge | backends/fdm/cpu/transport/charge_transport_v1.cpp | solve | matrix-free charge solve, mixing trace elimination, and immutable accepted snapshot | `just verify-fdm-cpu-m1-charge-native-contract` |
| Native FDM M1 spin | backends/fdm/cpu/transport/spin_transport_v1.cpp | solve | accepted-snapshot spin solve, mixing observations, reaction channels, and torque | `just verify-fdm-cpu-m1-spin-native-contract` |
| Native FDM M1 validation helpers | backends/fdm/cpu/transport/spin_transport_validation_v1.cpp | evaluate_local_residual_gate | cell-local FV acceptance and independently testable direct-SHE contraction | native spin contract |
| Native FDM M1 charge regression | backends/fdm/tests/cpu_charge_transport_contract.cpp | main | oriented traces, conservative current, reversed orientation, and finite-conductance validation | native charge contract |
| Native FDM M1 spin regression | backends/fdm/tests/cpu_spin_transport_contract.cpp | main | independent mixing/reaction/torque algebra, local residual rejection, and six SHE contractions | native spin contract |
| Native FDM GPU M1 spin solver | backends/fdm/gpu/cuda/transport/spin/device_solver.cu | solve_device | FP64 steady spin/direct-SHE, dynamic mixing and target-masked transport torque on the context-owned stream | managed GPU CPU-parity contract; partial and unvalidated |
| Native FDM GPU M1 LLG binding ABI | native/include/fullmag_fdm.h | fullmag_fdm_context_bind_gpu_transport_v1 | append-only 144-byte binding record and public bind/unbind entry points | C11/C++/Rust layout and actual-device ownership contract |
| Native FDM GPU M1 LLG binding | backends/fdm/gpu/cuda/transport/context.cu | context_bind_gpu_transport_rhs; context_begin_gpu_transport_step; context_commit_gpu_transport_step; context_rollback_gpu_transport_step | exclusive one-owner binding, stage trial state and accepted-step promotion/rollback | `just verify-fdm-gpu-m1-transport-llg-lifecycle-contract`; not production qualification |
| Native FDM GPU M1 torque RHS | backends/fdm/gpu/cuda/integrators/transport_rhs_fp64.cu | launch_add_gpu_transport_torque_fp64 | add Gilbert-form transport torque exactly once and pin transport storage through kernel completion | managed Heun/RK4 stage contract and compute-sanitizer |
| Rust M1 parity oracle | crates/fullmag-engine/examples/fdm_spin_oracle_v1.rs | main | nonzero mixing charge/spin fixture and public interface observations | managed Rust/native parity |
| Native M1 parity comparator | backends/fdm/tests/cpu_spin_transport_parity.cpp | main | solved-field, reaction, torque, balance, and public interface-flux comparison | managed Rust/native parity |
| Planner regression | crates/fullmag-plan/src/spin_transport.rs | resolves_bounded_fem_m2_to_reciprocal_descriptor_without_fallback | no-fallback M2 planning invariant | focused managed test |
| Runtime regression | crates/fullmag-runner/src/native_fem/steady_transport.rs | native_m2_solver_publishes_reciprocal_diagnostics | reciprocal provenance identity | focused managed test |
| ABI layout regression | crates/fullmag-fem-sys/src/lib.rs | steady_transport_m2_request_keeps_v1_as_a_nested_prefix | append-only nested M1-prefix guarantee | focused managed test |
| M2 affine constitutive oracle | backends/fem/tests/steady_transport_abi_contract.cpp | cpu_double_reciprocal_m2_affine_constitutive_oracle | nonzero-gradient signs, half-gradient convention, node-major projection, two-drive Onsager cross response, and positive dissipation | `just verify-fem-steady-transport-m2-affine-contract` |
| M2 mesh convergence oracle | backends/fem/tests/steady_transport_contract.cpp | reciprocal_m2_converges_on_three_mesh_resolutions | finite-spin-flip reciprocal FEM midpoint convergence on three conforming tetrahedral mesh resolutions | `just verify-fem-steady-transport-m2-convergence-contract` |
| M2 FDM/FEM common-limit oracle | crates/fullmag-runner/src/native_fem/steady_transport.rs | reciprocal_m2_common_si_limit_matches_fdm_and_fem_reference_profiles | compare matched reciprocal FDM cell centres with FEM plane averages over three z resolutions | `just verify-fem-steady-transport-m2-common-limit-contract` |
| FDM M2 heterogeneous-interface gate | crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs | m2_anisotropic_nf_interface_meets_the_declared_physical_balance_tolerance | exercise an anisotropic N/F region jump and a companion mixing/SML closure with explicit torque accounting | `just verify-fdm-m2-heterogeneous-interface-contract` |
| M2 3-D SHE/iSHE/AHE common-limit gate | crates/fullmag-runner/src/native_fem/steady_transport.rs | reciprocal_m2_3d_she_ishe_common_limit_matches_fdm_and_fem_profiles | compare matched 3-D reciprocal FDM/FEM plane profiles under coupled transverse refinement with nonzero SHE, iSHE, and AHE | `just verify-fem-steady-transport-m2-3d-common-limit-contract` |
| Public CurrentTransport charge planner | crates/fullmag-plan/src/current_transport.rs | resolve_fdm_gpu_charge_transports | lower the bounded Python/ProblemIR charge descriptor with fail-closed FDM/CUDA/FP64/strict constraints | public bounded path; unvalidated |
| Public FDM GPU charge runner | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | execute_public_gpu_charge_only | map the resolved descriptor to the CUDA M1 charge ABI, read back V/J, and publish provenance without fallback | `just verify-fdm-gpu-public-charge-runtime`; bounded actual-device E2E |
| Public charge fixture and analytic oracle | examples/fdm_gpu_charge_public.py; scripts/verify_fdm_gpu_public_charge_output.py | study; main | define the 2 x 1 x 1 affine voltage fixture and independently verify V/J, residuals, and provenance | managed public charge gate |
| Public charge managed recipe | justfile | verify-fdm-gpu-public-charge-runtime | compile the CUDA runtime and CLI through the container-backed managed path, run the fixture, and execute the oracle | actual RTX 4080 SUPER; unvalidated |
| `fdm-gpu-public-charge-planner`: public numerical-domain proof | crates/fullmag-plan/src/current_transport.rs | bounded_fdm_gpu_charge_has_single_numerically_connected_component | reproduce native harmonic internal conductance and reject a full grid unless every adjacent pair has finite strictly positive conductance | planner regression |
| `fdm-gpu-public-charge-runner`: public numerical-domain preflight | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | validate_single_numerically_connected_domain | repeat the native harmonic conductance proof before ABI entry and reject zero, NaN, or infinite internal conductance without a fallback | runner ABI regression |
| `fdm-gpu-public-charge-planner`: public pure-Neumann planner profile | crates/fullmag-plan/src/current_transport.rs | bounded_fdm_gpu_charge_boundary_profile | require two opposite balanced current-density faces, zero-mean gauge, and four insulating faces without relaxing the FDM/CUDA/FP64/strict scope | planner regression |
| `fdm-gpu-public-charge-runner`: public pure-Neumann boundary preflight | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | validate_boundary_faces | reconstruct and exactly cover all external FDM faces; reject noncanonical geometry, nonfinite terminal currents, unbalanced, mixed, or gauge-incompatible profiles before native execution | runner ABI regression |
| `fdm-gpu-public-charge-runner`: public CUDA ABI lifecycle | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | execute_with_abi | map the selected gauge policy to the frozen CUDA ABI and execute the bounded context/snapshot lifecycle | runner ABI regression |
| `fdm-gpu-public-charge-runner`: public fields and provenance | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | execute_public_gpu_charge_only | publish accepted V/J fields and the resolved zero-mean provenance without fallback | managed public charge gates |
| `fdm-gpu-public-zero-mean-fixture` and `fdm-gpu-public-zero-mean-verifier`: public pure-Neumann fixture and analytic oracle | examples/fdm_gpu_charge_zero_mean_public.py; scripts/verify_fdm_gpu_public_charge_zero_mean_output.py | build_study; main | define the balanced 2 x 1 x 1 current-density fixture and verify sign, gauge, balances, and provenance | managed pure-Neumann gate |
| Public pure-Neumann managed recipe | justfile | verify-fdm-gpu-public-charge-zero-mean-runtime | compile through the container-backed runtime, execute the public fixture, and run the independent oracle | managed actual-device gate |
| FDM GPU M1 contract and qualification boundary | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:fdm-gpu-m1-fp64-contract | own the bounded charge realization and keep the broader M1 qualification gates explicit | partial implementation; unvalidated |
| Frozen solved-current racetrack contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:racetrack-m1-v1-contract | freeze the synthetic fixture, equations, signs, parameter provenance, and qualification boundary | planned contract only; not implemented or qualified |
| Public racetrack Neel seed authoring | packages/fullmag-py/src/fullmag/init/textures.py | neel_skyrmion | serialize the exact public preset parameters, world mapping, and translation into current ProblemIR | public lowering and formula-sample contract test |
| Python racetrack Neel seed evaluator | packages/fullmag-py/src/fullmag/init/preset_eval.py | _skyrmion | evaluate and normalize the repository-owned analytic skyrmion formula | centre, wall, far-field, direction, and norm contract samples |
| Rust racetrack Neel seed evaluator | crates/fullmag-plan/src/magnetization_textures.rs | eval_skyrmion | evaluate the same analytic preset from typed ProblemIR | current typed fixture parser and formula source-map gate |
| FDM GPU M1 append-only ABI | backends/fdm/include/fullmag/fdm/transport/gpu_abi_v1.h | fullmag_fdm_gpu_transport_solve_charge_v1 | declare typed/versioned charge payloads, opaque handles, artifact and checkpoint records | layout/C11/Rust contract gates |
| FDM GPU M1 typed-view validation | backends/fdm/gpu/cuda/transport/context.cu | validate_host_view | reject malformed host records before static ownership transfer or publication | managed actual-device charge gates |
| FDM GPU M1 charge operator | backends/fdm/gpu/cuda/transport/charge/device_solver.cu | solve_device | assemble conservative harmonic-FV charge and execute fixed-tree FP64 CG with linear-cost geometric `2 x 2 x 2` aggregation and exact device RAP | uniform/layered/scalability actual-device gates |
| FDM GPU M1 component gauge | backends/fdm/gpu/cuda/transport/charge/device_solver.cu | label_reference_components_kernel; project_free_component_means; charge_pcg_device_amg_kernel | label conductive components, enforce Neumann compatibility, and project free components to zero mean without CPU fallback | managed actual-device proof in `fdm-gpu-m1-charge-uniform-v1` evidence; public path and scalability remain open |
| FDM GPU M1 checkpoint codec | backends/fdm/gpu/cuda/transport/charge/checkpoint_codec.cpp | build_checkpoint; parse_checkpoint | encode and decode canonical charge-only FMGPUTR1 sections 1--9/18/20 | frozen codec oracle plus runtime identity A/B gate |
| FDM GPU M1 Rust ABI mirror | crates/fullmag-fdm-sys/src/gpu_transport_abi_v1.rs | fullmag_fdm_gpu_transport_solve_charge_v1 | mirror append-only C layouts and symbols without adding a public runner | Rust layout tests |
| FDM GPU M1 uniform regression | backends/fdm/tests/gpu_m1_charge_uniform_v1_contract.cpp | main | check analytic FP64 field/current, AMG/cache audit, transfer bounds and zero fallback on a physical GPU | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 scalability regression | backends/fdm/tests/gpu_m1_charge_scalability_v1_contract.cpp | main | execute the public FP64 charge path for 1,048,576 cells, record upload/solve timings, verify exact geometric coarse size, and reject host fallback | `just verify-fdm-gpu-m1-charge-scalability-contract` |
| FDM GPU M1 layered regression | backends/fdm/tests/gpu_m1_charge_layered_v1_contract.cpp | main | compare harmonic layered conduction with analytic and independent CPU FP64 oracles | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 snapshot regression | backends/fdm/tests/gpu_m1_charge_snapshot_v1_contract.cpp | main | separate the frozen synthetic codec oracle from identity-dependent runtime export/import and prove bitwise no-resolve readback | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 boundary mutation regression | backends/fdm/tests/gpu_m1_charge_boundary_mutation_v1_contract.cpp | main | reject malformed typed records without state publication and exercise voltage/density/insulating faces | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 runtime ABI contract | docs/specs/spin-transport-runtime-contract-v1.md | DOC-ANCHOR:fdm-gpu-m1-abi-v1 | specify append-only layout, state machine, exact checkpoint grammar and fail-closed errors | normative contract with partial implementation |
| FDM GPU M1 spin-observation ABI | backends/fdm/include/fullmag/fdm/transport/gpu_abi_v1.h | fullmag_fdm_gpu_transport_solve_steady_spin_v1 | declare the steady-spin entry point and append-only typed immutable observation readback | C11 and Rust layout contracts |
| FDM GPU M1 spin operator and compact observations | backends/fdm/gpu/cuda/transport/spin/device_solver.cu | solve_device; materialize_observation_range | solve FP64 steady spin, retain per-cell reaction/torque in compact SoA, retain immutable interface identity, and reconstruct complete 288-byte records only during bounded readback | `just verify-fdm-gpu-m1-spin-native-contract`; actual-device PASS, capability remains semantic-only |
| FDM GPU M1 spin-observation parity | backends/fdm/tests/gpu_m1_spin_operator_parity_v1_contract.cpp | main | compare reconstructed typed observations with the CPU owner, including reversed orientation and exact accepted charge traces | managed actual-device CPU--GPU parity PASS |
| FDM GPU M1 sparse public dispatch | backends/fdm/tests/gpu_m1_spin_sparse_dispatch_v1_contract.cpp | main | prove 1,048,576-cell public dispatch, 512 MiB external envelope, 2 GiB total peak, persistent cache, component-sensitive digest invalidation, NaN rollback and deterministic restore | `just verify-fdm-gpu-m1-spin-native-contract`; actual-device PASS |
| FDM GPU M1 sparse performance | backends/fdm/tests/gpu_m1_spin_sparse_performance_v1_contract.cu | main | enforce the frozen absolute setup, warm-solve, transfer and whole-context memory budgets on one identified GPU | `just verify-fdm-gpu-m1-spin-sparse-performance-contract`; durable actual-device JSON PASS |

(scientific-bibliography)=
## 9. References

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
