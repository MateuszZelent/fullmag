---
title: DMI boundary conditions
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md
---

(public-docs-physics-interactions-dmi-boundary-conditions)=
# DMI boundary conditions

When Dzyaloshinskii–Moriya interaction is active, the natural boundary condition on the
magnetic surface $\partial\Omega_m$ is modified from the standard homogeneous Neumann
exchange condition. This page documents the exact natural boundary laws for all three DMI
variants: conventional interfacial DMI, isotropic bulk DMI, and rotated interfacial DMI
(Göbel *et al.* 2019).

(dmi-boundary-governing-equations)=
## Governing equations

### Interfacial DMI boundary condition

The combined exchange-plus-interfacial-DMI variational problem produces the natural surface
term

```{math}
:label: eq-idmi-bc
2A\,\partial_n\mathbf{m}
+ D\,(\hat{\mathbf{n}}\times\mathbf{n}_s)\times\mathbf{m}
= \mathbf{0}
\qquad\text{on }\partial\Omega_m,
```

where $\mathbf{n}_s$ is the outward surface normal and $\hat{\mathbf{n}}$ is the
interface-symmetry normal. For $\hat{\mathbf{n}}=\hat{\mathbf{z}}$ this reduces to the
Rohart–Thiaville condition.

This boundary condition is physically significant: it modifies the equilibrium magnetization
at the sample edges and determines the boundary twist of chiral domain walls and skyrmions.
For strong DMI ($\lvert D\rvert/(2A)$ comparable to the inverse sample width), the boundary condition
lifts the edge magnetization toward the interface normal.

(dmi-boundary-problem-statement)=
## Physical domain and scope

The boundary operator belongs to the combined exchange-DMI variational problem. It is not a
free-standing boundary value that can be added after computing a DMI field. The surface normal,
interface-symmetry normal, coefficient convention, and solver realization must be resolved
together. The natural condition is homogeneous only when the DMI surface contribution vanishes.

### FEM implementation

In the FEM weak formulation, the natural boundary condition arises automatically from the
variational principle. The DMI weak residual (`dmi_weak_residual.cpp`) and its preassembled
skew-symmetric CSR GPU representation (`dmi_csr_operator.cpp` / `dmi_csr_kernels.cu`) implicitly
enforce Eqs. {eq}`eq-idmi-bc`, {eq}`eq-bdmi-bc`, and {eq}`eq-rdmi-bc` across `tet4`, `prism6`,
and `mixed` meshes without explicit boundary penalties or double-counted surface integrals.

### FDM implementation

In the FDM stencil, open or inactive boundary neighbours use the centre magnetization as
the ghost value for pure exchange, and apply the coupled exchange-plus-DMI ghost correction
at open faces (`dmi_boundary.cuh` and `crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs`) to
encode the natural chiral boundary condition for interfacial and rotated interfacial DMI.
Bulk DMI in FDM requires all three axes periodic, removing exterior free-surface terms.

## Bulk DMI boundary condition

The combined exchange-plus-bulk-DMI natural boundary term is

```{math}
:label: eq-bdmi-bc
2A\,\partial_n\mathbf{m}
+ D\,\mathbf{m}\times\mathbf{n}_s
= \mathbf{0}
\qquad\text{on }\partial\Omega_m.
```

This is the isotropic analogue: the DMI surface correction is a tangential rotation
proportional to the DMI constant and the surface normal.

## Rotated interfacial DMI boundary condition

For the rotated interfacial Lifshitz invariant
$w_{\mathrm{rot}} = D_{\mathrm{rot}}(m_z\partial_x m_x - m_x\partial_x m_z + m_x\partial_y m_y - m_y\partial_y m_x)$
(Rohart–Thiaville rotated to the in-plane Göbel *et al.* bimeron symmetry), varying exchange
and rotated interfacial DMI together on an open magnetic surface with outward unit normal
$\mathbf{n}_s = (n_{s,x}, n_{s,y}, n_{s,z})^{\mathsf T}$ yields the third natural boundary law:

```{math}
:label: eq-rdmi-bc
2A\,\partial_n\mathbf{m}
+ D_{\mathrm{rot}}
\left(n_{s,x}m_z - n_{s,y}m_y,\; n_{s,y}m_x,\; -n_{s,x}m_x\right)^{\mathsf T}
= \mathbf{0}
\qquad\text{on }\partial\Omega_m.
```

Because $w_{\mathrm{rot}}$ differentiates only in $x$ and $y$, top and bottom faces with
$\mathbf{n}_s = \pm\hat{\mathbf{z}}$ reduce to homogeneous Neumann ($\partial_z\mathbf{m}=\mathbf{0}$),
while lateral open faces with $n_{s,x}\neq 0$ or $n_{s,y}\neq 0$ carry the chiral bimeron
edge twist. Non-zero $D_{\mathrm{rot}}$ on open boundaries requires positive exchange stiffness
$A > 0$.

## Characteristic length

The DMI boundary condition introduces a characteristic length

```{math}
:label: eq-dmi-bc-length
\ell_{\mathrm{DMI}} = \frac{2A}{\lvert D\rvert}
```

that sets the inverse boundary rotation slope ($\lvert\partial_\nu\theta\rvert^{-1}$), while the inward edge-canting
tail in an exchange–anisotropy film decays over the exchange recovery length
$\Delta = \sqrt{A/K_{\mathrm{eff}}}$. When the sample dimension is much larger than $\Delta$, the
boundary modification is confined to an edge layer of thickness $\mathcal O(\Delta)$. When the
sample width is comparable to $\Delta$ and $\ell_{\mathrm{DMI}}$, the DMI boundary condition
significantly modifies the bulk magnetization profile.

## Impact on skyrmion confinement

In confined geometries (nanodiscs, nanowires), the DMI boundary condition determines
whether skyrmions are attracted to or repelled from the sample edge. The Rohart–Thiaville
analysis shows that the boundary condition creates an effective edge potential for skyrmion
centres.

```{figure} /_static/diagrams/dmi-boundary-canting-and-normals.svg
:alt: Two-panel diagram showing (a) the numerically solved Rohart-Thiaville edge canting profile m_z(x) across an open nanostrip under 2A d_nu m + D[(n_hat x nu) x m] = 0, and (b) FDM fixed +z_hat interface normal with ghost boundary correction versus FEM general normalized interface normal n_hat carrying the natural boundary integral weakly, plus isotropic bulk DMI boundary law contrast.
:width: 100%
:name: fig-dmi-boundary-canting-and-normals
:figclass: fm-physics-figure

Solved chiral boundary canting profile $m_z(x)$ across an open nanostrip showing the inward exponential decay length $\Delta = \sqrt{A/K_{\mathrm{eff}}}$ and inverse boundary slope $\ell_{\mathrm{DMI}} = 2A/\lvert D\rvert$ (a), and discrete realization of interface normals and natural boundary laws across FDM and FEM (b) (Rohart & Thiaville 2013; Leonov et al. 2016; Mulkers et al. 2018).
```

## Symbols and SI units

(dmi-boundary-symbols-and-si-units)=

| Symbol | Definition | SI unit |
|---|---|---:|
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $D$ | DMI constant | $\mathrm{J\,m^{-2}}$ |
| $D_{\mathrm{rot}}$ | rotated interfacial DMI constant | $\mathrm{J\,m^{-2}}$ |
| $\hat{\mathbf{n}}$ | interface-symmetry normal | $1$ |
| $\mathbf{n}_s$ | outward surface normal | $1$ |
| $n_{s,x}, n_{s,y}$ | in-plane components of outward surface normal | $1$ |
| $\partial_n$ | normal derivative | $\mathrm{m^{-1}}$ |
| $\ell_{\mathrm{DMI}}$ | DMI boundary-twist length | $\mathrm{m}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $m_x, m_y, m_z$ | Cartesian components of reduced magnetization | $1$ |

(dmi-boundary-assumptions-and-validity)=
## Assumptions and validity

- $A$ is the bulk exchange stiffness and $D$ (or $D_{\mathrm{rot}}$) is the coefficient used by
  the selected DMI convention; their units and sign are not converted by the Python object.
- The interfacial symmetry normal is normalized by FEM when non-zero. Current FDM planning
  accepts only the documented canonical $+\hat{\mathbf z}$ orientation; a tilted FDM normal is rejected.
- The boundary formula assumes a smooth enough surface for a trace normal. Corners and
  non-conforming interfaces require a mesh-specific treatment and must not be described as
  the smooth formula without qualification.
- The characteristic length is a scale estimate, not a replacement for resolving the
  boundary layer. Mesh or cell size must be reported relative to $\ell_{\mathrm{DMI}}$.
- Python serialization, source contracts, and a skipped GPU test are not boundary-condition
  qualification evidence.

(dmi-boundary-python-api)=
## Python API and boundary request

The DMI boundary operator is not registered independently. In the stage-first API, assigning
`Dind` to a magnetic body (or adding `fm.RotatedInterfacialDMI(D=...)` via `study.terms.add(...)`)
activates the corresponding DMI term, and the resolved FDM or FEM realization supplies its natural
boundary treatment together with exchange. This complete FDM scenario relaxes a Néel wall in an
open nanostrip and records the field and energy needed to inspect the edge twist.

```python
# %% Imports and units
import fullmag as fm

nm = 1.0e-9

# %% Open-boundary FDM study
study = fm.study("interfacial_dmi_boundary_twist")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

# %% Geometry, material, chiral state, and interactions
strip = study.geometry(
    fm.Box(size=(120 * nm, 40 * nm, 2 * nm), name="strip"),
    name="strip",
)
strip.Ms = 5.8e5
strip.Aex = 15.0e-12
strip.Dind = 3.0e-3
strip.alpha = 0.3
strip.m = fm.texture.domain_wall(
    width=12 * nm,
    kind="neel",
    normal_axis="x",
    left=(0.0, 0.0, 1.0),
    right=(0.0, 0.0, -1.0),
)
study.exchange()
study.demag(enabled=False)

# %% Ordered relaxation stage and boundary-sensitive observables
study.stages.add_relax(
    stage_id="relax_boundary_twist",
    algorithm="projected_gradient_bb",
    max_steps=1_000,
    tolT=1.0e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "e_ex", "e_dmi", "e_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("H_dmi", every_steps=20)],
    )
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `InterfacialDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite | interfacial DMI coefficient and sign | FDM/FEM subject to normal policy | `energy_terms[].D` |
| `InterfacialDMI.interface_normal` | `Sequence[float] or None` | `None` | $1$ | three finite values; FEM non-zero; FDM canonical orientation | interface-symmetry normal | FEM arbitrary non-zero; FDM restricted | `energy_terms[].interface_normal` |
| `BulkDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite | bulk DMI coefficient and sign | FDM 3D PBC / FEM CPU/GPU | `energy_terms[].D` for `bulk_dmi` |
| `RotatedInterfacialDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite; requires positive exchange on open faces when non-zero | rotated interfacial DMI coefficient and sign | FDM/FEM CPU/GPU | `energy_terms[].D` for `rotated_interfacial_dmi` |

(dmi-boundary-problem-ir)=
## ProblemIR lowering

The explicit terms lower independently and preserve their signed coefficients:

```json
{
  "energy_terms": [
    {"kind": "interfacial_dmi", "D": 0.0025, "interface_normal": [0.0, 0.0, 1.0]},
    {"kind": "bulk_dmi", "D": 0.001}
  ]
}
```

A rotated interfacial DMI term lowers separately as `{"kind": "rotated_interfacial_dmi", "D": 0.003}`
and cannot be combined with conventional `interfacial_dmi`. The planner resolves the normal
policy and boundary realization after lowering. It must not silently turn bulk or rotated DMI
into conventional interfacial DMI or rotate an FDM stencil to accommodate an unsupported normal.

(dmi-boundary-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the term kind, signed coefficient, and authored normal. Resolved
execution adds solver, device, normalized normal, boundary operator, precision, and field
output policy. Validation errors include non-finite coefficients, malformed vectors, zero
FEM normals, unsupported FDM normal orientation, mixing conventional and rotated interfacial
DMI, and open-boundary non-zero rotated DMI without positive exchange stiffness. Unsupported
combinations are planner errors; no CPU fallback or boundary omission is allowed.
Resolved execution is recorded separately from requested intent. Unsupported combinations
are rejected before a solver starts.

(dmi-boundary-discrete-realization)=
## Discrete realization

FEM obtains all three natural boundary terms from the weak residual and integrates them weakly
over the magnetic domain on CPU (`dmi_weak_residual.cpp`) and in the unified preassembled CSR
operator on GPU (`dmi_csr_operator.cpp` / `dmi_csr_kernels.cu`, supporting `tet4`, `prism6`,
`mixed`, and 2D periodic meshes). FDM represents open boundaries through exchange-plus-DMI
ghost corrections (`dmi_boundary.cuh` and `crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs`)
for interfacial and rotated interfacial DMI, while rejecting non-periodic bulk DMI. These are
separate realizations and require separate convergence evidence; the shared continuum equation
does not prove discrete parity. See {ref}`numerical-methods-performance-fem-gpu-demag` for CSR
GPU DMI validation across `tet4`, `prism6`, and `mixed` meshes.

(dmi-boundary-implementation-mapping)=
## Implementation mapping

The Python classes own coefficient and normal serialization, FEM interfacial, rotated
interfacial, and bulk DMI weak residuals are shared through `dmi_weak_residual.cpp` and
compiled into CSR GPU operators by `build_gpu_dmi_csr_from_mfem`, and FDM planning plus
ghost-correction helpers own the canonical normal legality and open-boundary stencils. See
the source-code index below for the corresponding modules and symbols.

(dmi-boundary-validation)=
## Validation

Validate uniform-state zero field, sign reversal under $D\to-D$, analytic linear gradients,
boundary-layer convergence against $\ell_{\mathrm{DMI}}$, FEM energy finite differences,
FDM boundary-stencil symmetry for both interfacial and rotated interfacial DMI, tilted-normal
rejection on FDM, and matched precision/device evidence (including FEM GPU CSR parity across
`tet4`, `prism6`, `mixed`, and periodic meshes).

(dmi-boundary-limitations)=
## Limitations

The public contract does not yet expose a spatial normal field, curved-surface DMI operator,
non-periodic FDM bulk DMI boundary closure, or an arbitrary FDM interface orientation. The
boundary equations describe the current physical target; lane status must be read from the
canonical DMI realization pages.

(dmi-boundary-scientific-bibliography)=
## Scientific bibliography

1. S. Rohart and A. Thiaville, “Skyrmion confinement in ultrathin film nanostructures in the presence of Dzyaloshinskii-Moriya interaction,” *Physical Review B* **88**(18), 184422 (2013). [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422) | [arXiv:1310.0666](https://arxiv.org/abs/1310.0666).
2. A. O. Leonov, T. L. Monchesky, N. Romming, A. Kubetzka, A. N. Bogdanov, and R. Wiesendanger, “The properties of isolated chiral skyrmions in thin magnetic films,” *New Journal of Physics* **18**(6), 065003 (2016). [doi:10.1088/1367-2630/18/6/065003](https://doi.org/10.1088/1367-2630/18/6/065003) | [Open-access PDF (CC-BY)](https://iopscience.iop.org/article/10.1088/1367-2630/18/6/065003/pdf) | [arXiv:1508.02155](https://arxiv.org/abs/1508.02155).
3. J. Mulkers, K. M. D. Hals, J. Leliaert, M. V. Milošević, B. Van Waeyenberge, and K. Everschor-Sitte, “Effect of boundary-induced chirality on magnetic textures in thin films,” *Physical Review B* **98**(6), 064429 (2018). [doi:10.1103/PhysRevB.98.064429](https://doi.org/10.1103/PhysRevB.98.064429) | [arXiv:1805.11110](https://arxiv.org/abs/1805.11110).
4. B. Göbel, A. Mook, J. Henk, I. Mertig, and O. A. Tretiakov, “Magnetic bimerons as skyrmion analogues in in-plane magnets,” *Physical Review B* **99**(6), 060407(R) (2019). [doi:10.1103/PhysRevB.99.060407](https://doi.org/10.1103/PhysRevB.99.060407) | [arXiv:1811.07068](https://arxiv.org/abs/1811.07068).

(dmi-boundary-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Interfacial DMI API | [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L128) | [`class InterfacialDMI`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L128) | coefficient and normal validation | Python |
| Bulk DMI API | [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L187) | [`class BulkDMI`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L187) | coefficient validation and IR | Python |
| Rotated DMI API | [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L150) | [`class RotatedInterfacialDMI`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L150) | rotated coefficient validation and IR | Python |
| Interfacial FEM residual | [`backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp#L30) | [`compute_interfacial_dmi_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp#L30) | FEM interfacial and rotated field realization | FEM CPU |
| Bulk FEM residual | [`backends/fem/cpu/mfem/interactions/dmi_bulk.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/dmi_bulk.cpp#L28) | [`compute_bulk_dmi_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/dmi_bulk.cpp#L28) | FEM bulk field realization | FEM CPU |
| Rotated FEM weak variation | [`backends/fem/src/dmi_weak_residual.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/dmi_weak_residual.cpp#L90) | [`dmi_accumulate_rotated_interfacial_residual`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/dmi_weak_residual.cpp#L90) | shared weak variation carrying Eq. {eq}`eq-rdmi-bc` | FEM CPU/GPU |
| Unified CSR GPU DMI operator | [`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp#L138) | [`build_gpu_dmi_csr_from_mfem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp#L138) | skew-symmetric CSR assembly preserving natural BCs on `tet4`/`prism6`/`mixed` | FEM GPU |
| Unified CSR GPU DMI kernel | [`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu#L331) | [`fullmag_cuda_dmi_csr_field_energy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu#L331) | CSR GPU field/energy evaluation | FEM GPU |
| FDM rotated DMI ghost BC | [`backends/fdm/gpu/cuda/interactions/dmi_boundary.cuh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/dmi_boundary.cuh#L92) | [`add_rotated_interfacial_dmi_boundary_correction`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/dmi_boundary.cuh#L92) | rotated exchange+DMI ghost correction on open faces | FDM GPU |
| FDM layered DMI launch | [`backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu#L450) | [`launch_multilayer_dmi_field_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu#L450) | CUDA layered DMI path | FDM GPU |
