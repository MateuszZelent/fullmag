# Spin-torque signs, SI units, and prescribed SOT

- Status: active normative physics note; bounded FEM CPU/GPU stage-time implementation evidence
- Owners: Fullmag core
- Last updated: 2026-08-05
- Related ADRs: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Related specs: `docs/specs/spin-transport-runtime-contract-v1.md`
- Formula versions: `zhang_li.fullmag.v1`, `slonczewski.fullmag.v2`,
  `prescribed_sot.fullmag.v1`, `transport_absorption.fullmag.v1`

Formula, operator, realization, and engine identifiers are classified by the
normative registry in section 8.1 of the runtime contract; this note never uses
an engine identifier as a formula or operator version.

(problem-statement)=
## 1. Problem statement

Fullmag needs one backend-independent convention for current-induced torque.
Current FDM/FEM implementations and external solvers differ in current direction,
gyromagnetic units, Gilbert conversion, angular efficiency, and whether a term is
an effective field or a direct rate. Those differences can reverse a switching
direction while preserving a plausible magnitude.

This note freezes the signs, dimensions, orientations, and realizations of
Zhang–Li STT, Slonczewski STT, prescribed SOT, and torque obtained from a solved
spin-current balance. The current evidence is lane-specific: canonical
prescribed SOT has bounded executable FDM CPU/GPU evidence and bounded FEM
CPU/GPU reference realizations. In particular,
`PrescribedSpinOrbitTorque` is a local source model, not a Spin Hall
drift-diffusion solver.

## 2. Physical model

(governing-equations)=
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

#### 2.4.1 Current FEM realization boundary (2026-08-05)

The FEM CPU reference lane evaluates `prescribed_sot.fullmag.v1` directly from
the SI/Gilbert expression above. The plan carries the signed scalar current,
`xi_DL`, `xi_FL`, `t_F`, a dimensionless time envelope, normalized
`sigma_hat`, and an optional magnetic target-node mask. The native MFEM CPU
path and the Rust FEM reference use the same backend-neutral algebra; both
apply one Gilbert transform and reject malformed descriptor data before the
solve. The managed contracts compare independent SI one-step Heun oracles,
the Rust FEM reference, and the native MFEM CPU result, including `H_eff` and
the maximum RHS amplitude.

The FEM GPU lane has a bounded device-resident realization for constant,
sinusoidal, pulse, piecewise-linear, and sinc envelopes. At each RK stage the
native path evaluates the scalar envelope at `t_n+c_i dt` (or the explicit
stage-local origin in the C ABI) and forwards that scalar into the persistent
CUDA direct-torque kernel; magnetization, masks, material fields, and RHS stay
device-resident. Planner and native-runner route the canonical descriptor to
this path without a CPU fallback. Managed CPU and real CUDA tests compare a
sinusoidal two-stage Heun step against an independent SI oracle; managed FEM
CPU and real CUDA runtime tests also prove pulse-step clipping at `t_on` and
`t_off`. The common native step policy handles pulse and PWL knots for both
CPU and GPU. A managed native FEM CPU Heun contract now injects a failure after
candidate magnetization, verifies complete state rollback, and retries the same
pulse at the same event knot. This bounded result does not yet qualify GPU or
all-integrator rejected-step event bookkeeping, tabulated-artifact materialization, FP32, long trajectories, FEM
multi-grid/convergence, or FEM↔FDM continuum agreement.

The managed FEM CPU contract also rejects a candidate on the relaxation-energy
gate at the pulse `t_off` knot and verifies that the rejected attempt leaves
magnetization, accepted time, step index, and plateau history unchanged. This
is bounded CPU Heun evidence; GPU energy rejection and the remaining RK
tableaus are still unqualified.

A managed one-cell FDM versus exchange-free multi-node FEM common-limit
contract now compares the same signed descriptor, SI constants, Gilbert
damping, and constant envelope. It is a magnetization-algebra check; it does
not establish mesh or continuum equivalence.

The managed FEM lane also runs an eight-step fixed-step Heun trajectory on the
same two-tetra mesh with CPU and CUDA consuming the identical prescribed-SOT
descriptor, active-node mask, and `dt=1e-15 s`. The complete magnetization and
scalar RHS metrics agree at every accepted step. This is a bounded FEM
CPU/GPU temporal-parity result; it does not qualify FP32, adaptive rejection,
other RK tableaus, or continuum FEM↔FDM equivalence.

The same descriptor is also exercised for one fixed-step CPU/CUDA trial with
Heun, RK4, RK23, and RK45. Full magnetization and `max_rhs` agree for every
tableau; embedded RK23/RK45 may differ by one internal RHS evaluation because
of their final-refresh/FSAL accounting. This qualifies the bounded direct-SOT
stage path across the supported tableaus, not event-aware rollback or adaptive
GPU rejection.

#### 2.4.2 Stage-time envelope contract

For an explicit RK stage `i`, the source multiplier is evaluated at

```text
t_i = t_n + c_i dt,
```

with the same `t_i` used by the rest of the RHS. Constant, sinusoidal, pulse,
piecewise-linear, and sinc envelopes are evaluated in FP64 using the canonical
definitions in `TimeEnvelopeIR`; PWL endpoints are held and pulse support is
`[t_on,t_off)`. The current FEM descriptor is append-only and versioned. A
tabulated envelope remains fail-closed until its artifact is materialized into
an owned native buffer. The native FEM step wrapper now clips a trial step at
the first future pulse/PWL knot inside the requested interval, converting
stage-local knots to absolute time before the RK transaction starts. The
event search is stateless (it uses the immutable descriptor and accepted
`current_time`), so there is no mutable envelope cursor to restore. The managed
native FEM CPU Heun contract covers the failure-after-candidate boundary: the
magnetization, accepted time, and step index are restored, and a retry lands on
the same pulse knot before the next knot. This is a bounded CPU proof, not a
qualification of GPU adaptive-energy rejection or every RK integrator. The
managed runtime evidence covers pulse knots on CPU and GPU; a native contract
test covers PWL and stage-local knot conversion. The CPU energy-rejection test
does not qualify device rollback or adaptive-energy handling for every tableau.

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

(symbols-and-si-units)=
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

(assumptions-and-validity)=
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

CPU double is the algebraic oracle. CUDA now consumes the same immutable
descriptor fields—signed current, `xi_DL`, `xi_FL`, normalized polarization,
formula version, explicit thickness, Gilbert coefficients, and optional target
mask—through persistent device buffers. The target mask is owned by the GPU
state mesh-region module; an absent mask means all magnetic nodes. FP64 parity
precedes a separately bounded FP32 qualification.

The managed FEM-GPU Slonczewski realization is intentionally bounded: the CUDA
kernel and wrapper are executable and pass a one-step FP64 CPU↔GPU oracle,
target-mask, and current-reversal contract. This does not yet prove a full RK
trajectory, multi-grid convergence, cross-backend physical agreement, or
production qualification. Before this descriptor was present, a requested
`slonczewski.fullmag.v2` CUDA execution failed before native construction; it
must never reuse the legacy current norm, fixed-layer sign, or global-only
mask.
The managed FEM-GPU lane now also passes a bounded eight-step fixed-step Heun
trajectory against the FEM CPU reference for the same canonical descriptor and
target mask. The workload keeps exchange enabled because that is a prerequisite
of the device-resident GPU RK lane, while demag and external field are disabled;
the result is temporal CPU↔GPU parity for this FP64 workload, not qualification
of the full integrator family, multi-grid convergence, long-time stability,
cross-backend continuum agreement, or production status.
The same managed FEM CPU/GPU lane now has a bounded isolated current-scaling
contract. With demag and external field disabled, one fixed Heun step at
`dt=1e-15 s` is evaluated independently at `0.5x`, `1x`, and `2x` of the
signed stack-normal current (the base magnitude is `2.4e13 A/m^2`), for both
the CPU and CUDA realizations. The response is measured as the increment from
the zero-current state after projection onto the tangent plane of the initial
unit magnetization. This projection is required physically: normalization of
`m` creates a radial correction quadratic in a first-order torque, so checking
the raw radial component would falsely reject a linear current-response
contract. The bounded tolerances are `0.5%` for the `1x=2*0.5x` relation and
`1%` for the `2x=4*0.5x` relation. This is FP64 small-step evidence for signed-current
scaling in each FEM lane, not nonlinear sweep, mesh convergence, long-time
stability, demag, or production qualification.
The managed FDM-CUDA lane additionally has a bounded eight-step fixed-step
trajectory contract: after every accepted Heun step, the complete magnetization
is compared with an independently executed CPU reference prefix using the same
canonical descriptor and target mask. This is a temporal parity gate for one
small double-precision workload, not a current-scaling, grid-convergence,
FP32, FEM, or cross-backend qualification.
It also has a bounded one-step current-scaling contract in the isolated
zero-field response: with the same canonical descriptor and target mask, the
norm of the magnetization increment is checked at `0.5`, `1`, and `2` times
the signed stack-normal current. The test uses `dt=1e-15 s` so the Heun
increment is in the linear-response envelope; it is evidence for the CUDA
descriptor's `J_c\cdot n_stack` scaling, not a nonlinear large-current or
long-time qualification.
Likewise, an FDM request for `slonczewski_interface_flux.v1` fails in planning;
FDM may not replace the oriented interface functional with the homogenized
bulk `1/t_F` source.

(discrete-realization)=
### 3.2 FEM

For P1 `m`, Zhang–Li starts with an explicitly selected advective weak form,
P1 gradient, and mass projection. A consistent-mass oracle must qualify a
lumped production projection; inflow BC, tetrahedron orientation, wall
convergence, and any SUPG/CIP stabilization are versioned.

Local prescribed SOT and homogenized Slonczewski are assembled as `L2`
projections to nodal Gilbert-source RHS with local `M_s`, `alpha`, mask, and
thickness. Interface flux is a surface functional on the oriented trace.
Production CPU ownership is under `backends/fem/cpu/mfem/interactions/*`;
GPU ownership is separate hypre/libCEED-capable code. The FEM-GPU
Slonczewski descriptor is uploaded by
`gpu_state_upload_stt_target_mask` and consumed by the device kernel; the RK
wrapper forwards `J_c`, `n_stack`, `formula_version`, and the target mask
without rebuilding them from a current norm. `mfem_bridge.cpp` passes
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

(python-api)=
### 4.1 Python API surface

The canonical classes are `PrescribedSpinOrbitTorque` and
`DriftDiffusionSpinTorque`; `SpinOrbitTorque` is deprecated input-only
compatibility. The prescribed drive is a tagged union of signed scalar plus
polarization or source-bound vector plus fixed direction and normal. Existing
Zhang–Li/Slonczewski inputs gain explicit formula and realization versions.
Canonical Python export never drops signs, orientations, `t_F`, formula
versions, or source bindings.

```python
# %%
from fullmag.model.spin_torque import (
    PrescribedSpinOrbitTorque,
    RegionRef,
    SignedScalarDrive,
    SlonczewskiSTT,
)

torque = SlonczewskiSTT(
    current_density=(0.0, 0.0, 1.0e12),
    spin_polarization=(0.0, 0.0, 1.0),
    degree=0.4,
    lambda_asymmetry=1.0,
    epsilon_prime=0.0,
    free_layer_thickness_m=1.0e-9,
    id="mtj_stt",
    target=RegionRef("free_layer"),
    stack_normal=(0.0, 0.0, 1.0),
)

sot = PrescribedSpinOrbitTorque(
    name="hm_sot",
    target=RegionRef("free_layer"),
    drive=SignedScalarDrive(
        current_density_Apm2=-4.0e11,
        sigma=(0.0, 1.0, 0.0),
    ),
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5e-9,
)
```

The canonical parameter-to-ProblemIR contract is:

| Python | type | default | SI unit | validation | meaning | backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `ZhangLiSTT.id` | `str or None` | `None` | `$1$` | non-empty and required with canonical target/operator fields | stable canonical torque identity | authoring all lanes; execution remains capability-gated | `spin_torque_modules[].id` |
| `ZhangLiSTT.target` | `RegionRef or None` | `None` | `$1$` | required and resolvable for canonical v1; forbidden in legacy | magnetic region carrying the advective torque | FDM/FEM canonical intent; lane-specific qualification applies | `spin_torque_modules[].target` |
| `ZhangLiSTT.lande_g` | `float or None` | `None` | `$1$` | finite and positive; exactly `2.0` for the MuMax3-compatible operator | effective Landé factor in drift velocity | FDM/FEM canonical intent; lane-specific qualification applies | `spin_torque_modules[].lande_g` |
| `ZhangLiSTT.operator_version` | `str or None` | `None` | `$1$` | `zl_central_reference_v1` or `zl_mumax3_central_v1`; must match formula version | discrete advective-gradient identity | FDM/FEM canonical intent; no hidden operator substitution | `spin_torque_modules[].operator_version` |
| `ZhangLiSTT.formula_version` | `str` | `zhang_li.legacy_fullmag.v0` unless canonical fields are supplied | `$1$` | canonical constructor selects `zhang_li.fullmag.v1` or `zhang_li.mumax3.v1` consistently with operator | torque-law and sign-convention identity | authoring all lanes; execution remains capability-gated | `spin_torque_modules[].formula_version` |
| `SlonczewskiSTT.current_density` | `tuple[float, float, float]` | required unless `current_source` is used | `\\mathrm{A\\,m^{-2}}` | finite signed vector; `J dot n_stack` is retained | conventional charge-current density | FDM CPU/GPU and FEM CPU/GPU reference lanes | `spin_torque_modules[].current_density` |
| `SlonczewskiSTT.free_layer_thickness_m` | `float` | required for canonical thin layer | `\\mathrm m` | finite and positive; no hidden geometry fallback in v2 | homogenized free-layer thickness | FDM CPU/GPU and FEM CPU/GPU reference lanes | `spin_torque_modules[].free_layer_thickness` |
| `SlonczewskiSTT.stack_normal` | `vec3` | required for canonical v2 | `1` | finite non-zero vector normalized once at plan import | fixed-to-free stack orientation | FDM CPU/GPU and FEM CPU/GPU reference lanes | `spin_torque_modules[].stack_normal` |
| `PrescribedSpinOrbitTorque.target` | `RegionRef` | required for canonical v1 | `1` | non-empty object/region reference; must resolve to an active magnetic target | prescribed SOT target region | FDM CPU/GPU bounded reference slice; FEM CPU/GPU bounded reference slice for non-tabulated stage-time envelopes | `spin_torque_modules[].target` |
| `PrescribedSpinOrbitTorque.drive` | `SignedScalarDrive \| VectorCurrentDrive` | required; mutually exclusive drive forms | `A/m^2` or source binding | signed scalar requires finite `current_density_Apm2` and nonzero `sigma`; vector source requires nonparallel finite drive direction and interface normal | SOT current/polarization source and orientation | FDM CPU/GPU bounded reference slice for constant envelopes; FEM CPU/GPU bounded reference slice for non-tabulated stage-time envelopes | `spin_torque_modules[].drive` |
| `PrescribedSpinOrbitTorque.xi_dl` | `float` | required | `1` | finite signed damping-like efficiency | damping-like SOT efficiency | FDM CPU/GPU bounded reference slice; FEM CPU/GPU bounded reference slice for non-tabulated stage-time envelopes | `spin_torque_modules[].xi_dl` |
| `PrescribedSpinOrbitTorque.xi_fl` | `float` | `0.0` | `1` | finite signed field-like efficiency | field-like SOT efficiency | FDM CPU/GPU bounded reference slice; FEM CPU/GPU bounded reference slice for non-tabulated stage-time envelopes | `spin_torque_modules[].xi_fl` |
| `PrescribedSpinOrbitTorque.free_layer_thickness_m` | `float` | required | `m` | finite and positive; no hidden cell-thickness fallback in v1 | ferromagnetic target thickness in the SOT prefactor | FDM CPU/GPU bounded reference slice; FEM CPU/GPU bounded reference slice for non-tabulated stage-time envelopes | `spin_torque_modules[].free_layer_thickness_m` |

(problem-ir)=
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

(round-trip-and-failure-semantics)=
### 4.5 Round-trip and failure semantics

Python and UI authoring preserve the requested intent (formula, realization,
current vector, target, normal, thickness, device, precision, and execution
mode) in `ProblemIR`. The planner publishes resolved execution separately.
Missing thickness, zero normal, mismatched target-mask length, unsupported
interface flux, and unavailable device residency are validation errors; they
must not be hidden by a CPU fallback in strict GPU mode. Extended mode may
report an explicit fallback reason, but the artifact retains both requested and
resolved lanes. The same validation rejects unsupported combinations before a
native call, rather than silently changing the formula or realization.

(implementation-mapping)=
### 4.6 Implementation mapping

The FDM CPU implementation is the independent algebraic reference for its
canonical lane, while the FEM CPU implementation has an independent native
MFEM evaluator plus a Rust reference evaluator. The FDM GPU and FEM
Slonczewski/prescribed-SOT GPU paths use separate device realizations with the
same backend-neutral descriptor. No new physical state is added to `Context`;
FEM SOT runtime ownership is split between the append-only plan descriptor,
the CPU interaction state, and the GPU state's direct-torque target mask plus
one scalar stage-envelope value. The scalar is evaluated from canonical stage
time; it is not a hidden CPU torque fallback.

(validation)=
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

### 5.4 Bounded managed prescribed-SOT evidence (2026-08-04)

The FDM CUDA lane now has a bounded, executable FP64 check of the canonical
`prescribed_sot.fullmag.v1` source. The managed recipe
`just verify-fdm-prescribed-sot-native-contract` builds the native algebra and
CUDA runtime contracts, then runs
`native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available`
and
`native_fdm_prescribed_sot_has_bounded_current_scaling_when_cuda_is_available`.
Both tests pass for an eight-step fixed-step CPU-reference trajectory and an
isolated `0.5x/1x/2x` signed-current increment envelope with an explicit target
mask. This proves the current Rust-to-native descriptor, one Gilbert
conversion, mask intersection, and FP64 trajectory parity for that small
workload only. It does not prove FEM GPU execution, FP32, nonlinear current
sweeps, stage-time envelopes, direct/inverse SHE, or production qualification.
The FDM lane status is recorded independently from the FEM lane in the
capability matrix.

### 5.5 Bounded managed FEM CPU prescribed-SOT evidence (2026-08-05)

The managed recipe `just verify-fem-prescribed-sot-native-contract` builds the
MFEM/CUDA container runtime, runs the native FEM source/descriptor contract,
and executes
`native_fem_prescribed_sot_step_matches_independent_si_reference_when_mfem_stack_is_available`.
The test forces the FEM CPU device and compares, at one fixed Heun step, an
independent SI oracle against the Rust FEM reference and native MFEM CPU for
the complete magnetization, `H_eff`, and maximum RHS amplitude. The workload
also exercises a constant envelope with value `0.25`, a nontrivial field-like
coefficient, signed current in `A/m^2`, and the complete node mask path.

The same managed recipe also builds `fem_cuda_sot_contract` and runs the
CUDA interaction contract. It then executes
`native_fem_prescribed_sot_gpu_step_matches_independent_si_reference_when_mfem_stack_is_available`
on the resolved MFEM CUDA device. That one-step gate matches the independent
SI Heun oracle and the CPU reference for `m`, `H_eff`, and `max_rhs`, and
exercises target-mask and current-reversal semantics. This is bounded FEM GPU
reference evidence for the constant-envelope lane.

The same recipe also executes
`native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_cpu`
and
`native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_gpu`.
Both use the same two-stage sinusoidal envelope, evaluate it at `t_n+c_i dt`,
and compare the complete `m`, `H_eff`, and `max_rhs_amplitude` with the
independent SI Heun oracle. The native evaluator covers five non-tabulated
forms; this managed CPU/GPU oracle directly exercises the sinusoidal form.
The same managed lane now also compares an eight-step fixed-step CPU/CUDA
trajectory on one shared mesh and descriptor. It does not yet prove event
clipping/rollback across the full integrator family, tabulated artifacts,
FP32, multi-grid convergence, long-time stability, or FEM↔FDM continuum parity
and production qualification.

## 6. Completeness checklist

- [ ] Python API and canonical alias migration
- [ ] ProblemIR/plan ABI and fixtures
- [ ] Planner and scoped capability matrix
- [ ] FDM CPU double oracle
- [ ] FDM CUDA FP64 parity and FP32 qualification
- [x] FEM CPU/MFEM independent oracle (bounded one-step managed reference)
- [x] FEM GPU strict residency path (bounded non-tabulated stage-time one-step FP64 reference)
- [x] FEM stage-time descriptor and CPU/GPU SI-oracle tests
- [x] FEM event-knot clipping for pulse/PWL envelopes (bounded CPU/GPU runtime and native contract tests)
- [x] Bounded FEM CPU Heun rejected-step rollback, energy rejection, and pulse event bookkeeping
- [x] Bounded FEM CPU↔FDM prescribed-SOT common-limit (one-cell/multi-node, constant envelope)
- [x] Bounded FEM CPU↔CUDA prescribed-SOT eight-step fixed-step trajectory parity
- [x] Bounded FEM CPU↔CUDA prescribed-SOT parity for Heun/RK4/RK23/RK45
- [ ] Rejected-step rollback and event bookkeeping across GPU and all FEM integrators
- [ ] Quantities, provenance, API, UI, and export
- [ ] Managed runtime and browser validation evidence

Unchecked items are implementation work; this note alone does not satisfy them.

(limitations)=
## 7. Known limits and deferred work

Ballistic transport, first-principles MTJ tunnelling, Rashba–Edelstein torque,
spin pumping, higher-order FEM, stabilized Zhang–Li forms, and hybrid execution
need separate publications and capability gates. Spin pumping must never be a
hidden change to `alpha`.

(scientific-bibliography)=
## 8. References

1. J. C. Slonczewski, JMMM 159, L1–L7 (1996), DOI: 10.1016/0304-8853(96)00062-5.
2. L. Berger, Phys. Rev. B 54, 9353 (1996), DOI: 10.1103/PhysRevB.54.9353.
3. S. Zhang and Z. Li, Phys. Rev. Lett. 93, 127204 (2004), DOI: 10.1103/PhysRevLett.93.127204.
4. M. D. Stiles and A. Zangwill, Phys. Rev. B 66, 014407 (2002), DOI: 10.1103/PhysRevB.66.014407.
5. A. Manchon et al., Rev. Mod. Phys. 91, 035004 (2019), DOI: 10.1103/RevModPhys.91.035004.
6. T. Schrefl, `docs/papers/mic_intro.pdf` (local copy, 2016).
7. MuMax3/amumax executable references under `external_solvers/3` and `external_solvers/amumax`; used only with an explicit conversion table.

(source-code-index)=
## Source code index

| Path | Symbol | Responsibility |
|---|---|---|
| `backends/fem/cpu/mfem/interactions/stt_slonczewski.cpp` | `add_slonczewski_stt_rhs_aos` | FEM CPU canonical v2 algebraic oracle |
| `backends/fem/cpu/mfem/interactions/stt.cpp` | `initialize_stt_plan_fields` | FEM STT descriptor validation and normalization |
| `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu` | `slonczewski_stt_rhs_kernel` | FEM GPU v2 device torque kernel |
| `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu` | `fullmag_cuda_add_slonczewski_stt_rhs` | FEM GPU kernel launch wrapper |
| `backends/fem/gpu/cuda/integrators/rk/rk_slonczewski_torque.cu` | `gpu_rk_add_slonczewski_torque` | Device-RK descriptor forwarding |
| `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` | `gpu_rk_plan_device_resident` | Strict GPU readiness and target-mask gate |
| `backends/fem/gpu/cuda/state/gpu_state.cpp` | `gpu_state_upload_stt_target_mask` | Optional target-mask device ownership and transfer audit |
| `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp` | `initialize_context_gpu_state` | Bootstrap upload ordering |
| `backends/fdm/include/spin_torque.hpp` | `prescribed_sot_explicit_rhs` | Canonical prescribed-SOT Gilbert source and single explicit Gilbert conversion shared by CUDA precision lanes |
| `backends/fdm/include/context.hpp` | `sot_params_from_ctx` | Native FDM SOT descriptor normalization and signed SI prefactor |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `prescribed_sot_scales` | Independent CPU reference scales for canonical and legacy prescribed SOT |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque` | CPU reference torque evaluation with active/target mask intersection |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `prescribed_sot_torque_from_config` | Backend-neutral canonical SOT SI/Gilbert algebra shared by FDM and the Rust FEM reference |
| `backends/fdm/tests/prescribed_sot_contract.cpp` | `main` | Native algebraic canonical-SOT contract and sign/Gilbert checks |
| `backends/fdm/tests/prescribed_sot_cuda_runtime.cu` | `main` | Managed FP64/FP32 native CUDA SOT runtime contract |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available` | Managed eight-step FP64 FDM CUDA canonical-SOT trajectory parity against CPU reference prefixes |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_prescribed_sot_has_bounded_current_scaling_when_cuda_is_available` | Managed isolated FP64 `0.5x/1x/2x` signed-current and target-mask response contract |
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SlonczewskiSTT` | Public Python authoring surface |
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class ZhangLiSTT` | Public canonical Zhang–Li identity, target, operator and Landé factor |
| `crates/fullmag-authoring/src/validation.rs` | `validate_spin_torque` | SceneDocument validation and lossless canonical/legacy boundary |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx` | `buildTorque` | UI mutation payload preserving canonical Zhang–Li fields |
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class PrescribedSpinOrbitTorque` | Canonical Python SOT class preserving target, tagged drive, efficiencies, and ferromagnetic thickness |
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SignedScalarDrive` | Signed scalar current, polarization axis, and optional envelope authoring |
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class VectorCurrentDrive` | Vector current-source binding with explicit drive and interface axes |
| `packages/fullmag-py/src/fullmag/runtime/scene_document.py` | `_decode_prescribed_sot` | SceneDocument/ProblemIR decode with fail-closed canonical SOT drive validation |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_prescribed_sot_entry` | Canonical Python export of all tagged-drive SOT fields |
| `backends/fem/tests/cuda_slonczewski_contract.cpp` | `main` | Managed one-step CPU↔GPU numeric contract |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_canonical_slonczewski_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available` | Managed eight-step FP64 FDM CUDA trajectory parity against CPU reference prefixes |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_canonical_slonczewski_has_bounded_current_scaling_when_cuda_is_available` | Managed isolated 0.5×/1×/2× signed-current increment-scaling contract |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available` | Managed eight-step FP64 FEM CPU↔GPU Heun trajectory parity with canonical descriptor and target mask |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_canonical_slonczewski_has_bounded_current_scaling_when_mfem_stack_is_available` | Managed isolated FP64 0.5×/1×/2× signed-current scaling after tangential projection for FEM CPU and GPU |
| `backends/fem/cpu/mfem/interactions/sot.cpp` | `add_sot_rhs_aos` | Native FEM CPU prescribed-SOT SI/Gilbert RHS evaluator |
| `backends/fem/cpu/mfem/interactions/sot.hpp` | `initialize_sot_plan_fields` | Validate the append-only SOT descriptor, normalize the spin axis, and materialize the target mask |
| `crates/fullmag-engine/src/fem.rs` | `sot_rhs_at` | Rust FEM reference realization of the canonical SOT source and target mask |
| `backends/fem/gpu/cuda/interactions/sot/sot_kernels.cu` | `prescribed_sot_rhs_kernel` | FEM GPU device-resident canonical prescribed-SOT SI/Gilbert kernel |
| `backends/fem/gpu/cuda/integrators/rk/rk_sot_torque.cu` | `gpu_rk_add_prescribed_sot_torque` | FEM GPU direct-torque descriptor forwarding and launch validation |
| `backends/fem/cpu/mfem/interactions/sot.cpp` | `evaluate_sot_envelope` | Evaluate the canonical non-tabulated SOT envelope at an RK stage time |
| `backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.cu` | `gpu_rk_add_direct_torques` | Forward one stage-time envelope scalar into the device-resident direct-torque path |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | Resolve the FEM SOT contract and admit the bounded non-tabulated stage-time reference lane |
| `crates/fullmag-runner/src/native_fem.rs` | `pack_native_sot_envelope` | Pack the append-only SOT envelope descriptor and owned PWL points |
| `native/include/fullmag_fem.h` | `fullmag_fem_sot_envelope_desc` | Append-only ABI descriptor for stage-time prescribed-SOT envelopes |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_prescribed_sot_step_matches_independent_si_reference_when_mfem_stack_is_available` | Managed FEM CPU native/reference/oracle one-step contract |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_prescribed_sot_gpu_step_matches_independent_si_reference_when_mfem_stack_is_available` | Managed FEM GPU native/reference/oracle one-step contract for the constant-envelope lane |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_cpu` | Managed FEM CPU two-stage Heun stage-time envelope contract against an independent SI oracle |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_gpu` | Managed real-CUDA FEM GPU two-stage Heun stage-time envelope contract against the same SI oracle |
| `backends/fem/tests/cuda_sot_contract.cpp` | `main` | Managed CUDA prescribed-SOT mask, sign, SI-oracle, and CPU/GPU algebra contract |
| `native/include/fullmag_fem.h` | `fullmag_fem_backend_create` | FEM ABI entry point consuming the append-only prescribed-SOT plan descriptor |
| `crates/fullmag-fem-sys/src/lib.rs` | `fullmag_fem_backend_create` | Rust FFI declaration consuming the append-only prescribed-SOT descriptor |
| `crates/fullmag-fem-sys/src/lib.rs` | `versioned_stt_extension_is_append_only_after_legacy_plan_prefix` | ABI test proving the SOT envelope descriptor remains append-only and self-describing |
| `backends/fem/tests/stt_contract.cpp` | `main` | Module/source ownership contract |

```{math}
:label: slonczewski-canonical-gilbert
\\mathbf T_{\\mathrm{SL},G}=\\Omega_J\\left[\\epsilon(c)\\,\\mathbf m\\times(\\mathbf m\\times\\mathbf p)+\\epsilon'\\,\\mathbf m\\times\\mathbf p\\right].
```

```{math}
:label: slonczewski-explicit-v2
\\mathbf T_{\\mathrm{SL},\\mathrm{explicit}}=\\frac{\\Omega_J}{1+\\alpha^2}\\left[(\\epsilon+\\alpha\\epsilon')\\mathbf D+(\\epsilon'-\\alpha\\epsilon)\\mathbf C\\right].
```

```{math}
:label: slonczewski-signed-current
J_n=\\mathbf J_c\\cdot\\mathbf n_{\\mathrm{stack}},\\qquad \\Omega_J=\\frac{\\gamma_e\\hbar J_n}{eM_st_F}.
```

```{math}
:label: prescribed-sot-gilbert
\\Omega_{\\mathrm{DL}}=\\frac{\\gamma_e\\hbar\\xi_{\\mathrm{DL}}J_{\\mathrm{signed}}}{2eM_st_F},\\qquad
\\Omega_{\\mathrm{FL}}=\\frac{\\gamma_e\\hbar\\xi_{\\mathrm{FL}}J_{\\mathrm{signed}}}{2eM_st_F},\\qquad
\\mathbf T_{\\mathrm{SOT},G}=\\Omega_{\\mathrm{DL}}\\,\\mathbf m\\times(\\hat{\\boldsymbol\\sigma}\\times\\mathbf m)+\\Omega_{\\mathrm{FL}}\\,\\mathbf m\\times\\hat{\\boldsymbol\\sigma}.
```
