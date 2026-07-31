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

## Backend and qualification matrix

The two executable STT families share the direct-torque contract but have different spatial
operators. FEM is intentionally marked unsupported: the planner rejects STT requests on that
lane and does not silently fall back to FDM.

| Solver | Device | Slonczewski STT | Zhang–Li STT | Evidence boundary |
|---|---|---|---|---|
| FDM | CPU | implemented/reference | implemented/reference | Native `f64` direct-torque path and analytic/unit tests. |
| FDM | GPU | implemented | implemented | CUDA fused RK path exists; executed-device parity is a separate qualification claim. |
| FEM | CPU | unsupported | unsupported | Planner rejects both families on the FEM lane. |
| FEM | GPU | unsupported | unsupported | Planner rejects both families on the FEM lane; no CPU fallback is implied. |

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
| $\mathbf{v}$ | convective derivative $(\mathbf{u}\cdot\nabla)\mathbf{m}$ | $\mathrm{s^{-1}}$ |
| $\mathbf{v}_{\perp}$ | adiabatic projected derivative $-\mathbf{m}\times(\mathbf{m}\times\mathbf{v})$ | $\mathrm{s^{-1}}$ |
| $\mathbf{u}$ | Zhang–Li drift velocity | $\mathrm{m\,s^{-1}}$ |
| $\sigma_0$ | Slonczewski torque amplitude before angular efficiency | $\mathrm{s^{-1}}$ |
| $g$ | Slonczewski angular efficiency | $1$ |
| $\theta$ | angle between $\mathbf{m}$ and $\hat{\mathbf{p}}$ | $1$ |

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

### Public workflow boundary: stages versus torque modules

The public `StudyBuilder` currently exposes the ordered execution pipeline but has no method for
registering `SlonczewskiSTT` or `ZhangLiSTT`. The following is therefore a valid stage workflow
with an explicit limitation: it proves stage authoring, not execution of a connected STT graph.
The complete torque examples below are intentionally labelled low-level `fm.Problem` snapshots
for canonical lowering and `ProblemIR` inspection.

```python
# %% Valid stage pipeline; STT registration is not exposed by StudyBuilder yet
import fullmag as fm

nm = 1.0e-9
study = fm.study("stt-stage-boundary")
study.engine("fdm")
study.exchange()
study.cell(2.0 * nm, 2.0 * nm, 2.0 * nm)
body = study.geometry(fm.Box(100 * nm, 60 * nm, 5 * nm), name="free_layer")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.01
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

Do not add a disconnected torque object to this example and call it an executable STT run. The
missing builder registration is a current API boundary and is recorded as such below.

### Low-level snapshot: Slonczewski STT

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
    study=fm.TimeEvolution(
        dynamics=fm.LLG(),
        outputs=[fm.SaveField("m", every=1.0e-12)],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 2 * nm)),
    ),
)
```

### Low-level snapshot: Zhang–Li STT

```python
# %% Zhang-Li STT for domain-wall track
import fullmag as fm

nm = 1.0e-9

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
    study=fm.TimeEvolution(
        dynamics=fm.LLG(),
        outputs=[fm.SaveField("m", every=1.0e-12)],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 1 * nm)),
    ),
)
```

### Exhaustive parameter reference — SlonczewskiSTT

| Python parameter | Type | Default | SI unit | Validation domain | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `SlonczewskiSTT.current_density` | `Sequence[float] or None` | `None` | $\mathrm{A\,m^{-2}}$ | finite length-3 vector; mutually exclusive with `current_source` | CPP charge-current-density vector | FDM CPU/GPU when supplied directly; FEM rejected | `spin_torque_modules[].current_density` |
| `SlonczewskiSTT.current_source` | `str or None` | `None` | $1$ | non-empty name; mutually exclusive with `current_density` | named `CurrentTransport` binding | FDM when the source resolves; FEM rejected | `spin_torque_modules[].current_source` |
| `SlonczewskiSTT.spin_polarization` | `Sequence[float]` | `(0.0, 0.0, 1.0)` | $1$ | finite length-3 physical unit vector | fixed-layer polarization direction $\hat{\mathbf p}$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].spin_polarization` |
| `SlonczewskiSTT.degree` | `float` | `0.4` | $1$ | finite and $0 < P \leq 1$ | spin-polarization efficiency $P$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].degree` |
| `SlonczewskiSTT.lambda_asymmetry` | `float` | `1.0` | $1$ | finite and $\Lambda \geq 1$ | angular asymmetry parameter $\Lambda$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].lambda_asymmetry` |
| `SlonczewskiSTT.epsilon_prime` | `float` | `0.0` | $1$ | finite field-like coefficient | secondary field-like STT coefficient $\varepsilon'$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].epsilon_prime` |
| `SlonczewskiSTT.free_layer_thickness_m` | `float or None` | `None` | $\mathrm{m}$ | `None` uses current-flow cell size; otherwise finite and $>0$ | free-layer thickness $d$ in the prefactor | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].free_layer_thickness_m` |
| `SlonczewskiSTT.fixed_layer_position` | `str` | `"top"` | $1$ | `top` or `bottom` after normalization | stack-order sign convention for current | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].fixed_layer_position` |

### Exhaustive parameter reference — ZhangLiSTT

| Python parameter | Type | Default | SI unit | Validation domain | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `ZhangLiSTT.current_density` | `Sequence[float] or None` | `None` | $\mathrm{A\,m^{-2}}$ | finite length-3 vector; mutually exclusive with `current_source` | CIP charge-current-density vector $\mathbf J$ | FDM CPU/GPU when supplied directly; FEM rejected | `spin_torque_modules[].current_density` |
| `ZhangLiSTT.current_source` | `str or None` | `None` | $1$ | non-empty name; mutually exclusive with `current_density` | named `CurrentTransport` binding | FDM when the source resolves; FEM rejected | `spin_torque_modules[].current_source` |
| `ZhangLiSTT.degree` | `float` | `0.4` | $1$ | finite and $0 < P \leq 1$ | conduction-electron spin polarization $P$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].degree` |
| `ZhangLiSTT.beta` | `float` | `0.0` | $1$ | finite and $\beta \geq 0$ | non-adiabaticity coefficient $\beta$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].beta` |
| `ZhangLiSTT.xi` | `float or None` | `None` | $1$ | finite when supplied; conflicting non-zero `beta` is rejected | compatibility alias normalized to $\beta$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].beta` |

(stt-problem-ir)=
## Python-to-`ProblemIR` representation

The canonical module list preserves the selected model and its binding. A Slonczewski module
lowers to:

```json
{
  "kind": "slonczewski",
  "current_density": [0.0, 0.0, 1.0e10],
  "spin_polarization": [1.0, 0.0, 0.0],
  "degree": 0.4,
  "lambda_asymmetry": 1.0,
  "epsilon_prime": 0.0,
  "fixed_layer_position": "top"
}
```

A Zhang–Li module lowers to the same `spin_torque_modules` collection with `kind=zhang_li`,
`current_density`, `degree`, and `beta`. The `xi` spelling is normalized to `beta` and is not
retained as a second independent physical parameter. The legacy runner fields (`stt_degree`,
`stt_beta`, `stt_lambda`, and related fields) are derived from one canonical module; they are not
an alternate source of truth.

Requested intent contains the authored model, values, current binding, and stack convention.
Resolved execution adds the planner lane, resolved current source, current sign, effective layer
thickness, precision, boundary policy, and runtime/device provenance.

(stt-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical script export preserves Slonczewski versus Zhang–Li model identity and does not turn a
direct torque into an energy term. Validation errors include missing or conflicting current
bindings, non-finite vectors, invalid degree or asymmetry, non-positive thickness, invalid layer
position, conflicting `beta`/`xi`, unknown current sources, and malformed `ProblemIR` modules.

Unsupported combinations include more than one executable spin-torque module, either STT family
on FEM CPU/GPU, semantic-only `InterfaceCppSTT` or `DriftDiffusionSpinTorque`, and an unresolved
`CurrentTransport` source. These are planner/runtime errors, not silent removal or CPU fallback.

No STT energy is serialized: the torque is non-conservative and contributes directly to the LLG
right-hand side.

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

### FEM CPU

STT is not implemented in the native FEM CPU path. Requesting either STT family with a FEM CPU
backend is a planner error; the runtime does not lower it to a field or direct-torque operator.

### FEM GPU

STT is not implemented in the native FEM GPU path. Requesting either STT family with a FEM GPU
backend is a planner error; CUDA source presence for other direct-torque families does not imply
an STT implementation or a CPU fallback.

(stt-implementation-mapping)=
## Implementation mapping

| Layer | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SlonczewskiSTT` | CPP module validation and IR | Python |
| Python API | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class ZhangLiSTT` | CIP module validation, `xi` alias, and IR | Python |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_spin_torque_modules` | binding, range, and module-cardinality validation | IR |
| planner | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_legacy_spin_torque` | current-source resolution and FEM rejection | FDM/FEM planning |
| planner | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` | adjacent SOT resolver; not used by STT equations | FDM planning |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_stt_torque_add_into_soa` | zero-allocation CPP direct torque | FDM CPU |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_stt_torque_add_into_soa` | zero-allocation CIP derivative torque | FDM CPU |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_slonczewski_scales` | Gilbert projection coefficients | FDM CPU |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_zhang_li_scales` | Gilbert projection coefficients | FDM CPU |
| FDM GPU | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | fused direct-torque branch | FDM GPU |
| FDM GPU | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | fused direct-torque branch | FDM GPU |

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
| Python binding validation | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `_resolve_current_binding` | exclusive current-density/source binding | Python |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_spin_torque_modules` | module binding and range validation | IR |
| planner resolution | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_legacy_spin_torque` | current-source resolution and FEM rejection | planner |
| FDM CPU Slonczewski | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_stt_torque_add_into_soa` | direct torque (SoA) | FDM CPU |
| FDM CPU Zhang–Li | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_stt_torque_add_into_soa` | direct torque (SoA) | FDM CPU |
| FDM CPU Slonczewski (AoS) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_stt_torque_add_into` | direct torque (AoS) | FDM CPU |
| FDM CPU Zhang–Li (AoS) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_stt_torque_add_into` | direct torque (AoS) | FDM CPU |
| Gilbert scales (Slonczewski) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_slonczewski_scales` | prefactor | FDM CPU |
| Gilbert scales (Zhang–Li) | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_zhang_li_scales` | prefactor | FDM CPU |
| Slonczewski sign test | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_direct_torque_matches_effective_field_form` | validation | test |
| Zhang–Li projection test | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_direct_torque_uses_gilbert_alpha_beta_projection` | validation | test |
| FDM GPU FP64 | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | fused direct-torque branch | FDM GPU |
| FDM GPU FP32 | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | fused direct-torque branch | FDM GPU |
