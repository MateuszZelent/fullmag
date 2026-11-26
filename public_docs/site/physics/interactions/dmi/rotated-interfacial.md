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

```{figure} /_static/diagrams/dmi-three-variants-chirality.svg
:alt: Three-panel DMI comparison highlighting panel (c) for rotated interfacial DMI stabilizing an in-plane Göbel 2019 bimeron with opposite-sign m_z meron cores in a +x_hat background, distinct from conventional interfacial DMI in panel (a) and isotropic bulk DMI in panel (b).
:width: 100%
:name: fig-rotated-dmi-variants-comparison
:figclass: fm-physics-figure

Panel (c) shows the rotated Lifshitz invariant $D(L_{zx}^x + L_{xy}^y)$ and numerically evaluated Göbel *et al.* (2019) in-plane bimeron in contrast to conventional interfacial (a) and bulk (b) DMI variants.
```

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
- For nonzero $D$, open boundaries require positive exchange stiffness so that exchange and rDMI
  use the coupled natural boundary law. This includes material-mask edges and
  the resolved local stiffness from material fields, not just an enabled
  `Exchange` term. FDM and FEM treat $D=0$ as a no-op and do not require exchange
  for this boundary law; the explicitly authored term remains in provenance.
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

# %% Rotated DMI, fixed-step RK4 relaxation, and zero-current hold
study.terms.add(fm.RotatedInterfacialDMI(D=3e-3))
study.demag(realization="auto")
study.solver(fix_dt=2.5e-15, integrator="rk4")
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk4",
    dt=2.5e-15,
    relax_alpha=0.3,
    max_steps=8_000,
    max_physical_time_s=20e-12,
    tolT=1e-6,
)
study.stages.add_run(stage_id="hold", until=100e-12)
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
terms, mixed conventional/rotated DMI (including object-scoped terms), invalid
periodicity, an unsatisfied exchange boundary requirement, or an unavailable
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

`E_dmi` and `eden_dmi` include the rotated component; `E_total` and `eden_total`
count it only once. A completed-run manifest stores both aggregate
`final_e_dmi` and the separate `final_e_rotated_dmi` component. The API prefers
the separate component; for legacy manifests it uses `final_e_dmi` for
`E_rotated_dmi` only when the saved plan proves that rDMI is the sole DMI term.
FDM supports on-demand `eden_rotated_dmi` materialization,
but scheduled snapshots and field autosave of that scalar field are currently
rejected. FEM eigenmode and frequency-response profiles reject rDMI and do not
advertise its quantities.

(rotated-interfacial-dmi-discrete-realization)=
## Discrete realization and backend status

FDM CPU is the double-precision reference and uses centered interior differences
with exchange+rDMI ghost values at open faces (`crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs`).
FDM CUDA implements the same field, energy, and boundary correction in FP64 and FP32. FEM CPU
assembles the complete weak residual (`dmi_weak_residual.cpp`) and projects the field using

```{math}
:label: eq-rotated-interfacial-dmi-fem-projection
\mathbf H_{\mathrm{rDMI},a}=-\frac{\mathbf g_a}
{\mu_0M_{s,a}M_a^{\mathrm{lump}}}.
```

FEM GPU uses the **unified preassembled skew-symmetric CSR GPU DMI operator**
(`dmi_csr_operator.cpp::build_gpu_dmi_csr_from_mfem` and
`dmi_csr_kernels.cu::fullmag_cuda_dmi_csr_field_energy`) with edge vectors
$\mathbf d_{ij}^{\mathrm{rot}} = (0, -g_{ij,x}^{\mathrm{rot}}, -g_{ij,y}^{\mathrm{rot}})$
covering `tet4`, 2D periodic `tet4` ($P^{\mathsf T} D P$), `prism6` (including `pure_prism_p2`),
and `mixed` (`prism6 + pyramid5 + tet4`) meshes with zero global `atomicAdd` on field
evaluation, compensated double-double (`gpu_relax_dd`) Armijo increments, predicated
`cub::BlockReduce` energy reductions, and intermediate RK `energy_out=nullptr` gating. On an
RTX 4080 SUPER (SM `89-real`), CSR GPU rotated DMI achieves machine-precision parity against
CPU MFEM ($h_{\mathrm{rel}} \le 1.12 \times 10^{-15}$, $E_{\mathrm{rel}} \le 3.87 \times 10^{-14}$
across `tet4`, 2D periodic `tet4`, `prism6`, and `mixed` meshes; `0.0891 ms` field-only on
`prism6_120x120x2`, `1,953×` faster than CPU MFEM, `1.72×–4.80×` faster than legacy `tet4` GPU;
`compute-sanitizer --tool memcheck` 0 errors). See
{ref}`numerical-methods-performance-fem-gpu-demag` and
{ref}`numerical-methods-performance-fem-gpu-kernels`. Source implementation or operator parity
does not replace end-to-end Göbel bimeron trajectory verification.

The FDM planner validates resolved cellwise exchange stiffness, but native CUDA
still rejects cellwise material fields. This validation does not add native
CUDA support for spatially varying exchange coefficients.

| Solver | Device | Implementation status | Scientific runtime status |
|---|---|---|---|
| FDM | CPU | implemented and operator-tested | Göbel bimeron run **not verified** |
| FDM | GPU | FP64/FP32 implemented and operator-tested | historical 15-check report; current 19-check run **not verified** |
| FEM | CPU | MFEM weak form implemented and tested across `tet4`/`prism6`/`mixed` | Göbel bimeron run **not verified** |
| FEM | GPU | unified CSR GPU DMI (`dmi_csr_*`) qualified on RTX 4080 SUPER across `tet4`, 2D periodic `tet4`, `prism6`, and `mixed` (`h_rel <= 1.12e-15`, `E_rel <= 3.87e-14`, 0 memcheck errors) | full Göbel 19-check bimeron trajectory **not verified** |

(rotated-interfacial-dmi-implementation-mapping)=
## Implementation mapping

The semantic path is `Python DSL -> ProblemIR -> validator -> planner -> runner/ABI
-> backend -> quantities/artifacts`. Equations, signs, units, quantity IDs, and
validation criteria are shared; FDM/FEM and CPU/GPU keep separate numerical owners.

(rotated-interfacial-dmi-validation)=
## Göbel 2019 validation

The reference case is a $500\times40\times0.5\,\mathrm{nm^3}$ film with one $0.5\,\mathrm{nm}$ FDM cell through thickness, periodic $x$, $M_s=0.58\,\mathrm{MA\,m^{-1}}$, $A=15\,\mathrm{pJ\,m^{-1}}$, $D=3\,\mathrm{mJ\,m^{-2}}$, $K_x=0.8\,\mathrm{MJ\,m^{-3}}$, and $\alpha=0.3$.

The stored strict FP64 CUDA report was generated before the verifier gained its
current 19 checks. It previously passed 15/15 checks after 20 ps relaxation and
a 100 ps zero-current hold, but that historical report is **NOT VERIFIED**
against the current verifier until the run is repeated. The historical result
reported topological charge changing from $-0.9996834$ initially to
$-0.9999895$ after the hold; the two opposite-sign $m_z$ cores remained
resolved, the background reached $\langle m_x\rangle=0.9858318$, and total
energy decreased from $-7.7736\times10^{-18}\,\mathrm J$ to
$-8.1467871\times10^{-18}\,\mathrm J$. Its device receipt reported the
required CUDA operator mask 159/159 and no host, unknown, or fallback
execution; those values do not replace a fresh 19-check verification.

The current verifier requires at least 20 ps of relaxation and 100 ps of
zero-current hold, measured from the saved state times. The figure generator
uses those actual times for its panel labels and stage durations. Its Pillow
dependency is declared in the Python `figures` extra and in `just ensure-python`.

```{figure} ../../../_static/images/validation/goebel-2019-rotated-dmi-bimeron.png
:alt: Initial, relaxed, and held out-of-plane magnetization of a Göbel 2019 bimeron, with a full-track view and validation metrics.
:width: 100%
:name: fig-goebel-2019-rotated-dmi-bimeron

Historical FDM CUDA FP64 stabilization artifact. Color encodes $m_z$; arrows in
the held-state close-up show the in-plane magnetization. The figure is
generated from the stored scenario bundle and its fail-closed verification
report by `scripts/render_goebel_2019_bimeron_figure.py`; current 19-check
qualification remains **NOT VERIFIED** until a fresh run.
```

See {doc}`validation` for the cross-variant DMI validation matrix and the unified CSR GPU DMI
machine-precision parity results. A fresh 19-check report is required before this artifact can
qualify the stated FDM CUDA FP64 case; FDM CPU and both FEM bimeron trajectories remain
**not verified**.

(rotated-interfacial-dmi-limitations)=
## Limitations

Spatially varying $D$, a general $3\times3$ DMI tensor, FEM magnetization orders above P1,
atomistic frustrated exchange, and Göbel's current-driven SOT motion are not
qualified by this result. A stabilized initial state is not evidence for the
velocity results in Fig. 3 of the paper.

(rotated-interfacial-dmi-scientific-bibliography)=
## Scientific bibliography

1. B. Göbel, A. Mook, J. Henk, I. Mertig, and O. A. Tretiakov, “Magnetic
   bimerons as skyrmion analogues in in-plane magnets,” *Physical Review B*
   **99**(6), 060407(R) (2019).
   [doi:10.1103/PhysRevB.99.060407](https://doi.org/10.1103/PhysRevB.99.060407) | [arXiv:1811.07068](https://arxiv.org/abs/1811.07068).

(rotated-interfacial-dmi-source-code-index)=
## Source-code index

| Contract | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Python API | [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L150) | [`class RotatedInterfacialDMI`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L150) | validation and ProblemIR lowering |
| ProblemIR | [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study.rs#L606) | [`EnergyTermIR`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study.rs#L606) | distinct serialized interaction variant |
| ProblemIR validation | [`crates/fullmag-ir/src/validation.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/validation.rs#L2346) | [`validate_dmi_energy_terms`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/validation.rs#L2346) | finite-value and duplicate-term validation |
| FDM planning | [`crates/fullmag-plan/src/fdm.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | [`plan_fdm`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | legality, boundary, and runtime selection |
| FEM planning | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | [`plan_fem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | legality and backend plan |
| Scalar artifacts | [`crates/fullmag-api/src/quantities.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-api/src/quantities.rs#L224) | [`run_manifest_scalar_value`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-api/src/quantities.rs#L224) | plan-guarded completed-run energy fallback |
| Modal capabilities | [`crates/fullmag-runner/src/capabilities.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/capabilities.rs#L1181) | [`capabilities_for_fem_eigen_engine`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/capabilities.rs#L1181) | reject unsupported rDMI modal quantities |
| FDM CPU field | [`crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs#L513) | [`rotated_interfacial_dmi_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs#L513) | reference field |
| FDM CPU energy | [`crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs#L13) | [`rotated_interfacial_dmi_energy_from_vectors`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs#L13) | reference interaction energy |
| FDM CUDA | [`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L244) | [`combine_effective_field_fp64_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L244) | FP64 field and boundary correction |
| FDM CUDA boundary | [`backends/fdm/gpu/cuda/interactions/dmi_boundary.cuh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/dmi_boundary.cuh#L92) | [`add_rotated_interfacial_dmi_boundary_correction`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/dmi_boundary.cuh#L92) | rotated exchange+DMI ghost correction |
| FEM weak residual | [`backends/fem/src/dmi_weak_residual.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/dmi_weak_residual.cpp#L90) | [`dmi_accumulate_rotated_interfacial_residual`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/dmi_weak_residual.cpp#L90) | first variation shared by FEM realizations |
| FEM plan import | [`backends/fem/cpu/mfem/interactions/dmi.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/dmi.cpp#L38) | [`initialize_rotated_dmi_plan_fields`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/dmi.cpp#L38) | import rotated coefficient from extended ABI into MFEM context |
| FEM CUDA CSR operator | [`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp#L138) | [`build_gpu_dmi_csr_from_mfem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp#L138) | preassembled CSR edge-vector operator across `tet4`/`prism6`/`mixed`/periodic |
| FEM CUDA CSR kernel | [`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu#L331) | [`fullmag_cuda_dmi_csr_field_energy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu#L331) | zero-atomic CSR SpMV, CUB block energy, and `energy_out=nullptr` RK gating |
| FEM CUDA `tet4` oracle | [`backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu#L116) | [`dmi_element_residual_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu#L116) | legacy standalone `tet4` device residual oracle |
| Göbel scenario | [`tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py#L29) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py#L29) | canonical public reproduction |
| Göbel verifier | [`tests/standard_problems/bimeron/goebel_2019/verify.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/bimeron/goebel_2019/verify.py#L344) | [`verify_bundle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/bimeron/goebel_2019/verify.py#L344) | topology, energy, and execution receipt gates |
