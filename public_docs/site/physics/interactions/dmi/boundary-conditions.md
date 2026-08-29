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
exchange condition. This page documents the exact boundary terms for both DMI variants.

(dmi-boundary-governing-equations)=
## Governing equations

### Interfacial DMI boundary condition

The combined exchange-plus-interfacial-DMI variational problem produces the natural surface
term

```{math}
:label: eq-idmi-bc
A\,\partial_n\mathbf{m}
+ D\,\hat{\mathbf{n}}\times(\mathbf{n}_s\times\mathbf{m})
= \mathbf{0}
\qquad\text{on }\partial\Omega_m,
```

where $\mathbf{n}_s$ is the outward surface normal and $\hat{\mathbf{n}}$ is the
interface-symmetry normal. For $\hat{\mathbf{n}}=\hat{\mathbf{z}}$ this reduces to the
Rohart–Thiaville condition.

This boundary condition is physically significant: it modifies the equilibrium magnetization
at the sample edges and determines the boundary twist of chiral domain walls and skyrmions.
For strong DMI ($|D|/(2A)$ comparable to the inverse sample width), the boundary condition
lifts the edge magnetization toward the interface normal.

(dmi-boundary-problem-statement)=
## Physical domain and scope

The boundary operator belongs to the combined exchange-DMI variational problem. It is not a
free-standing boundary value that can be added after computing a DMI field. The surface normal,
interface-symmetry normal, coefficient convention, and solver realization must be resolved
together. The natural condition is homogeneous only when the DMI surface contribution vanishes.

### FEM implementation

In the FEM weak formulation, the natural boundary condition arises automatically from the
variational principle. The DMI weak residual includes a boundary integral that implicitly
enforces Eq. {eq}`eq-idmi-bc`. No explicit boundary penalty or constraint is needed.

### FDM implementation

In the FDM stencil, open or inactive boundary neighbours use the centre magnetization as
the ghost value, which enforces the standard zero-flux exchange condition. The DMI stencil
contribution at boundary cells uses one-sided finite differences or reflected values that
encode the same surface condition.

## Bulk DMI boundary condition

The combined exchange-plus-bulk-DMI natural boundary term is

```{math}
:label: eq-bdmi-bc
A\,\partial_n\mathbf{m}
+ D\,\mathbf{n}_s\times\mathbf{m}
= \mathbf{0}
\qquad\text{on }\partial\Omega_m.
```

This is the isotropic analogue: the DMI surface correction is a tangential rotation
proportional to the DMI constant and the surface normal.

## Characteristic length

The DMI boundary condition introduces a characteristic length

```{math}
:label: eq-dmi-bc-length
\ell_{\mathrm{DMI}} = \frac{2A}{|D|}
```

that determines the spatial extent of the boundary twist. When the sample dimension is much
larger than $\ell_{\mathrm{DMI}}$, the boundary modification is confined to a surface layer.
When the sample is comparable to $\ell_{\mathrm{DMI}}$, the DMI boundary condition
significantly modifies the bulk magnetization profile.

## Impact on skyrmion confinement

In confined geometries (nanodiscs, nanowires), the DMI boundary condition determines
whether skyrmions are attracted to or repelled from the sample edge. The Rohart–Thiaville
analysis shows that the boundary condition creates an effective edge potential for skyrmion
centres.

## Symbols and SI units

(dmi-boundary-symbols-and-si-units)=

| Symbol | Definition | SI unit |
|---|---|---:|
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $D$ | DMI constant | $\mathrm{J\,m^{-2}}$ |
| $\hat{\mathbf{n}}$ | interface-symmetry normal | $1$ |
| $\mathbf{n}_s$ | outward surface normal | $1$ |
| $\partial_n$ | normal derivative | $\mathrm{m^{-1}}$ |
| $\ell_{\mathrm{DMI}}$ | DMI boundary-twist length | $\mathrm{m}$ |
| $\mathbf m$ | reduced magnetization | $1$ |

(dmi-boundary-assumptions-and-validity)=
## Assumptions and validity

- $A$ is the bulk exchange stiffness and $D$ is the coefficient used by the selected DMI
  convention; their units and sign are not converted by the Python object.
- The interfacial symmetry normal is normalized by FEM when non-zero. Current FDM planning
  accepts only the documented canonical orientation; a tilted FDM normal is rejected.
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
`Dind` to a magnetic body activates the interfacial-DMI term, and the resolved FDM or FEM
realization supplies its natural boundary treatment together with exchange. This complete FDM
scenario relaxes a Neel wall in an open nanostrip and records the field and energy needed to
inspect the edge twist.

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
| `BulkDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite | bulk DMI coefficient and sign | FDM/FEM lane-dependent | `energy_terms[].D` for `bulk_dmi` |

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

The planner resolves the normal policy and boundary realization after lowering. It must
not silently turn bulk DMI into interfacial DMI or rotate an FDM stencil to accommodate a
normal that the FDM lane does not support.

(dmi-boundary-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the term kind, signed coefficient, and authored normal. Resolved
execution adds solver, device, normalized normal, boundary operator, precision, and field
output policy. Validation errors include non-finite coefficients, malformed vectors, zero
FEM normals, and unsupported FDM normal orientation. Unsupported combinations are planner
errors; no CPU fallback or boundary omission is allowed.
Resolved execution is recorded separately from requested intent. Unsupported combinations
are rejected before a solver starts.

(dmi-boundary-discrete-realization)=
## Discrete realization

FEM obtains the natural boundary term from the weak residual and integrates it on the
resolved surface trace. FDM represents the boundary through one-sided/reflected stencil
values and active-neighbour rules. These are separate realizations and require separate
convergence evidence; the shared continuum equation does not prove discrete parity.

(dmi-boundary-implementation-mapping)=
## Implementation mapping

The Python classes own coefficient and normal serialization. FEM interfacial and bulk DMI
residuals are implemented in separate interaction modules; FDM planning owns the canonical
normal legality rule. The source map below gives stable path-plus-symbol identities.

(dmi-boundary-validation)=
## Validation

Validate uniform-state zero field, sign reversal under $D\to-D$, analytic linear gradients,
boundary-layer convergence against $\ell_{\mathrm{DMI}}$, FEM energy finite differences,
FDM boundary-stencil symmetry, tilted-normal rejection, and matched precision/device evidence.

(dmi-boundary-limitations)=
## Limitations

The public contract does not yet expose a spatial normal field, curved-surface DMI operator,
or an arbitrary FDM interface orientation. The boundary equations describe the current
physical target; lane status must be read from the canonical DMI realization pages.

(dmi-boundary-scientific-bibliography)=

## Scientific bibliography

1. S. Rohart and A. Thiaville, "Skyrmion confinement in ultrathin film nanostructures in
   the presence of Dzyaloshinskii-Moriya interaction," *Physical Review B* **88**, 184422
   (2013). [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).
2. A. O. Leonov, T. L. Monchesky, N. Romming, A. Kubetzka, A. N. Bogdanov, and
   R. Wiesendanger, "The properties of isolated chiral skyrmions in thin magnetic films,"
   *New Journal of Physics* **18**, 065003 (2016).
   [doi:10.1088/1367-2630/18/6/065003](https://doi.org/10.1088/1367-2630/18/6/065003).

(dmi-boundary-source-code-index)=

## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Physics` when `PhysicsInteractionPanel` exposes the interaction. Status: `partial`. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Interfacial DMI API | packages/fullmag-py/src/fullmag/model/energy.py | class InterfacialDMI | coefficient and normal validation | Python |
| Bulk DMI API | packages/fullmag-py/src/fullmag/model/energy.py | class BulkDMI | coefficient validation and IR | Python |
| Interfacial FEM residual | backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp | compute_interfacial_dmi_field | FEM field realization | FEM CPU |
| Bulk FEM residual | backends/fem/cpu/mfem/interactions/dmi_bulk.cpp | compute_bulk_dmi_field | FEM field realization | FEM CPU |
| GPU DMI projection and energy | backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu | fullmag_cuda_dmi_field_energy | CUDA field/energy path | FEM GPU |
| FDM layered DMI launch | backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu | launch_multilayer_dmi_field_fp64 | CUDA layered DMI path | FDM GPU |
