# Spin-torque signs, SI units, and prescribed SOT

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-07-15
- Related ADRs: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Related specs: `docs/specs/spin-transport-runtime-contract-v1.md`
- Formula versions: `zhang_li.fullmag.v1`, `slonczewski.fullmag.v2`,
  `prescribed_sot.fullmag.v1`, `transport_absorption.fullmag.v1`

Formula, operator, realization, and engine identifiers are classified by the
normative registry in section 8.1 of the runtime contract; this note never uses
an engine identifier as a formula or operator version.

## 1. Problem statement

Fullmag needs one backend-independent convention for current-induced torque.
Current FDM/FEM implementations and external solvers differ in current direction,
gyromagnetic units, Gilbert conversion, angular efficiency, and whether a term is
an effective field or a direct rate. Those differences can reverse a switching
direction while preserving a plausible magnitude.

This note freezes the signs, dimensions, orientations, and realizations of
Zhang–Li STT, Slonczewski STT, prescribed SOT, and torque obtained from a solved
spin-current balance. It does not claim that any lane already implements or
validates this complete contract. In particular, `PrescribedSpinOrbitTorque` is
a local source model, not a Spin Hall drift-diffusion solver.

## 2. Physical model

### 2.1 Governing equations and immutable conventions

The elementary charge symbol is the positive magnitude `e>0`. `J_c` is
conventional charge-current density; electron drift is opposite to `J_c`.
Fullmag uses positive angular gyromagnetic magnitude `gamma_e>0` and

```text
gamma0 = mu0 gamma_e.
```

`gamma_e` is in `s^-1 T^-1`, not Hz/T. A frequency in Hz requires division by
`2 pi`. Reduced magnetization is `m=M/M_s`, with `|m|=1`. The canonical Gilbert
equation is

```text
dm/dt = -gamma0 m x H_eff + alpha m x dm/dt + T_G,
W     = -gamma0 m x H_eff + T_G,
dm/dt = [W + alpha m x W]/(1+alpha^2).
```

Therefore every direct Gilbert-source torque is converted exactly once:

```text
T_explicit = [T_G + alpha m x T_G]/(1+alpha^2).
```

An implementation must tag an input as `effective_field_A_per_m`,
`gilbert_source_per_s`, or `explicit_rhs_per_s`. Mixing tags is invalid.

For an oriented interface `A -> B`, `n_AB` is a unit normal and
`J_n=J_c dot n_AB` is signed. Neither `J_n` nor a vector source may be replaced
by an absolute value or norm. Reversing the normal reverses `J_n` at fixed
`J_c`; interface orientation is provenance.

### 2.2 Zhang–Li STT

Define the signed spin-drift velocity

```text
u = (g mu_B P)/(2 e M_s) J_c                 [m/s],
0 <= P <= 1.
```

The canonical Gilbert source is

```text
v       = (u dot grad)m,
T_ZL,G  = -v + beta m x v.                   [1/s]
```

There is no undocumented `1/(1+beta^2)`. An electron-flow adapter performs
exactly one sign conversion and records it. With the tangential projection
`v_perp=v-m(m dot v)`, the explicit contribution is

```text
T_ZL,explicit = [-(1+alpha beta)v_perp
                  +(beta-alpha)m x v_perp]/(1+alpha^2).
```

Required identities are `grad(m)=0 => T=0`, `P=0 => T=0`, and
`J_c -> -J_c => T -> -T`. The legacy Fullmag/MuMax-like prefactor is preserved
only as `zhang_li.legacy_fullmag.v0`; migration may not silently change results.

### 2.3 Slonczewski CPP STT

Let `p` be a unit fixed-layer polarization and `n_stack` point from fixed to
free layer. Set `J_n=J_c dot n_stack`, `t_F>0`, `Lambda>=1`, `P in [0,1]`, and

```text
c = m dot p,
epsilon(c) = P Lambda^2 /
  [(Lambda^2+1)+(Lambda^2-1)c],
Omega_J = gamma_e hbar J_n/(e M_s t_F).       [1/s]
```

The homogenized Gilbert source is

```text
T_SL,G = Omega_J [epsilon(c) m x (m x p)
                  + epsilon_prime m x p].
```

Writing `D=m x (m x p)` and `C=m x p`, the single canonical Gilbert
conversion gives the explicit contribution

```text
T_SL,explicit = Omega_J [(epsilon(c)+alpha epsilon_prime) D
                         +(epsilon_prime-alpha epsilon(c)) C]
                         /(1+alpha^2).
```

`epsilon_prime` is independent of `epsilon(c)`: an implementation must not
factor `epsilon(c)` across the field-like term. Canonical v2 uses the exact SI
elementary charge `e=1.602176634e-19 C`; a rounded historical literal may only
remain inside an explicitly versioned legacy evaluator. The former
`slonczewski.fullmag.v1` evaluator is retained only as read-only provenance and
is rejected for new planning.

`fixed_layer_position` is only a migration input used to derive `n_stack`; it
must not multiply the current sign a second time. The efficiency denominator is
strictly positive over the admitted domain.

Two mutually exclusive realizations exist:

- `slonczewski_thin_layer_homogenized.v1`: volumetric rate above, including
  `1/t_F`;
- `slonczewski_interface_flux.v1`: oriented surface functional from absorbed
  spin flux, without an artificial `1/t_F` in the FEM weak form.

Applying both to the same target/interface is invalid.

### 2.4 Prescribed SOT

Prescribed SOT is an algebraic local source. For a vector current source the
author supplies a fixed unit drive direction `t_drive` and oriented interface
normal `n_NF` from nonmagnet/heavy metal to ferromagnet:

```text
J_signed  = J_c dot t_drive,
sigma_hat = normalize(n_NF x t_drive),
|n_NF x t_drive| > epsilon_axis.
```

Reversing `J_c` changes only `J_signed`; it does not change `t_drive` or
`sigma_hat`. Alternatively the author supplies the mutually exclusive pair
`(J_signed,sigma_hat)`. It is invalid to combine that pair with a current-source
binding.

```text
Omega_DL = gamma_e hbar xi_DL J_signed/(2 e M_s t_F),
Omega_FL = gamma_e hbar xi_FL J_signed/(2 e M_s t_F),
T_SOT,G  = Omega_DL m x (sigma_hat x m)
           + Omega_FL m x sigma_hat.          [1/s]
```

An implementation that first forms `H_SOT [A/m]` must multiply it through the
normal LLG field path by `gamma0`; it may not add a field directly to `dm/dt`.
The third possible source—polarization obtained from solved spin transport—is
not prescribed SOT and lowers to `DriftDiffusionSpinTorque`.

`SpinOrbitTorque` remains a deprecated compatibility alias. Canonical export
uses `PrescribedSpinOrbitTorque`; neither name proves capability
`transport.spin.direct_she`.

### 2.5 Torque transferred from solved spin transport

The charge-equivalent spin-current tensor is `Q_ia`, where the first index is
flow direction and the second spin polarization. Its angular-momentum flux is

```text
mathcal J^s_ia = (hbar/2e) Q_ia.              [J/m^2]
```

Spin-flip transfers angular momentum to an unresolved relaxation reservoir;
only exchange rotation `R_J` and transverse dephasing `R_phi` transfer it to
the magnetization. With `r_m^Q=R_J+R_phi [A/m^3]`,

```text
mathcal R_m = (hbar/2e) r_m^Q,                [J/m^3]
T_tr,G = -gamma_e/M_s mathcal R_m.            [1/s]
```

The minus sign is mandatory for `gamma_e>0` and LLG precession
`-gamma0 m x H`. In transient transport the full divergence cannot replace
`R_J+R_phi`, because spin accumulation stores angular momentum.

At an interface, `Q_n,in` and `Q_n,out` are evaluated with one frozen normal
orientation. Any spin-memory-loss flux `q_SML` and any other explicitly
modelled nonmagnetic reservoir flux `q_other` must be removed before forming
the flux transferred to magnetization:

```text
q_mag = Q_n,in-Q_n,out-q_SML-q_other,         [A/m^2]
T_int,G = -gamma_e hbar/(2 e M_s t_F) q_mag. [1/s]
```

The shortcut `q_mag=Q_n,in-Q_n,out` is valid only when the interface contract
proves `q_SML=0` and `q_other=0`. SML/lattice flux never contributes to the
magnetization torque. FEM may retain the `q_mag` surface functional instead of
inventing a thickness.

### 2.6 Symbols and SI units

| Symbol | Meaning | SI unit / constraint |
|---|---|---|
| `e` | positive elementary charge | C, `>0` |
| `hbar` | reduced Planck constant | J s |
| `mu0` | vacuum permeability | H/m |
| `gamma_e` | angular gyromagnetic magnitude | s^-1 T^-1, `>0` |
| `gamma0` | `mu0 gamma_e` | m A^-1 s^-1 |
| `m`, `p`, `sigma_hat` | reduced magnetization, fixed polarization, spin-polarization direction | 1; unit vectors |
| `n_AB`, `n_stack`, `n_NF`, `t_drive` | generic A-to-B normal, fixed-to-free normal, N-to-F normal, fixed drive direction | 1; unit vectors with stored orientation |
| `M_s` | saturation magnetization | A/m, `>0` on target |
| `alpha` | Gilbert damping | 1, `>=0` |
| `beta` | Zhang–Li nonadiabaticity | 1, finite |
| `P` | polarization magnitude in the torque formulas | 1, `[0,1]` |
| `Lambda` | Slonczewski asymmetry parameter | 1, `>=1` |
| `xi_DL`, `xi_FL` | prescribed damping-like and field-like efficiencies | 1, finite and signed |
| `g` | effective Landé factor used by Zhang–Li | 1, finite and `>0` |
| `mu_B` | Bohr magneton | J/T |
| `c=m dot p` | Slonczewski alignment cosine | 1, `[-1,1]` |
| `epsilon(c)` | Slonczewski angular efficiency | 1, finite with positive denominator |
| `epsilon_prime` | independent field-like Slonczewski coefficient | 1, finite; the name is not a derivative of `epsilon(c)` |
| `epsilon_axis` | minimum admissible norm for the cross-product defining a polarization axis | 1, finite and `>0`; versioned numerical validation tolerance |
| `Omega_J`, `Omega_DL`, `Omega_FL` | signed torque-frequency scales | s^-1 |
| `H_eff` | effective field | A/m |
| `J_c`, `J_n`, `J_signed` | vector, stack-normal, and drive-projected conventional current density | A/m^2; signed |
| `u` | spin-drift velocity | m/s |
| `t_F` | resolved/homogenized free-layer thickness | m, `>0` |
| `W`, `T_G`, `T_explicit`, `T_ZL,G`, `T_SL,G`, `T_SOT,G`, `T_tr,G`, `T_int,G`, `dm/dt` | magnetization rates | s^-1 |
| `v`, `v_perp` | advective derivative and its tangent projection | s^-1 |
| `Q_ia`, `Q_n,in`, `Q_n,out`, `q_mag`, `q_SML`, `q_other` | charge-equivalent spin fluxes | A/m^2 |
| `mathcal J^s` | spin angular-momentum flux | J/m^2 |
| `R_J`, `R_phi`, `r_m^Q` | charge-equivalent volumetric absorption | A/m^3 |
| `mathcal R_m` | angular-momentum transfer density | J/m^3 |

### 2.7 Assumptions, validity, and prohibited interpretations

The model assumes continuum micromagnetics, a resolved or explicitly
homogenized ferromagnetic target, and tangential torque. Zhang–Li is a diffusive
adiabatic/nonadiabatic model, Slonczewski is a CPP phenomenology or interface
flux realization, and prescribed SOT does not include spin diffusion,
backflow, spin-memory loss, inverse SHE, Rashba–Edelstein physics, or quantum
tunnelling. A zero axis, zero normal, nonpositive `M_s/t_F`, nonfinite
coefficient, conflicting realization, or unsigned source is rejected.

## 3. Numerical interpretation

### 3.1 FDM

`m`, torque, and material coefficients are cell-centred; current originates as
oriented face flux. Zhang–Li uses the advective, not conservative, operator

```text
(D_u m)_K = 1/V_K sum_f A_f (u_f dot n_Kf)(m_f-m_K),
v_perp = D_u m-m_K(m_K dot D_u m).
```

The compatibility baseline `zl_upwind_first_order_v1` selects the upwind state
and must define inflow, zero-gradient outflow, mask boundary, and PBC per axis.
The FEM/reference central oracle is `zl_central_reference_v1`. FDM additionally
exposes the explicitly external-solver-matched
`zhang_li.mumax3.v1`/`zl_mumax3_central_v1` realization: it uses
`b=P mu_B/[2 e M_s (1+beta^2)]`, a centered `(m_{i+1}-m_{i-1})/(2 Delta x)`
stencil, and MuMax3 clamped/PBC neighbours. It is FDM-only and cannot be
silently substituted for the FEM central formula. A future MUSCL/TVD operator
requires a new formula version.

The MuMax3-compatible realization is source-compatible, not a general Landé-
factor parameterization: the external kernel fixes `GAMMA0=1.7595e11` and the
direct-rate prefactor cancels that constant, leaving the literal
`mu_B/(2 e)` source factor. Consequently its canonical `lande_g` provenance
must be exactly `2.0`; a different value is rejected during Python/IR
validation rather than silently ignored. A configurable Landé factor belongs
to a separately versioned Zhang--Li realization with its own numerical oracle.

Here `V_K [m^3]` is cell volume, `A_f [m^2]` is face area, `n_Kf [1]` is
the outward unit normal of cell `K`, `u_f [m/s]` is signed face drift velocity,
`m_K,m_f [1]` are cell and reconstructed face magnetizations, and
`D_u m [1/s]` is the discrete advective derivative. These geometric weights
and orientations are part of the operator contract, not backend conventions.

Local Slonczewski and prescribed SOT are evaluated in each magnetic target
cell from signed stage current, then passed through the common Gilbert
transform. Interface-flux torque uses the same single face flux with opposite
signs in adjacent balances; it is not inserted twice as two cell sources.

CPU double is the algebraic oracle. CUDA uses the same immutable descriptor,
mask, signed current, formula version, and stage time with persistent device
buffers. FP64 parity precedes a separately bounded FP32 qualification.

Until a CUDA descriptor carries that complete canonical data, a requested
`slonczewski.fullmag.v2` CUDA execution fails before native construction. It
must not reuse the legacy current norm, fixed-layer sign, or global-only mask.
Likewise, an FDM request for `slonczewski_interface_flux.v1` fails in planning;
FDM may not replace the oriented interface functional with the homogenized
bulk `1/t_F` source.

### 3.2 FEM

For P1 `m`, Zhang–Li starts with an explicitly selected advective weak form,
P1 gradient, and mass projection. A consistent-mass oracle must qualify a
lumped production projection; inflow BC, tetrahedron orientation, wall
convergence, and any SUPG/CIP stabilization are versioned.

Local prescribed SOT and homogenized Slonczewski are assembled as `L2`
projections to nodal Gilbert-source RHS with local `M_s`, `alpha`, mask, and
thickness. Interface flux is a surface functional on the oriented trace.
Production CPU ownership is under `backends/fem/cpu/mfem/interactions/*`;
GPU ownership is separate hypre/libCEED-capable code. `mfem_bridge.cpp` passes
descriptors only. Strict GPU may not invoke a CPU torque path or claim GPU
provenance after a fallback.

### 3.3 Hybrid and stage coupling

No hybrid torque capability is validated by this note. A hybrid realization
must preserve the same rate, interface orientation, formula version, and
current revision across discretizations and must publish all transfers.
For explicit RK, every torque consumes `(m_i,J_c(t_n+c_i dt))`; rejected stages
do not commit quantities. The quantity published after an accepted step is
refreshed at the accepted state and is exactly the quantity used by the RHS at
that state.

## 4. API, IR, planner, runtime, and workspace impact

### 4.1 Python API surface

The canonical classes are `PrescribedSpinOrbitTorque` and
`DriftDiffusionSpinTorque`; `SpinOrbitTorque` is deprecated input-only
compatibility. The prescribed drive is a tagged union of signed scalar plus
polarization or source-bound vector plus fixed direction and normal. Existing
Zhang–Li/Slonczewski inputs gain explicit formula and realization versions.
Canonical Python export never drops signs, orientations, `t_F`, formula
versions, or source bindings.

### 4.2 ProblemIR representation

IR uses typed `PrescribedSotIR`, a vector of resolved torque plans, explicit
`current_convention=conventional`, `torque_form=gilbert_source`, oriented
interfaces, and source revisions. Flat `stt_*`/`sot_*` fields remain only in a
versioned legacy reader. `fixed_layer_position` deterministically migrates to
`n_stack`; legacy Zhang–Li remains `legacy_fullmag.v0` until an explicit
upgrade. Unsupported placeholder drift diffusion fails closed.

### 4.3 Planner and capability-matrix impact

Separate capabilities are `spin_torque.zhang_li`,
`spin_torque.slonczewski`, `spin_torque.prescribed_sot`, and solved-transport
torque under its transport capability. Planner validates target geometry,
axes, orientation, mutual exclusion, stage source, lane/device/precision, and
formula version. Requested and resolved execution are both retained; strict
GPU has no hidden fallback. Status may be `validated` only for named workload,
backend, precision, mesh/order, and parameter envelope.

### 4.4 Runtime, resources, artifacts, and UI

Runtime publishes aggregate `torque_stt`/`torque_sot` plus components
`torque_zhang_li`, `torque_slonczewski`, `torque_transport`, and
`torque_spin_total`, all in `1/s`. Metadata records authored/canonical class,
formula/realization, current convention, interface orientation, normalization,
stage/source revision, requested/resolved lane, and fallback reason only in
extended mode.

Control Room exposes separate Spin Torque nodes and inspectors. It shows
prescribed versus solved, signed source, axes, normal, units, formula version,
freshness, and capability scope. Apply uses the same validation as IR; export
produces canonical Python. Heavy vector fields remain data-plane resources.

## 5. Validation strategy

### 5.1 Analytical and dimensional checks

| Workload | Required result |
|---|---|
| `zl_uniform_zero_v1` | exact zero |
| `zl_linear_texture_v1` | complete symbolic vector and tangency |
| `slon_macrospin_v1` | SI scale, DL/FL basis, signed `J_n` |
| `sot_macrospin_v1` | `gamma_e`, `1/(M_s t_F)`, Gilbert conversion |
| `signed_current_involution_v1` | each current-induced torque reverses exactly |
| collinear Slonczewski | zero for `epsilon_prime=0` |
| transport absorption | volume/interface angular-momentum balance |

FP64 macrospin oracle target is `rtol<=1e-12` with scale-aware `atol`. FP32
starts at `rtol<=5e-5` and requires an explicit error budget.

### 5.2 Cross-backend and external checks

FDM CPU double and FEM CPU double independently converge to the same continuum
workloads; GPU double matches its corresponding CPU oracle before FP32 is
qualified. MuMax3/amumax comparison requires a published sign/prefactor table,
including electron-flow conversion and legacy `1/(1+beta^2)`. External solver
agreement cannot override the direct SI formula.

### 5.3 Regression and product gates

Tests cover mask boundaries, PBC x/y/z, variable `P/M_s`, orientation
involution, zero/invalid axes, normalization migration, duplicate realization
rejection, stage times for every supported RK integrator, rejected-step
rollback, quantity/RHS equality, strict-GPU no-fallback provenance, and
Python–SceneDocument–UI–canonical-Python normalized round-trip.

## 6. Completeness checklist

- [ ] Python API and canonical alias migration
- [ ] ProblemIR/plan ABI and fixtures
- [ ] Planner and scoped capability matrix
- [ ] FDM CPU double oracle
- [ ] FDM CUDA FP64 parity and FP32 qualification
- [ ] FEM CPU/MFEM independent oracle
- [ ] FEM GPU strict residency path
- [ ] Stage-consistent runtime and rollback
- [ ] Quantities, provenance, API, UI, and export
- [ ] Managed runtime and browser validation evidence

Unchecked items are implementation work; this note alone does not satisfy them.

## 7. Known limits and deferred work

Ballistic transport, first-principles MTJ tunnelling, Rashba–Edelstein torque,
spin pumping, higher-order FEM, stabilized Zhang–Li forms, and hybrid execution
need separate publications and capability gates. Spin pumping must never be a
hidden change to `alpha`.

## 8. References

1. J. C. Slonczewski, JMMM 159, L1–L7 (1996), DOI: 10.1016/0304-8853(96)00062-5.
2. L. Berger, Phys. Rev. B 54, 9353 (1996), DOI: 10.1103/PhysRevB.54.9353.
3. S. Zhang and Z. Li, Phys. Rev. Lett. 93, 127204 (2004), DOI: 10.1103/PhysRevLett.93.127204.
4. M. D. Stiles and A. Zangwill, Phys. Rev. B 66, 014407 (2002), DOI: 10.1103/PhysRevB.66.014407.
5. A. Manchon et al., Rev. Mod. Phys. 91, 035004 (2019), DOI: 10.1103/RevModPhys.91.035004.
6. T. Schrefl, `docs/papers/mic_intro.pdf` (local copy, 2016).
7. MuMax3/amumax executable references under `external_solvers/3` and `external_solvers/amumax`; used only with an explicit conversion table.
