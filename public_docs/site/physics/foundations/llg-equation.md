---
title: Landau–Lifshitz–Gilbert equation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/llg_conventions.md
---

(public-docs-physics-foundations-llg-equation)=
# Landau–Lifshitz–Gilbert equation

The Landau–Lifshitz–Gilbert (LLG) equation is the equation of motion for the reduced
magnetization $\mathbf{m}=\mathbf{M}/M_s$ in micromagnetics. FullMag uses the explicit
Gilbert form for all solver backends.

## Governing equation

The implemented LLG right-hand side is

```{math}
:label: eq-llg-full
\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}
=
-\frac{\gamma_{\mu_0}}{1+\alpha^2}
\left[
  \mathbf{m}\times\mathbf{H}_{\mathrm{eff}}
  + \alpha\,\mathbf{m}\times\left(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}\right)
\right]
+ \boldsymbol{\tau}_{\mathrm{direct}},
```

where:

- $\gamma_{\mu_0} = \mu_0|\gamma_e| \approx 2.211\times10^{5}\;\mathrm{m\,(A\,s)^{-1}}$
  is the reduced gyromagnetic constant (see {doc}`conventions-and-units`),
- $\alpha \geq 0$ is the dimensionless Gilbert damping parameter,
- $\mathbf{H}_{\mathrm{eff}}$ is the total effective field in $\mathrm{A\,m^{-1}}$
  (see {doc}`effective-field`),
- $\boldsymbol{\tau}_{\mathrm{direct}}$ is the sum of all direct-torque contributions
  (STT, SOT) in $\mathrm{s^{-1}}$.

## Precessional and damping terms

Eq. {eq}`eq-llg-full` contains two distinct physical effects:

1. **Precessional torque**: $-\gamma_{\mu_0}\,\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}$
   causes Larmor precession of the magnetization around the effective field.

2. **Damping torque**: $-\gamma_{\mu_0}\alpha\,\mathbf{m}\times(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}})$
   drives relaxation toward alignment with the effective field.

For $\alpha \ll 1$, precession dominates. For $\alpha \gg 1$, the magnetization relaxes
with minimal precession. The $1/(1+\alpha^2)$ prefactor in the explicit Gilbert form ensures
correct damping rate regardless of $\alpha$.

## Relaxation mode (overdamped LLG)

FullMag exposes a pure-damping relaxation mode that disables the precessional term:

```{math}
:label: eq-llg-relaxation
\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}\bigg|_{\mathrm{relax}}
=
-\frac{\gamma_{\mu_0}\alpha}{1+\alpha^2}
\,\mathbf{m}\times\left(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}\right)
+ \boldsymbol{\tau}_{\mathrm{direct}}.
```

This mode is selected by the runtime field `precession_enabled = false`. It converges
monotonically to the nearest energy minimum without oscillatory transients. Runtime
provenance logs expose the resolved mode as `llg_mode = precessional` or
`llg_mode = pure_damping`.

## Magnetization normalization

The LLG equation preserves $|\mathbf{m}|=1$ analytically, but explicit time integrators
introduce a numerical drift. FullMag re-normalises the magnetization on every magnetic
degree of freedom after each accepted integration step:

```{math}
:label: eq-normalization
\mathbf{m}_i \leftarrow \frac{\mathbf{m}_i}{|\mathbf{m}_i|}
\quad\text{for all magnetic } i.
```

Non-magnetic nodes (FEM airbox, visualisation padding) are **not** normalised and must not
contribute to the magnetic RHS.

## Time integration

FullMag integrates the LLG equation with explicit Runge–Kutta methods:

| Integrator | Stages | Order | Adaptive | Current status |
|---|---:|---:|---|---|
| Heun | 2 | 2 | No | Baseline for all backends |
| RK4(5) Dormand–Prince | 7 | 4(5) | Yes | Production FDM GPU |
| RK2(3) Bogacki–Shampine | 4 | 2(3) | Yes | Available |

Adaptive timestep control uses the embedded error estimate with user-specified `max_err`
(absolute maximum node/cell embedded vector error). A failed adaptive attempt at the minimum
timestep `dt_min` returns a typed error and cannot be accepted.

Fixed-step mode (`fix_dt`) selects a true fixed physical timestep and cannot be combined
with adaptive parameters.

## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\mathbf{H}_{\mathrm{eff}}$ | effective field | $\mathrm{A\,m^{-1}}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\boldsymbol{\tau}_{\mathrm{direct}}$ | direct torque | $\mathrm{s^{-1}}$ |
| $\Delta t$ | integration timestep | $\mathrm{s}$ |

## Implementation mapping

| Responsibility | Source identity |
|---|---|
| FEM CPU LLG RHS | `backends/fem/cpu/mfem/integrators/llg_rhs.cpp` — `compute_llg_rhs` |
| FDM CPU LLG stepping | `crates/fullmag-engine/src/fdm/cpu/integrator.rs` |
| FDM GPU Heun/RK stages | `backends/fdm/gpu/cuda/runtime/` — RK stage kernels |
| Magnetization normalization | Per-backend post-step normalization routines |
| Relaxation mode flag | `precession_enabled` in native FEM ABI |

## Scientific bibliography

1. L. D. Landau and E. M. Lifshitz, "On the theory of the dispersion of magnetic
   permeability in ferromagnetic bodies," *Phys. Z. Sowjetunion* **8**, 153 (1935).
2. T. L. Gilbert, "A phenomenological theory of damping in ferromagnetic materials,"
   *IEEE Trans. Magn.* **40**(6), 3443 (2004).
   [doi:10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
3. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
4. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376,
   National Institute of Standards and Technology, 1999.
   [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).
