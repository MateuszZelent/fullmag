---
title: Frequency-driven solver - COMSOL-aligned physics contract
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# COMSOL-aligned physics contract

Every backend must solve the same physics.

The sole normative operator and unit dictionary is
[`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).
This document summarizes that dictionary; it does not define an alternative
sign, unit, damping, linewidth, or observable convention.

## 1. Canonical ansatz and equation

```text
m(r,t) = m0(r) + Re(delta_m(r) exp(+i omega t))
delta_m << m0
m0 · delta_m = 0
H_eff(r,t) = h_eff0(r) + Re(delta_h_eff(r) exp(+i omega t))
gamma0 = mu0 * abs(gamma)
```

All effective fields and drive phasors are in `A/m`. Here `gamma` is the
gyromagnetic ratio magnitude in `rad/(s T)` and `gamma0` is the coefficient for
`A/m` fields, in `rad s^-1 per (A/m)`.

Linearized LLG:

```text
i omega delta_m
  = - gamma0 [m0 x delta_h_eff[delta_m] + delta_m x h_eff0]
    + i omega alpha m0 x delta_m
    + tau_lin[delta_m]
```

The canonical phase convention is:

```text
exp_plus_i_omega_t
```

## 2. Public and internal unknowns

Public physical unknown:

```text
delta_m_i = (dmX_i, dmY_i, dmZ_i) in C^3
m0_i · delta_m_i = 0
```

Internal tangent unknown:

```text
T_i = [e1_i, e2_i]
q_i = (u_i, v_i) in C^2
delta_m_i = T_i q_i
```

Public artifacts must expose Cartesian fields. Tangent `u/v` is provenance or internal debug data.

## 3. Dynamic drive

Default user drive is a dynamic external field phasor:

```text
delta_h in C^3, unit A/m
```

No user-supplied sinusoid belongs in the value. The solver attaches `exp(+i omega t)`.

Canonical projection into RHS:

```text
b_cart = - gamma0 (m0 x delta_h)
b_tangent = T^T b_cart
```

This sign follows from moving the external-drive term to the RHS of the canonical equation. It must be locked by macrospin and dense Cartesian sign tests.

## 4. DriveKind

```cpp
enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};
```

Rules:

```text
dynamic_field_phasor_a_per_m: public COMSOL-style drive.
tangent_rhs: low-level solver/benchmark/debug input.
cartesian_torque_phasor: physical torque-source input.
stt_current_phasor: current/STT source.
coupled_external_provider: source from another physics subsystem.
```

## 5. Zero-drive policy

```text
FrequencyResponse + physical drive_kind + zero drive:
    valid zero response + warning.

SolverBenchmark + tangent_rhs + require_nonzero_rhs=true:
    validation_error.

Eigenfrequency/modal:
    no drive required.
```

## 6. Static linearization state

Frequency-domain solve must use a consistent static state:

```text
|m0| = 1
m0 x h_eff0 approximately 0
```

The equilibrium may be nonuniform and metastable. It still must carry diagnostics:

```text
max_m0_norm_error
max_relative_torque_residual
max_m0_cross_heff0_relative
energy trend acceptance
```

## 7. Effective fields

Static:

```text
h_eff0 = h_exchange0
       + h_anisotropy0
       + h_external0
       + h_DMI0
       + h_demag0
       + h_custom0
```

Dynamic:

```text
delta_h_eff[delta_m] = delta_h_exchange[delta_m]
                         + delta_h_anisotropy[delta_m]
                         + delta_h_DMI[delta_m]
                         + delta_h_demag[delta_m]
                         + delta_h_custom[delta_m]
delta_h_total = delta_h_eff[delta_m] + delta_h_drive
```

Linearized non-field torques belong to `tau_lin[delta_m]`; the external field
drive appears once, in the canonical RHS.

Fields are in `A/m` unless a source explicitly declares otherwise with conversion provenance.

## 8. Modal, driven, and internal real-split contract

The canonical modal and driven equations are:

```text
L q = lambda B q
lambda = i omega
(i omega B - L) q = b
b = T^T[-gamma0 (m0 x delta_h_drive)]
```

`B` denotes the damping-aware `B_alpha` of note 0831. In the physical
energy-Hessian form, `L=K` and `B=-G` for `alpha=0`, so the modal equation is
`K phi = -i omega G phi`.

For the general complex driven operator,

```text
D(omega) = i omega B - L = D_R + i D_I
[ D_R  -D_I ] [q_R] = [b_R]
[ D_I   D_R ] [q_I]   [b_I]
```

The special case `[K,+omega*M;-omega*M,K]` is permitted only after the
implementation explicitly maps `K=-L` and `M=B`. The real split is an algebraic
representation, not a second physics convention.

For `lambda=lambda_r+i lambda_i`, `omega=-i lambda`. The positive undamped
branch has `lambda_i>0`, and
`frequency_hz=Re(omega)/(2*pi)=lambda_i/(2*pi)`. A requested angular-frequency
target maps to `sigma=i*omega_target`. A real PETSc/SLEPc build must encode that
complex target through the explicit real-split transformed pencil; passing a
real `EPSSetTarget(omega_target)` is forbidden unless a separately named
real-frequency pencil and its mapping have been derived.

## 9. Damping, linewidth, and absorbed power

For the canonical phasor convention:

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0 for decay
damping_rate_hz = Gamma/(2*pi)
linewidth_fwhm_hz = Gamma/pi
```

The absorbed-power observable is the convention frozen by
[note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md)
and summarized with its SI derivation in
[note 0700](../../../physics/0700-frequency-domain-linearized-llg.md):

```text
p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)
observable = absorbed_by_magnetization
```

`delta_m` is dimensionless, so `Ms` is required. Positive Gilbert damping must
produce positive absorbed power near resonance.

## 10. DMI status

```text
DMI volume operator: production only after Cartesian/tangent tests.
DMI frequency-domain boundary terms: experimental/unsupported unless separately certified.
Only one DMI kind may be active at once.
```

## 11. Minimal result JSON

```json
{
  "physics_contract": "micromagnetics_frequency_domain_v5",
  "phasor_convention": "exp_plus_i_omega_t",
  "unknown_physics_representation": "cartesian3_complex_constrained",
  "unknown_internal_representation": "tangent2_complex",
  "constraint": "m0_dot_delta_m_zero",
  "drive_kind": "dynamic_field_phasor_a_per_m",
  "effective_field_units": "A_per_m",
  "operator_dictionary": "FrequencyOperatorDictionary.v1",
  "eigenvalue_mapping": "lambda=i*omega",
  "absorbed_power_observable": "absorbed_by_magnetization",
  "time_reconstruction": "m(t)=m0+Re(delta_m*exp(+i*omega*t))"
}
```
