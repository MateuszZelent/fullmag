---
title: Spin-orbit torque
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0800-fdm-sot.md
---

(public-docs-physics-interactions-sot)=
# Spin-orbit torque

Spin-orbit torque (SOT) models the transfer of angular momentum from a heavy-metal (HM)
layer to an adjacent ferromagnetic (FM) layer via the Spin Hall Effect (SHE). Like
spin-transfer torque, SOT is non-conservative and contributes a direct torque
$\boldsymbol{\tau}_{\mathrm{SOT}}$ in $\mathrm{s^{-1}}$ to the LLG right-hand side. There
is no $E_{\mathrm{SOT}}$ energy observable.

(sot-problem-statement)=
## Physical problem

A charge current $\mathbf{J}_e$ in the HM layer generates a transverse spin current via
the Spin Hall Effect. The spin accumulation at the HM/FM interface exerts two torques on
the free-layer magnetization:

1. **Damping-like (DL)** torque — anti-damping, drives deterministic switching.
2. **Field-like (FL)** torque — acts as an effective transverse field (Rashba contribution).

The spin polarisation direction $\hat{\boldsymbol{\sigma}}$ is perpendicular to both the
current flow and the interface normal. For charge current along $\hat{\mathbf{x}}$ in a
$z$-normal bilayer:
$\hat{\boldsymbol{\sigma}} = \hat{\mathbf{z}}\times\hat{\mathbf{J}}/|\hat{\mathbf{J}}| = \hat{\mathbf{y}}$.

(sot-governing-equations)=
## Governing equations

The implemented SOT direct-torque contribution is

```{math}
:label: eq-sot-torque
\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}\bigg|_{\mathrm{SOT}}
=
\mathrm{amp}\left[
  -\xi_{\mathrm{DL}}\,\mathbf{m}\times(\mathbf{m}\times\hat{\boldsymbol{\sigma}})
  +\xi_{\mathrm{FL}}\,\mathbf{m}\times\hat{\boldsymbol{\sigma}}
\right],
```

where the effective-field amplitude is

```{math}
:label: eq-sot-amplitude
\mathrm{amp}
=
\frac{\hbar\,|J_e|}{2\,e\,\mu_0\,M_s\,t_F}
```

in $\mathrm{A\,m^{-1}}$. The exported RHS contribution is $\gamma_{\mu_0}\,\mathrm{amp}$
times the stated vector combination, with the documented Gilbert-form projection applied
centrally.

The damping-like and field-like efficiencies are

```{math}
:label: eq-sot-efficiencies
\tau_{\mathrm{DL}}
=
\frac{\hbar\,|J_e|\,\xi_{\mathrm{DL}}}{2\,e\,\mu_0\,M_s\,t_F},
\qquad
\tau_{\mathrm{FL}}
=
\frac{\hbar\,|J_e|\,\xi_{\mathrm{FL}}}{2\,e\,\mu_0\,M_s\,t_F}.
```

(sot-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $J_e$ | charge current density in HM | $\mathrm{A\,m^{-2}}$ |
| $\xi_{\mathrm{DL}}$ | damping-like efficiency ($\approx$ spin Hall angle $\theta_{\mathrm{SH}}$) | $1$ |
| $\xi_{\mathrm{FL}}$ | field-like efficiency | $1$ |
| $\hat{\boldsymbol{\sigma}}$ | spin polarisation unit vector | $1$ |
| $t_F$ | ferromagnet layer thickness | $\mathrm{m}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | elementary charge | $\mathrm{C}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |

(sot-assumptions-and-validity)=
## Assumptions and validity

- **Uniform spin accumulation**: $\hat{\boldsymbol{\sigma}}$ is spatially uniform
  (prescribed, not self-consistently computed).
- **No back-action**: no self-consistent spin drift-diffusion transport.
- **Single FM layer**: thickness $t_F$ is a scalar, uniform across the grid.
- **Interface effect modelled as bulk**: the SOT torque is applied uniformly across the
  FM thickness, not as a true interface boundary condition.
- **$|\mathbf{m}|=1$ constraint**: re-normalised after each integration step.

(sot-python-api)=
## Python authoring and canonical ProblemIR

### Complete, copyable example

```python
# %% Imports
import fullmag as fm

nm = 1e-9

# %% SOT switching of a PMA nanodot
problem = fm.Problem(
    name="sot_switching",
    magnets=[
        fm.Ferromagnet(
            name="free_layer",
            geometry=fm.Box(size=(100 * nm, 100 * nm, 1 * nm)),
            material=fm.Material(name="CoFeB", Ms=1.0e6, A=15e-12, alpha=0.1),
            m0=fm.texture.uniform((0.0, 0.0, 1.0)),
        ),
    ],
    energy=[fm.Exchange(), fm.Demag()],
    spin_torques=[
        fm.SpinOrbitTorque(
            charge_current_density_a_per_m2=1e11,   # |Je| = 10^11 A/m²
            damping_like_efficiency=0.1,             # ξ_DL = 0.1 (≈ θ_SH)
            field_like_efficiency=0.0,               # no field-like torque
            spin_polarization=(0.0, 1.0, 0.0),       # σ̂ = ŷ
            ferromagnet_thickness_m=1 * nm,          # t_F = 1 nm
        ),
    ],
    study=fm.TimeEvolution(dynamics=fm.LLG()),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 1 * nm)),
    ),
)
```

### Parameter reference — SpinOrbitTorque

| Python | Type | Default | SI unit | Validation | ProblemIR |
|---|---|---|---|---|---|
| `charge_current_density_a_per_m2` | `float` or `None` | `None` | $\mathrm{A\,m^{-2}}$ | positive; mutually exclusive with `current_source` | `spin_torques[].charge_current_density_a_per_m2` |
| `current_source` | `str` or `None` | `None` | — | names a `CurrentTransport` | `spin_torques[].current_source` |
| `damping_like_efficiency` | `float` | `0.0` | $1$ | $\xi_{\mathrm{DL}}$ | `spin_torques[].damping_like_efficiency` |
| `field_like_efficiency` | `float` | `0.0` | $1$ | $\xi_{\mathrm{FL}}$ | `spin_torques[].field_like_efficiency` |
| `spin_polarization` | `tuple[float,float,float]` | `(0,0,1)` | $1$ | unit vector $\hat{\boldsymbol{\sigma}}$ | `spin_torques[].spin_polarization` |
| `ferromagnet_thickness_m` | `float` | `1e-9` | $\mathrm{m}$ | positive | `spin_torques[].ferromagnet_thickness_m` |

(sot-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU — double-precision reference

SOT is applied as a per-cell, cell-local direct torque. No spatial derivative is needed
(unlike Zhang–Li STT). The torque is evaluated at every RK stage using the stage-time
magnetization. Inactive cells receive exactly zero torque.

### FDM GPU — CUDA production

The GPU implementation uses the same mathematical form in the fused RK kernel. Both FP64
and FP32 entry points are available.

### FEM — not implemented

SOT is not implemented in the native FEM CPU or FEM GPU paths. Requesting SOT with a FEM
backend is a planner error.

(sot-validation)=
## Validation status

| Lane | Evidence | Status |
|---|---|---|
| FDM CPU | `sot_torque`, `sot_torque_add_into`, `sot_torque_add_into_soa` | Implemented; analytic sign/direction tests |
| FDM GPU | GPU kernels present | CUDA qualification not freshly captured |
| FEM CPU | — | Not implemented |
| FEM GPU | — | Not implemented |

### Validation checks

- **Direction**: with $\mathbf{m}=\hat{\mathbf{x}}$, $\hat{\boldsymbol{\sigma}}=\hat{\mathbf{y}}$:
  DL torque $\mathbf{m}\times(\hat{\boldsymbol{\sigma}}\times\mathbf{m}) = \hat{\mathbf{z}}$ ✓,
  FL torque $\mathbf{m}\times\hat{\boldsymbol{\sigma}} = \hat{\mathbf{z}}$ ✓.
- **Amplitude scaling**: $\tau_{\mathrm{SOT}} \propto |J_e|$, $\propto \xi_{\mathrm{DL}}$,
  $\propto 1/t_F$.
- **Zero current**: $|J_e|=0 \Rightarrow \tau_{\mathrm{SOT}}=0$ exactly.

(sot-limitations)=
## Known limitations

- FEM backends do not implement SOT.
- Spin polarisation is spatially uniform (no spin-diffusion coupling).
- SOT efficiency tensors (anisotropic $\xi_{\mathrm{DL}}$, $\xi_{\mathrm{FL}}$) are not
  supported.
- Orbital Hall Effect extension is deferred.
- No self-consistent transport coupling.
- CUDA device qualification is not freshly captured in current test evidence.

(sot-scientific-bibliography)=
## Scientific bibliography

1. A. Manchon and S. Zhang, "Theory of spin torque due to spin-orbit coupling," *Physical
   Review B* **79**, 094422 (2009).
   [doi:10.1103/PhysRevB.79.094422](https://doi.org/10.1103/PhysRevB.79.094422).
2. L. Liu, O. J. Lee, T. J. Gudmundsen, D. C. Ralph, and R. A. Buhrman, "Current-induced
   switching of perpendicularly magnetized magnetic layers using spin torque from the spin
   Hall effect," *Physical Review Letters* **109**, 096602 (2012).
   [doi:10.1103/PhysRevLett.109.096602](https://doi.org/10.1103/PhysRevLett.109.096602).
3. K. Garello, I. M. Miron, C. O. Avci, F. Freimuth, Y. Mokrousov, S. Blügel,
   S. Auffret, O. Boulle, G. Gaudin, and P. Gambardella, "Symmetry and magnitude of
   spin–orbit torques in ferromagnetic heterostructures," *Nature Nanotechnology* **8**,
   587 (2013). [doi:10.1038/nnano.2013.145](https://doi.org/10.1038/nnano.2013.145).
4. P. M. Haney, H.-W. Lee, K.-J. Lee, A. Manchon, and M. D. Stiles, "Current induced
   torques and interfacial spin-orbit coupling: semiclassical modeling," *Physical Review
   B* **87**, 174411 (2013).
   [doi:10.1103/PhysRevB.87.174411](https://doi.org/10.1103/PhysRevB.87.174411).

(sot-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python term | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SpinOrbitTorque` | constructor and IR | Python |
| FDM CPU SOT | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque` | allocating reference | FDM CPU |
| FDM CPU SOT (AoS) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into` | in-place AoS | FDM CPU |
| FDM CPU SOT (SoA) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into_soa` | in-place SoA | FDM CPU |
