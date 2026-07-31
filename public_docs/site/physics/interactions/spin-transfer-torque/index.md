---
title: Spin-transfer torque
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/stt_sign_conventions.md
---

(public-docs-physics-interactions-stt)=
# Spin-transfer torque

Spin-transfer torque (STT) is a non-conservative interaction: it cannot be derived from an
energy functional and therefore does not contribute an effective field to
$\mathbf{H}_{\mathrm{eff}}$. Instead, STT adds a direct torque
$\boldsymbol{\tau}_{\mathrm{STT}}$ in $\mathrm{s^{-1}}$ to the LLG right-hand side.

FullMag implements two executable STT models and one semantic placeholder:

1. **Slonczewski STT** — current-perpendicular-to-plane (CPP) geometry, for magnetic tunnel
   junctions and nanopillars.
2. **Zhang–Li STT** — current-in-plane (CIP) geometry, for domain-wall motion in nanowires.
3. **InterfaceCppSTT** — semantic placeholder for interface-local CPP torque in multilayer
   stacks (not yet executable).

(stt-problem-statement)=
## Physical problem

A spin-polarised charge current exerts a torque on the local magnetization through the
exchange interaction between conduction electron spins and the local magnetic moment. The
torque has two components:

- **Damping-like (in-plane)** torque — drives the magnetization toward or away from the
  polarisation direction, responsible for current-induced switching.
- **Field-like (out-of-plane)** torque — acts as an effective transverse field, modifying
  the precession frequency.

(stt-governing-equations)=
## Governing equations

### Slonczewski torque (CPP)

For a magnetic tunnel junction or nanopillar with fixed-layer polarisation $\hat{\mathbf{p}}$,
free-layer thickness $d$, and charge current density $J$ flowing perpendicular to the
layers, the Slonczewski torque is

```{math}
:label: eq-stt-slonczewski-torque
\boldsymbol{\tau}_{\mathrm{Slonc}}
=
\frac{\mathrm{sgn}(J)\,\sigma_0}{1+\alpha^2}
\left[
  (1+\alpha\varepsilon')\,
  \mathbf{m}\times(\mathbf{m}\times\hat{\mathbf{p}})
  +(\varepsilon'-\alpha)\,
  \mathbf{m}\times\hat{\mathbf{p}}
\right],
```

where the Slonczewski amplitude is

```{math}
:label: eq-stt-slonczewski-prefactor
\sigma_0
=
\frac{\hbar\,|J|\,\gamma_{\mu_0}\,P}{2\,e\,\mu_0\,M_s\,d}
\,g(\mathbf{m}\cdot\hat{\mathbf{p}}).
```

The angular-dependent efficiency $g$ for Slonczewski asymmetry parameter $\Lambda$ is

```{math}
:label: eq-stt-slonczewski-g
g(\cos\theta)
=
\frac{1}{\Lambda^2+1+(\Lambda^2-1)\cos\theta}.
```

For $\Lambda=1$, $g=1/2$ (no angular asymmetry).

### Zhang–Li torque (CIP)

For a current density $\mathbf{J}$ flowing in the plane of the magnetic layer, the Zhang–Li
torque is

```{math}
:label: eq-stt-zhang-li-torque
\boldsymbol{\tau}_{\mathrm{ZL}}
=
\frac{1}{1+\alpha^2}
\left[
  (1+\alpha\beta)\,\mathbf{v}_\perp
  -(\beta-\alpha)\,\mathbf{m}\times\mathbf{v}
\right],
```

where

```{math}
:label: eq-stt-zhang-li-v
\mathbf{v}
=
(\mathbf{u}\cdot\nabla)\mathbf{m},
\qquad
\mathbf{v}_\perp
=
-\mathbf{m}\times(\mathbf{m}\times\mathbf{v}),
```

and the drift velocity is

```{math}
:label: eq-stt-zhang-li-u
\mathbf{u}
=
\frac{\mathbf{J}\,P\,\mu_B}{e\,M_s(1+\beta^2)}.
```

The first term is the adiabatic torque (drives domain-wall motion); the second is the
non-adiabatic torque proportional to $\beta$.

(stt-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\hat{\mathbf{p}}$ | fixed-layer polarisation direction | $1$ |
| $J$ | charge current density | $\mathrm{A\,m^{-2}}$ |
| $\mathbf{J}$ | current density vector (CIP) | $\mathrm{A\,m^{-2}}$ |
| $P$ | spin polarisation efficiency | $1$ |
| $\Lambda$ | Slonczewski asymmetry parameter | $1$ |
| $\varepsilon'$ | field-like (secondary) STT coefficient | $1$ |
| $\beta$ | non-adiabaticity parameter | $1$ |
| $d$ | free-layer thickness | $\mathrm{m}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | elementary charge | $\mathrm{C}$ |
| $\mu_B$ | Bohr magneton | $\mathrm{J\,T^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\boldsymbol{\tau}_{\mathrm{STT}}$ | STT direct torque | $\mathrm{s^{-1}}$ |

(stt-assumptions-and-validity)=
## Assumptions and validity

- Both models assume $|\mathbf{m}|=1$ (standard micromagnetic saturation).
- The Slonczewski model assumes a single fixed layer with uniform polarisation. No
  self-consistent spin accumulation is computed.
- Zhang–Li uses central finite differences for $(\mathbf{u}\cdot\nabla)\mathbf{m}$ on
  the FDM grid.
- Both models are spatially uniform in the current density — no self-consistent transport.
- The current density can also be supplied by a named `CurrentTransport` source for
  source-bound excitation.
- STT is non-conservative: there is no $E_{\mathrm{STT}}$ energy observable.
- The $1/(1+\alpha^2)$ prefactor arises from the explicit Gilbert-form conversion of
  the Slonczewski / Zhang–Li torques.

(stt-python-api)=
## Python authoring and canonical ProblemIR

### Slonczewski STT example

```python
# %% Imports
import fullmag as fm

nm = 1e-9

# %% Slonczewski STT for MTJ nanopillar
problem = fm.Problem(
    name="mtj_switching",
    magnets=[
        fm.Ferromagnet(
            name="free_layer",
            geometry=fm.Box(size=(100 * nm, 100 * nm, 2 * nm)),
            material=fm.Material(name="CoFeB", Ms=1.2e6, A=15e-12, alpha=0.01),
            m0=fm.texture.uniform((1.0, 0.0, 0.0)),
        ),
    ],
    energy=[fm.Exchange(), fm.Demag()],
    spin_torques=[
        fm.SlonczewskiSTT(
            current_density=(0, 0, 1e10),      # J = 10^10 A/m², along +z
            spin_polarization=(1.0, 0.0, 0.0), # fixed layer along +x
            degree=0.4,                         # P = 0.4
            lambda_asymmetry=1.0,               # Λ = 1 (symmetric)
            epsilon_prime=0.0,                   # no field-like STT
            fixed_layer_position="top",          # electrons flow upward
        ),
    ],
    study=fm.TimeEvolution(dynamics=fm.LLG()),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 2 * nm)),
    ),
)
```

### Zhang–Li STT example

```python
# %% Zhang-Li STT for domain-wall track
problem = fm.Problem(
    name="dw_track",
    magnets=[
        fm.Ferromagnet(
            name="wire",
            geometry=fm.Box(size=(1000 * nm, 60 * nm, 5 * nm)),
            material=fm.Material(name="Permalloy", Ms=800e3, A=13e-12, alpha=0.01),
            m0=fm.texture.uniform((1.0, 0.0, 0.0)),
        ),
    ],
    energy=[fm.Exchange(), fm.Demag()],
    spin_torques=[
        fm.ZhangLiSTT(
            current_density=(5e11, 0, 0),   # J along +x
            degree=0.4,                     # P = 0.4
            beta=0.02,                      # non-adiabaticity
        ),
    ],
    study=fm.TimeEvolution(dynamics=fm.LLG()),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 1 * nm)),
    ),
)
```

### Parameter reference — SlonczewskiSTT

| Python | Type | Default | SI unit | Validation | ProblemIR |
|---|---|---|---|---|---|
| `current_density` | `tuple[float,float,float]` or `None` | `None` | $\mathrm{A\,m^{-2}}$ | mutually exclusive with `current_source` | `spin_torques[].current_density` |
| `current_source` | `str` or `None` | `None` | — | names a `CurrentTransport` | `spin_torques[].current_source` |
| `spin_polarization` | `tuple[float,float,float]` | `(0,0,1)` | $1$ | unit vector of fixed layer | `spin_torques[].spin_polarization` |
| `degree` | `float` | `0.4` | $1$ | $0 < P \leq 1$ | `spin_torques[].degree` |
| `lambda_asymmetry` | `float` | `1.0` | $1$ | $\Lambda \geq 1$ | `spin_torques[].lambda_asymmetry` |
| `epsilon_prime` | `float` | `0.0` | $1$ | field-like coefficient | `spin_torques[].epsilon_prime` |
| `free_layer_thickness_m` | `float` or `None` | `None` | $\mathrm{m}$ | positive; `None` → cell size fallback | `spin_torques[].free_layer_thickness_m` |
| `fixed_layer_position` | `str` | `"top"` | — | `"top"` or `"bottom"` | `spin_torques[].fixed_layer_position` |

### Parameter reference — ZhangLiSTT

| Python | Type | Default | SI unit | Validation | ProblemIR |
|---|---|---|---|---|---|
| `current_density` | `tuple[float,float,float]` or `None` | `None` | $\mathrm{A\,m^{-2}}$ | mutually exclusive with `current_source` | `spin_torques[].current_density` |
| `current_source` | `str` or `None` | `None` | — | names a `CurrentTransport` | `spin_torques[].current_source` |
| `degree` | `float` | `0.4` | $1$ | $0 < P \leq 1$ | `spin_torques[].degree` |
| `beta` | `float` | `0.0` | $1$ | $\beta \geq 0$ | `spin_torques[].beta` |

(stt-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU — double-precision reference

Both Slonczewski and Zhang–Li torques are implemented as per-cell direct-torque
contributions. The Slonczewski torque uses the Gilbert-projected form of
Eq. {eq}`eq-stt-slonczewski-torque`. The Zhang–Li torque computes the gradient
$(\mathbf{u}\cdot\nabla)\mathbf{m}$ via six-neighbour central differences with the same
open/periodic boundary policy as exchange.

The persistent SoA runtime path (`_add_into_soa`) and the allocating AoS path (`_add_into`)
produce matching results. Both are `f64`.

### FDM GPU — CUDA production

STT is applied as a stage-time direct torque in the fused RK kernel. The CUDA kernels use
the same mathematical form as the CPU reference. FP64 and FP32 variants are available.

### FEM — not implemented

STT is not implemented in the native FEM CPU or FEM GPU paths. Requesting STT with a FEM
backend is a planner error.

(stt-validation)=
## Validation status

| Lane | Evidence | Status |
|---|---|---|
| FDM CPU | `slonczewski_direct_torque_matches_effective_field_form`, `zhang_li_direct_torque_uses_gilbert_alpha_beta_projection` | Analytic sign/magnitude tests pass |
| FDM GPU FP64 | Parity with CPU reference | Device-capable; current device run not captured |
| FDM GPU FP32 | FP64–FP32 parity | Device-capable; current device run not captured |
| FEM CPU | — | Not implemented |
| FEM GPU | — | Not implemented |

(stt-limitations)=
## Known limitations

- FEM backends do not implement STT.
- Only one spin-torque module at a time is currently executable on the production path.
- `InterfaceCppSTT` and `DriftDiffusionSpinTorque` are semantic placeholders only.
- Self-consistent spin transport (spin accumulation, spin diffusion) is not implemented.
- Current density is spatially uniform unless sourced from a `CurrentTransport` module.
- The `fixed_layer_position` sign convention follows amumax.

(stt-scientific-bibliography)=
## Scientific bibliography

1. J. C. Slonczewski, "Current-driven excitation of magnetic multilayers," *Journal of
   Magnetism and Magnetic Materials* **159**, L1 (1996).
   [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).
2. S. Zhang and Z. Li, "Roles of nonequilibrium conduction electrons on the magnetization
   dynamics of ferromagnets," *Physical Review Letters* **93**, 127204 (2004).
   [doi:10.1103/PhysRevLett.93.127204](https://doi.org/10.1103/PhysRevLett.93.127204).
3. A. Dussaux, B. Georges, J. Grollier, V. Cros, A. V. Khvalkovskiy, A. Fukushima,
   M. Konoto, H. Kubota, K. Yakushiji, S. Yuasa, K. A. Zvezdin, K. Ando, and A. Fert,
   "Large microwave generation from current-driven magnetic vortex oscillators in magnetic
   tunnel junctions," *Nature Communications* **1**, 8 (2010).
   [doi:10.1038/ncomms1006](https://doi.org/10.1038/ncomms1006).

(stt-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python term (Slonczewski) | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SlonczewskiSTT` | constructor and IR | Python |
| Python term (Zhang–Li) | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class ZhangLiSTT` | constructor and IR | Python |
| FDM CPU Slonczewski | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_stt_torque_add_into_soa` | direct torque (SoA) | FDM CPU |
| FDM CPU Zhang–Li | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_stt_torque_add_into_soa` | direct torque (SoA) | FDM CPU |
| FDM CPU Slonczewski (AoS) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_stt_torque_add_into` | direct torque (AoS) | FDM CPU |
| FDM CPU Zhang–Li (AoS) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_stt_torque_add_into` | direct torque (AoS) | FDM CPU |
| Gilbert scales (Slonczewski) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_slonczewski_scales` | prefactor | FDM CPU |
| Gilbert scales (Zhang–Li) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_zhang_li_scales` | prefactor | FDM CPU |
| Slonczewski sign test | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_direct_torque_matches_effective_field_form` | validation | test |
| Zhang–Li projection test | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_direct_torque_uses_gilbert_alpha_beta_projection` | validation | test |
