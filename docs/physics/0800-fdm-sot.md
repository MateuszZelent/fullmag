# 0800 — Prescribed Spin-Orbit Torque (SOT) — FDM CPU

**Status:** ✅ Implemented (FDM CPU Rust)  
**Backends:** FDM CPU Rust | FDM CUDA: deferred | FEM: deferred  
**Date:** 2026-04-04

> **Normative status (2026-07-15).** This note records the historical FDM CPU
> implementation slice. The canonical sign, SI-unit, Gilbert-source, and
> source-binding contract is now `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`.
> The implemented algebraic model is **prescribed SOT**, not a solved Spin Hall
> transport capability. A solved direct/inverse SHE model is specified by
> `docs/physics/0970-spin-hall-drift-diffusion-transport.md`. Any discrepancy
> with those notes is an implementation defect to be closed in M0, not an
> alternate convention.

---

## 1. Problem statement

In heavy-metal / ferromagnet bilayer systems (e.g. Pt/CoFe, Ta/CoFeB), a charge current flowing
in the heavy metal (HM) generates a transverse spin accumulation via the Spin Hall Effect (SHE).
This spin current exerts two torques on the adjacent ferromagnet magnetisation **m**:

1. **Damping-like (DL)** torque — anti-damping, drives switching
2. **Field-like (FL)** torque — Rashba-type, acts as an effective field

---

## 2. Governing equations

### 2.1 LLGS with SOT

The Landau–Lifshitz–Gilbert–Slonczewski (LLGS) equation for the normalised magnetisation
**m** = **M** / M_s (|**m**|=1):

$$\frac{d\mathbf{m}}{dt} = -\gamma_0(\mathbf{m}\times\mathbf{H}_\text{eff}) + \alpha\left(\mathbf{m}\times\frac{d\mathbf{m}}{dt}\right) + \tau_{DL}\left(\mathbf{m}\times(\hat{\sigma}\times\mathbf{m})\right) + \tau_{FL}\left(\mathbf{m}\times\hat{\sigma}\right)$$

Note: $\mathbf{m}\times(\hat{\sigma}\times\mathbf{m}) \equiv -\mathbf{m}\times(\mathbf{m}\times\hat{\sigma})$.

### 2.2 SOT amplitudes

$$\Omega_{DL} = \frac{\gamma_e\hbar\,J_\mathrm{signed}\,\xi_{DL}}{2e\,M_s\,t_F}, \qquad \Omega_{FL} = \frac{\gamma_e\hbar\,J_\mathrm{signed}\,\xi_{FL}}{2e\,M_s\,t_F}$$

| Symbol | Description | SI units |
|--------|-------------|----------|
| $\hbar$ | reduced Planck constant | J·s |
| $J_\mathrm{signed}$ | signed conventional-current density along the declared drive axis | A/m² |
| $\xi_{DL}$ | damping-like efficiency (≈ spin Hall angle θ_SH) | dimensionless |
| $\xi_{FL}$ | field-like efficiency | dimensionless |
| $e$ | elementary charge | C |
| $\gamma_e$ | positive angular gyromagnetic factor | s⁻¹ T⁻¹ |
| $M_s$ | saturation magnetisation | A/m |
| $t_F$ | FM layer thickness | m |
| $\hat{\sigma}$ | spin polarisation unit vector | dimensionless |

For a declared drive axis $\hat{t}$ and interface normal $\hat{n}_{NF}$,
$J_\mathrm{signed}=\mathbf J_c\cdot\hat t$ and
$\hat\sigma=\operatorname{normalize}(\hat n_{NF}\times\hat t)$. Reversing
$\mathbf J_c$ reverses the signed amplitudes; it does not redefine
$\hat t$ or $\hat\sigma$.

### 2.3 Torque direction in implementation

The canonical terms below are Gilbert-source torques in `1/s`:

$$\mathbf T_{SOT,G}=\Omega_{DL}\,\mathbf m\times(\hat\sigma\times\mathbf m)+\Omega_{FL}\,\mathbf m\times\hat\sigma.$$

Before addition to explicit `dm/dt`, every backend applies
$[\mathbf T_G+\alpha\,\mathbf m\times\mathbf T_G]/(1+\alpha^2)$. A field in
`A/m` would instead require multiplication by $\gamma_0=\mu_0\gamma_e$.
Adding an `A/m` amplitude directly to `dm/dt`, or dropping the sign of current,
is dimensionally and physically invalid.

---

## 3. Assumptions and approximations

- **Uniform spin accumulation**: σ̂ is spatially uniform (prescribed).
- **No back-action**: no self-consistent spin drift-diffusion; spin current is a fixed input.
- **Single FM layer**: thickness `t_F` is a scalar, uniform across the grid.
- **No interlayer diffusion**: SOT is an interface effect modelled as a bulk torque uniform in z.
- **|m|=1 constraint**: Re-normalised after each integration step (standard micromagnetics).

---

## 4. FDM discretisation

Applied as a per-cell, cell-local torque (no spatial derivative). The cross products are
computed from the cell magnetisation at the current time step, contributing to the explicit
Euler or Heun stage of the Runge–Kutta step.

---

## 5. Python API and ProblemIR impact

New fields in `FdmPlanIR`:

```rust
pub sot_current_density: Option<f64>,   // historical scalar; M0 must preserve its sign [A/m²]
pub sot_xi_dl: Option<f64>,             // ξ_DL (damping-like efficiency)
pub sot_xi_fl: Option<f64>,             // ξ_FL (field-like efficiency, default 0)
pub sot_sigma: Option<[f64; 3]>,        // σ̂ spin polarisation direction
pub sot_thickness: Option<f64>,         // FM layer thickness t_F [m]
```

SOT is active when `sot_current_density.is_some() && sot_sigma.is_some() && sot_thickness.is_some()`.

---

## 6. Validation strategy

- **Direction**: with **m** = **x̂**, σ̂ = **ŷ**, DL torque = **m×(σ̂×m)** = **x̂×ŷ** = **ẑ** ✓
- **Direction**: the FL torque = **m×σ̂** = **x̂×ŷ** = **ẑ** ✓
- **Zero field, DL only**: magnetisation should precess and/or switch depending on α.
- **Signed-current involution**: `J_signed -> -J_signed` reverses both terms.
- **Amplitude scaling**: verify torque ∝ `J_signed`, ∝ ξ_DL/ξ_FL, ∝ 1/(M_s t_F).
- **No SOT = 0**: with zero current, dm/dt|_SOT = 0 exactly.

---

## 7. Deferred work

- CUDA GPU FDM kernel for SOT (same `combine_effective_field_*` pattern)
- FEM support
- Self-consistent spin-diffusion transport
- Per-cell efficiency tensors (anisotropic ξ_DL, ξ_FL)
- Orbital Hall Effect extension

---

## References

- Manchon & Zhang, PRB 78, 212405 (2008); PRB 79, 094422 (2009)
- Liu, Pai, Li, Tseng, Ralph & Buhrman, PRL 109, 096602 (2012)
- Garello et al., Nature Nanotech 8, 587 (2013)
- Haney, Lee, Lee, Manchon & Stiles, PRB 88, 214417 (2013)
