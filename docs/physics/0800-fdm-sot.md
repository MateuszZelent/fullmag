# 0800 — Spin-Orbit Torque (SOT) — FDM CPU

**Status:** remediation contract approved; no FDM SOT lane is validated
**Backends:** FDM CPU/CUDA single-grid are implementation targets; FEM and
multilayer are unsupported
**Date:** 2026-07-19

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

$$\tau_{DL} = \frac{\hbar\,|J_e|\,\xi_{DL}}{2e\,\mu_0\,M_s\,t_F}, \qquad \tau_{FL} = \frac{\hbar\,|J_e|\,\xi_{FL}}{2e\,\mu_0\,M_s\,t_F}$$

| Symbol | Description | SI units |
|--------|-------------|----------|
| $\hbar$ | reduced Planck constant | J·s |
| $J_e$ | charge current density in HM layer | A/m² |
| $\xi_{DL}$ | damping-like efficiency (≈ spin Hall angle θ_SH) | dimensionless |
| $\xi_{FL}$ | field-like efficiency | dimensionless |
| $e$ | elementary charge | C |
| $\mu_0$ | vacuum permeability | H/m |
| $M_s$ | saturation magnetisation | A/m |
| $t_F$ | FM layer thickness | m |
| $\hat{\sigma}$ | spin polarisation unit vector | dimensionless |

For a charge current **J** = J_e **x̂** in the HM, the spin accumulation points along **ŷ**:
$\hat{\sigma} = \hat{z} \times \hat{J}/|\hat{J}| = \hat{y}$ (convention: right-hand Spin Hall).

### 2.3 Torque direction in implementation

The public amplitudes first define equivalent fields `H_DL` and `H_FL [A/m]`.
The solver then converts them once, using the canonical
`gamma0 = mu0 |gamma| [m/(A s)]`, into a direct non-conservative torque
`tau_sot [1/s]` in the centralized LLG RHS. No `A/m` amplitude may be added
directly to `dm/dt`.

For the direct LL-form contribution:

$$\frac{d\mathbf{m}}{dt}\bigg|_{SOT} = \text{amp}\left[-\xi_{DL}\,\mathbf{m}\times(\mathbf{m}\times\hat{\sigma}) + \xi_{FL}\,\mathbf{m}\times\hat{\sigma}\right]$$

where:
$$\text{amp} = \frac{\hbar\,|J_e|}{2\,e\,\mu_0\,M_s\,t_F}$$

`amp` is an effective-field amplitude in `A/m`. The exported RHS contribution
is `gamma0 * amp` times the stated vector combination, with the documented
Gilbert-form projection applied centrally. `tau_sot` is not conservative and
therefore has no `e_sot` or `E_sot` observable.

---

## 3. Assumptions and approximations

- **Uniform spin accumulation**: σ̂ is spatially uniform (prescribed).
- **No back-action**: no self-consistent spin drift-diffusion; spin current is a fixed input.
- **Single FM layer**: thickness `t_F` is a scalar, uniform across the grid.
- **No interlayer diffusion**: SOT is an interface effect modelled as a bulk torque uniform in z.
- **|m|=1 constraint**: Re-normalised after each integration step (standard micromagnetics).

---

## 4. FDM discretisation

Applied as a per-cell, cell-local direct torque (no spatial derivative). The
central stage-time context evaluates it at every RK stage. Inactive cells must
receive exactly zero torque and remain zero after normalization.

---

## 5. Python API and ProblemIR impact

New fields in `FdmPlanIR`:

```rust
pub sot_current_density: Option<f64>,   // |Je| [A/m²]
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
- **Amplitude scaling**: verify `tau_sot` ∝ `gamma0 |Je|`, ∝ `xi_DL`, and
  ∝ `1/t_F` with an independent macrospin oracle.
- **No SOT = 0**: with zero current, dm/dt|_SOT = 0 exactly.

---

## 7. Deferred work

- CUDA FP64/FP32 parity and managed device qualification
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
