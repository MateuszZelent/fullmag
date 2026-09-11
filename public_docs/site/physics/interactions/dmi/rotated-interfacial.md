---
title: Rotated interfacial Dzyaloshinskii–Moriya interaction
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0406-rotated-interfacial-dmi.md
---

(public-docs-physics-interactions-dmi-rotated-interfacial)=
# Rotated interfacial Dzyaloshinskii–Moriya interaction

Rotated interfacial DMI (rDMI) is the symmetry-specific interaction used by the
Göbel *et al.* in-plane bimeron model. It is a separate physical term in Fullmag,
not an alias for conventional interfacial DMI or bulk DMI.

(rotated-interfacial-dmi-problem-statement)=
## Physical problem

A bimeron is a pair of merons embedded in an in-plane magnetized background. It
is topologically equivalent to a skyrmion after a global spin-space rotation, but
the stabilizing DMI operator must be rotated with the spin texture. The existing
`fm.texture.bimeron` preset only creates the initial magnetization; stability is
decided by the energy, effective field, boundary law, and time evolution.

(rotated-interfacial-dmi-governing-equations)=
## Governing equations

For reduced magnetization $\mathbf m=(m_x,m_y,m_z)^\mathsf T$, a constant signed
coefficient $D$, and magnetic domain $\Omega_m$, Fullmag uses

```{math}
:label: eq-rotated-interfacial-dmi-energy
E_{\mathrm{rDMI}}=\int_{\Omega_m}D\left(
m_z\partial_xm_x-m_x\partial_xm_z+
m_x\partial_ym_y-m_y\partial_ym_x\right)\,\mathrm dV.
```

This is $D(L_{zx}^{x}+L_{xy}^{y})$. The sign of $D$ selects the preferred
chirality and is never replaced with its absolute value. With Fullmag's
$\mathbf H_\mathrm{eff}=-(\mu_0M_s)^{-1}\delta E/\delta\mathbf m$ convention,

```{math}
:label: eq-rotated-interfacial-dmi-field
\mathbf H_{\mathrm{rDMI}}=\frac{2D}{\mu_0M_s}
\left(\partial_xm_z-\partial_ym_y,\;\partial_ym_x,\;-\partial_xm_x\right)^\mathsf T.
```

The FEM weak form uses the complete first variation,

```{math}
:label: eq-rotated-interfacial-dmi-first-variation
\delta E_{\mathrm{rDMI}}[\mathbf m;\mathbf v]
=\int_{\Omega_m}D\left[
v_z\partial_xm_x+m_z\partial_xv_x-v_x\partial_xm_z-m_x\partial_xv_z
+v_x\partial_ym_y+m_x\partial_yv_y-v_y\partial_ym_x-m_y\partial_yv_x
\right]\,\mathrm dV.
```

Combined with exchange, an open magnetic surface with outward normal
$\mathbf n=(n_x,n_y,n_z)^\mathsf T$ obeys

```{math}
:label: eq-rotated-interfacial-dmi-natural-boundary
2A\partial_n\mathbf m+D(n_xm_z-n_ym_y,\;n_ym_x,\;-n_xm_x)^\mathsf T=\mathbf0.
```

Periodic faces do not receive the open-surface correction. A material-mask edge
is an open magnetic surface; the non-magnetic airbox contributes neither rDMI
field nor rDMI energy.

(rotated-interfacial-dmi-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $E_{\mathrm{rDMI}}$ | total rotated interfacial DMI energy | $\mathrm{J}$ |
| $D$ | signed rotated interfacial DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $m_x,m_y,m_z$ | Cartesian components of $\mathbf m$ | $1$ |
| $\mathbf v$ | admissible variation or FEM test field | $1$ |
| $\partial_i$ | derivative with respect to coordinate $i$ | $\mathrm{m^{-1}}$ |
| $\mathbf H_{\mathrm{rDMI}}$ | interaction effective field | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\mathbf n$ | outward magnetic-boundary normal | $1$ |
| $\partial_n$ | derivative along $\mathbf n$ | $\mathrm{m^{-1}}$ |
| $L_{ij}^{k}$ | Lifshitz invariant $m_i\partial_km_j-m_j\partial_km_i$ | $\mathrm{m^{-1}}$ |
| $\mathbf g_a$ | assembled FEM energy derivative at node $a$ | $\mathrm{J}$ |
| $M_a^{\mathrm{lump}}$ | lumped nodal integration weight | $\mathrm{m^3}$ |

(rotated-interfacial-dmi-assumptions-and-validity)=
## Assumptions and validity

- The v1 public term accepts one spatially constant scalar $D$ per problem.
- The operator differentiates in $x$ and $y$, but film thickness remains part of
  the volume integral.
- Open boundaries require positive exchange stiffness so that exchange and rDMI
  use the coupled natural boundary law.
- A finite $D$ is required; positive, negative, and zero values are valid.
- Spatially varying or tensor-valued DMI, atomistic frustration, temperature,
  and spin-orbit torque are separate models.

(rotated-interfacial-dmi-python-api)=
## Python API and stage-first example

The public constructor is `fm.RotatedInterfacialDMI(D=...)`. `D` is required,
has SI unit $\mathrm{J\,m^{-2}}$, and must be finite.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR mapping |
|---|---|---|---|---|---|---|---|
| `RotatedInterfacialDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite; positive, negative, and zero values are accepted | rDMI strength and chirality | FDM/FEM CPU/GPU subject to lane-specific scientific qualification | `energy_terms[].D` |

```python
# %% Study and strict CUDA FDM lane
import fullmag as fm

study = fm.study("goebel_2019_bimeron_fdm")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.cell(0.5e-9, 0.5e-9, 0.5e-9)
study.pbc(x=True, demag="truncated_images")

# %% Thin film and implemented bimeron initial texture
film = study.geometry(
    fm.Box(size=(500e-9, 40e-9, 0.5e-9), name="film"),
    name="film",
)
film.Ms = 0.58e6
film.Aex = 15e-12
film.alpha = 0.3
film.Ku1 = 0.8e6
film.anisU = (1.0, 0.0, 0.0)
film.m = fm.texture.bimeron(
    radius=10e-9,
    wall_width=3e-9,
    vorticity=-1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
)

# %% Rotated DMI, relaxation, and zero-current hold
study.terms.add(fm.RotatedInterfacialDMI(D=3e-3))
study.demag(realization="auto")
study.solver(fix_dt=2.5e-15, integrator="rk45")
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt=2.5e-15,
    max_steps=8_000,
    max_physical_time_s=20e-12,
    tolT=1e-6,
)
study.stages.add_run(stage_id="hold", until=120e-12)
```

(rotated-interfacial-dmi-problem-ir)=
## ProblemIR

The constructor lowers without conversion to another DMI variant:

```json
{
  "kind": "rotated_interfacial_dmi",
  "D": 0.003
}
```

The canonical Rust variant is `EnergyTermIR::RotatedInterfacialDmi { d }`.
Only one rotated-interfacial term may be authored in a problem.

(rotated-interfacial-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Python authoring, UI authoring, script export, and reload preserve the interaction
kind and signed bit value of `D`. Requested solver/device/precision remain distinct
from resolved and executed runtime provenance. Non-finite coefficients, duplicate
terms, invalid periodicity, an open boundary without exchange, or an unavailable
strict lane fail before execution. Fullmag never substitutes conventional
interfacial DMI, bulk DMI, or a CPU fallback.

In contract terms, **requested intent** is the authored interaction and execution
request; **resolved execution** is the planner's selected legal lane;
**validation errors** reject malformed or contradictory data; and
**unsupported combinations** fail closed before a backend starts.

The canonical quantities are `H_rotated_dmi` in $\mathrm{A\,m^{-1}}$,
`eden_rotated_dmi` in $\mathrm{J\,m^{-3}}$, and `E_rotated_dmi` in $\mathrm{J}$.
Requesting them without an active rotated-interfacial term is rejected. The
current FEM path also rejects the two field quantities until their separate
materialization path exists; global `E_rotated_dmi` remains available.

(rotated-interfacial-dmi-discrete-realization)=
## Discrete realization and backend status

FDM CPU is the double-precision reference and uses centered interior differences
with exchange+rDMI ghost values at open faces. FDM CUDA implements the same field,
energy, and boundary correction in FP64 and FP32. FEM assembles the complete weak
residual and projects the field using

```{math}
:label: eq-rotated-interfacial-dmi-fem-projection
\mathbf H_{\mathrm{rDMI},a}=-\frac{\mathbf g_a}
{\mu_0M_{s,a}M_a^{\mathrm{lump}}}.
```

FEM GPU uses the same element residual in device kernels. Static-periodic FEM rDMI
is rejected until residual and mass reduction over periodic node classes is
implemented; the periodic Göbel qualification therefore uses FDM. Source
implementation or a successful build is not scientific runtime qualification.

| Solver | Device | Implementation status | Scientific runtime status |
|---|---|---|---|
| FDM | CPU | implemented and operator-tested | Göbel bimeron run **not verified** |
| FDM | GPU | FP64/FP32 implemented and operator-tested | Göbel FP64 CUDA run validated |
| FEM | CPU | MFEM weak form implemented and tested | Göbel bimeron run **not verified** |
| FEM | GPU | CUDA residual implemented and tested | Göbel bimeron run **not verified** |

(rotated-interfacial-dmi-implementation-mapping)=
## Implementation mapping

The semantic path is `Python DSL -> ProblemIR -> validator -> planner -> runner/ABI
-> backend -> quantities/artifacts`. Equations, signs, units, quantity IDs, and
validation criteria are shared; FDM/FEM and CPU/GPU keep separate numerical owners.

(rotated-interfacial-dmi-validation)=
## Göbel 2019 validation

The qualified case is a $500\times40\times0.5\,\mathrm{nm^3}$ film with one
$0.5\,\mathrm{nm}$ FDM cell through thickness, periodic $x$, $M_s=0.58\,
\mathrm{MA\,m^{-1}}$, $A=15\,\mathrm{pJ\,m^{-1}}$, $D=3\,
\mathrm{mJ\,m^{-2}}$, $K_x=0.8\,\mathrm{MJ\,m^{-3}}$, and $\alpha=0.3$.

The strict FP64 CUDA run on an NVIDIA GeForce RTX 4080 SUPER passed 15/15
checks after 20 ps relaxation and a 100 ps zero-current hold. Topological charge
changed from $-0.9996834$ initially to $-0.9999895$ after the hold; the two
opposite-sign $m_z$ cores remained resolved, the background reached
$\langle m_x\rangle=0.9858318$, and total energy decreased from
$-7.7736\times10^{-18}\,\mathrm J$ to $-8.1467871\times10^{-18}\,\mathrm J$.
The device receipt reported the required CUDA operator mask 159/159 and no
host, unknown, or fallback execution.

```{figure} ../../../_static/images/validation/goebel-2019-rotated-dmi-bimeron.png
:alt: Initial, relaxed, and held out-of-plane magnetization of a Göbel 2019 bimeron, with a full-track view and validation metrics.
:width: 100%
:name: fig-goebel-2019-rotated-dmi-bimeron

Reproducible FDM CUDA FP64 stabilization evidence. Color encodes $m_z$; arrows
in the held-state close-up show the in-plane magnetization. The figure is
generated from the verified scenario bundle and its fail-closed verification
report by `scripts/render_goebel_2019_bimeron_figure.py`.
```

See {doc}`validation` for the cross-variant DMI validation matrix. This result
qualifies only the stated FDM CUDA FP64 case; FDM CPU and both FEM bimeron
runtimes remain **not verified**.

(rotated-interfacial-dmi-limitations)=
## Limitations

Spatially varying $D$, a general $3\times3$ DMI tensor, FEM orders above P1,
atomistic frustrated exchange, and Göbel's current-driven SOT motion are not
qualified by this result. A stabilized initial state is not evidence for the
velocity results in Fig. 3 of the paper.

(rotated-interfacial-dmi-scientific-bibliography)=
## Scientific bibliography

1. B. Göbel, A. Mook, J. Henk, I. Mertig, and O. A. Tretiakov, “Magnetic
   bimerons as skyrmion analogues in in-plane magnets,” *Physical Review B*
   **99**, 060407(R) (2019),
   [doi:10.1103/PhysRevB.99.060407](https://doi.org/10.1103/PhysRevB.99.060407).

(rotated-interfacial-dmi-source-code-index)=
## Source-code index

| Contract | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/model/energy.py` | `class RotatedInterfacialDMI` | validation and ProblemIR lowering |
| ProblemIR | `crates/fullmag-ir/src/study.rs` | `EnergyTermIR` | distinct serialized interaction variant |
| ProblemIR validation | `crates/fullmag-ir/src/validation.rs` | `validate_dmi_energy_terms` | finite-value and duplicate-term validation |
| FDM planning | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | legality, boundary, and runtime selection |
| FEM planning | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | legality and backend plan |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `rotated_interfacial_dmi_field` | reference field and energy |
| FDM CPU energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `rotated_interfacial_dmi_energy_from_vectors` | reference interaction energy |
| FDM CUDA | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | FP64 field and boundary correction |
| FDM CUDA boundary | `backends/fdm/gpu/cuda/interactions/dmi_boundary.cuh` | `add_rotated_interfacial_dmi_boundary_correction` | rotated exchange+DMI ghost correction |
| FEM weak residual | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_rotated_interfacial_residual` | first variation shared by FEM realizations |
| FEM plan import | `backends/fem/cpu/mfem/interactions/dmi.cpp` | `initialize_dmi_plan_fields` | import the resolved coefficient into the MFEM context |
| FEM CUDA | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | device element residual |
| Göbel scenario | `tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py` | `study` | canonical public reproduction |
| Göbel verifier | `tests/standard_problems/bimeron/goebel_2019/verify.py` | `verify_bundle` | topology, energy, and execution receipt gates |
