---
title: Magnetoelastic interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0700-shared-magnetoelastic-semantics.md
---

(public-docs-physics-interactions-magnetoelastic)=
# Magnetoelastic interaction

Magnetoelastic coupling links the magnetization direction to a prescribed mechanical
deformation. In the current FullMag implementation, the executable numerical kernel is the
cubic $B_1/B_2$ prescribed-strain interaction: the strain is supplied as data, and FullMag
computes $\mathbf H_{\mathrm{mel}}$ and $E_{\mathrm{mel}}$. It does not solve for displacement.

This distinction is essential. The Python package also exposes elastic bodies, mechanical
boundary conditions, mechanical loads, and three mechanics-mode objects. Their existence and
serialization are API/IR contracts; they are not by themselves proof that a complete
magneto-mechanical time integration is executable.

## What is executable at this revision

| Solver | Device | Status | Evidence-backed boundary |
|---|---|---|---|
| FDM | CPU | partial | Native prescribed-strain field and energy kernels exist, including uniform/per-cell strain and active masks; the public planner currently rejects a complete Magnetoelastic `ProblemIR` for the FDM lane. |
| FDM | GPU | partial | FP64 and FP32 effective-field kernels contain the prescribed-strain $B_1/B_2$ branch; the public planner and executed-device qualification do not establish a complete lane. |
| FEM | CPU | implemented | The native FEM planner resolves one prescribed-strain Magnetoelastic term and the CPU realization computes nodal field and lumped energy on magnetic nodes. |
| FEM | GPU | implemented | Device-resident strain upload and field/block-energy kernels exist; current executed-device parity remains a separate qualification claim. |

The FEM planner rejects quasistatic and elastodynamic mechanics, requires one prescribed-strain
load, rejects unresolved isotropic-to-$B_1/B_2$ conversion, and fails on unknown graph
references. No lane silently converts an unsupported mechanics request into prescribed strain.

(mel-problem-statement)=
## Physical problem

Let $\Omega_m$ be the magnetic domain, $\mathbf M$ the magnetization, $M_s>0$ the saturation
magnetization, and $\mathbf m=\mathbf M/M_s$ the reduced magnetization. The prescribed strain
field is external input. It is not a displacement solution produced by the current interaction
kernel.

The interaction is local in the magnetization and strain values. Its field is added to the
effective-field assembly and its density is reduced to the native scalar `E_mel`. The current
public `SaveScalar` selector exposes the aggregate result as `E_total`; the magnetoelastic term
does not replace exchange, demagnetization, Zeeman, anisotropy, or DMI.

(mel-governing-equations)=
## Governing equations

### Input Voigt convention

FullMag accepts six engineering-Voigt values in the exact order
$(11,22,33,23,13,12)$. The last three values are engineering shear components, not tensor
shear components:

```{math}
:label: eq-mel-voigt-order
\boldsymbol{\varepsilon}^{\mathrm{eng}}
=
\begin{bmatrix}
\varepsilon_{11} & \varepsilon_{22} & \varepsilon_{33} &
\gamma_{23} & \gamma_{13} & \gamma_{12}
\end{bmatrix}^{\mathsf T},
\qquad
\gamma_{ij}=2\varepsilon_{ij}\quad(i\ne j).
```

The implementation converts $\gamma_{ij}$ to $\varepsilon_{ij}$ before evaluating the coupling.
Consequently, a value in the fourth component is not directly $\varepsilon_{23}$; the tensor
component is one half of that value.

### Implemented cubic prescribed-strain density

For a cubic magnetostriction law with constants $B_1$ and $B_2$, the implemented energy density
is

```{math}
:label: eq-mel-b1b2-density
e_{\mathrm{mel}}
=
B_1\left(\varepsilon_{11}m_1^2+
\varepsilon_{22}m_2^2+
\varepsilon_{33}m_3^2\right)
+2B_2\left(\varepsilon_{12}m_1m_2+
\varepsilon_{13}m_1m_3+
\varepsilon_{23}m_2m_3\right).
```

The factor $2$ is required because the equation is written with tensor shear components while
the public load uses engineering shear. There is no hidden conversion of $B_1$ or $B_2$ and no
hidden factor of $\mu_0$ in the energy density.

### Effective field

The field follows the FullMag SI variational convention:

```{math}
:label: eq-mel-field
\mathbf H_{\mathrm{mel}}
=
-\frac{1}{\mu_0M_s}
\frac{\partial e_{\mathrm{mel}}}{\partial\mathbf m}.
```

For the first component, the exact implemented expression is

```{math}
:label: eq-mel-field-component
H_{\mathrm{mel},1}
=
-\frac{2B_1\varepsilon_{11}m_1
+2B_2(\varepsilon_{12}m_2+\varepsilon_{13}m_3)}
{\mu_0M_s},
```

The second and third components are obtained by cyclic permutation. The native implementations
evaluate the three components directly; they do not approximate the field by a scalar anisotropy
constant.

### Energy reduction

For an FDM cell volume $V_i$ and active-cell indicator $a_i$, the total energy is

```{math}
:label: eq-mel-fdm-energy
E_{\mathrm{mel}}^{\mathrm{FDM}}
=
\sum_{i=1}^{N}a_i\,e_{\mathrm{mel},i}V_i.
```

For FEM, the prescribed-strain CPU and GPU paths use the resolved lumped nodal integration
weight $w_i^{\mathrm{lump}}$:

```{math}
:label: eq-mel-fem-energy
E_{\mathrm{mel}}^{\mathrm{FEM}}
=
\sum_{i=1}^{N}a_i\,e_{\mathrm{mel},i}w_i^{\mathrm{lump}}.
```

These reductions are not interchangeable unless the mesh, active mask, material field, strain
field, and integration weights are identical.

### Semantic mechanics modes that are not executable yet

The Python API describes the intended mechanics extensions. They are documented here so that
their meaning is not confused with the currently executable prescribed-strain kernel.

Small-strain kinematics and linear constitutive response would be

```{math}
:label: eq-mel-small-strain
\varepsilon_{ij}(\mathbf u)
=\frac12\left(\frac{\partial u_i}{\partial x_j}
+\frac{\partial u_j}{\partial x_i}\right),
\qquad
\sigma_{ij}=C_{ijkl}\left(\varepsilon_{kl}-
\varepsilon^{\mathrm{mag}}_{kl}\right).
```

The quasistatic mode describes the equilibrium equation

```{math}
:label: eq-mel-equilibrium
\nabla\cdot\boldsymbol{\sigma}=\mathbf 0,
```

and elastodynamics describes

```{math}
:label: eq-mel-elastodynamics
\rho\,\ddot{\mathbf u}
=\nabla\cdot\boldsymbol{\sigma}+\mathbf f.
```

At this revision these equations define serialized mechanics intent only. The FEM planner
rejects both modes, and the public `LLG`/`TimeEvolution` constructors do not accept a mechanics
mode argument. They must not be presented as a runnable coupled solver.

(mel-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $m_i$ | Cartesian component of reduced magnetization | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\boldsymbol{\varepsilon}^{\mathrm{eng}}$ | engineering-Voigt strain input | $1$ |
| $\varepsilon_{ij}$ | tensor strain component | $1$ |
| $\gamma_{ij}$ | engineering shear strain $2\varepsilon_{ij}$ | $1$ |
| $B_1$ | diagonal cubic magnetoelastic constant | $\mathrm{Pa}$ |
| $B_2$ | shear cubic magnetoelastic constant | $\mathrm{Pa}$ |
| $e_{\mathrm{mel}}$ | local magnetoelastic energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm{mel}}$ | total magnetoelastic energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm{mel}}$ | magnetoelastic effective field | $\mathrm{A\,m^{-1}}$ |
| $i$ | cell or node index | $1$ |
| $N$ | number of realized cells or nodes | $1$ |
| $a_i$ | active magnetic-cell/node indicator | $1$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $w_i^{\mathrm{lump}}$ | FEM lumped nodal integration weight | $\mathrm{m^3}$ |
| $\mathbf u$ | mechanical displacement | $\mathrm{m}$ |
| $\boldsymbol{\sigma}$ | Cauchy stress tensor | $\mathrm{Pa}$ |
| $C_{ijkl}$ | elastic stiffness tensor | $\mathrm{Pa}$ |
| $\rho$ | mass density | $\mathrm{kg\,m^{-3}}$ |
| $\mathbf f$ | body-force density | $\mathrm{N\,m^{-3}}$ |
| $\lambda_s$ | isotropic saturation magnetostriction parameter | $1$ |

(mel-assumptions-and-validity)=
## Assumptions and validity

* The implemented field/energy path assumes small strain and receives strain externally.
* The magnetization normalization belongs to the surrounding dynamics contract; the interaction
  does not renormalize $\mathbf m$ inside its field formula.
* $M_s$ must be finite and positive wherever the field is evaluated. FEM uses the resolved
  per-node value when available and falls back to the uniform material value.
* A cubic law requires finite $B_1$ and $B_2$ in pascals. The Python `lambda_s` value is not
  silently converted to $B_1/B_2$.
* Uniform strain is broadcast to all active cells/nodes. Per-cell or per-node strain must have
  exactly six values per realized location.
* Inactive FDM cells and nonmagnetic FEM nodes contribute zero field and zero energy.
* The elastic energy, equilibrium solve, displacement update, and mechanical inertia equations
  are semantic extensions, not operations performed by the current prescribed-strain kernel.

(mel-python-api)=
## Python authoring and complete parameter contract

### Public workflow boundary: stages versus the mechanics graph

The public `fm.study(...).stages` API is the correct way to express an ordered relaxation/run
pipeline. The following block is valid stage authoring, but intentionally does **not** claim to
be a magnetoelastic simulation: the current `StudyBuilder` has no registration methods for
`ElasticBody`, `MagnetostrictionLaw`, or `MechanicalLoad`.

```python
# %% Valid stage pipeline; mechanics graph integration is not available yet
import fullmag as fm

study = fm.study("magnetoelastic-stage-boundary")
study.engine("fem")
study.exchange()
study.cell(2.0e-9, 2.0e-9, 2.0e-9)
body = study.geometry(fm.Box(40.0e-9, 40.0e-9, 2.0e-9), name="film")
body.Ms = 1.0e6
body.Aex = 15.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(
    stage_id="relax",
    dt=1.0e-15,
    tolT=1.0e-6,
    max_steps=10,
)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

This code proves only the stage sequencing contract. It does not attach magnetoelastic physics.
The missing registration/lowering path is an explicit API limitation, not a reason to fabricate
a stage example with disconnected objects.

### Complete Python object graph and lowering inspection

The following Jupyter-compatible block is the authoritative copyable example for the currently
available magnetoelastic Python graph. It constructs a magnetic body, elastic body, cubic law,
prescribed-strain load, and coupling, then inspects the resulting `ProblemIR`. It is a lowering
example; it is not evidence that the current stage builder can execute the graph.

```python
# %% Imports and geometry
import json
import fullmag as fm

nm = 1.0e-9
strip = fm.Box(size=(40 * nm, 40 * nm, 2 * nm), name="strip")

# %% Magnetic and elastic materials
magnetic_material = fm.Material(
    name="CoFeB",
    Ms=1.0e6,
    A=15.0e-12,
    alpha=0.02,
)
elastic_material = fm.ElasticMaterial(
    name="CoFeB-elastic",
    C11=2.41e11,
    C12=1.46e11,
    C44=1.12e11,
    rho=8900.0,
)

magnet = fm.Ferromagnet(
    name="free_layer",
    geometry=strip,
    material=magnetic_material,
    m0=fm.texture.uniform((1.0, 0.0, 0.0)),
)
elastic_body = fm.ElasticBody(
    name="elastic_body",
    geometry=strip,
    elastic_material=elastic_material,
)

# %% Cubic law, prescribed strain, and coupling graph
law = fm.MagnetostrictionLaw(
    name="cubic-law",
    kind="cubic",
    B1=-6.95e6,
    B2=-5.62e6,
)
load = fm.MechanicalLoad(
    kind="prescribed_strain",
    strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0),
)
coupling = fm.Magnetoelastic(
    magnet="free_layer",
    body="elastic_body",
    law="cubic-law",
)

# %% Low-level physical snapshot -> ProblemIR
snapshot = fm.Problem(
    name="magnetoelastic-prescribed-strain",
    magnets=[magnet],
    energy=[fm.Exchange(), coupling],
    elastic_materials=[elastic_material],
    elastic_bodies=[elastic_body],
    magnetostriction_laws=[law],
    mechanical_loads=[load],
    study=fm.TimeEvolution(
        dynamics=fm.LLG(fixed_timestep=1.0e-13),
        outputs=[
            fm.SaveField("H_mel", every=1.0e-12),
            # E_mel is a native interaction quantity; the public scalar selector
            # currently exposes the aggregate energy under E_total.
            fm.SaveScalar("E_total", every=1.0e-12),
        ],
    ),
)
problem_ir = snapshot.to_ir(include_geometry_assets=False)
assert problem_ir["energy_terms"][1]["kind"] == "magnetoelastic"
assert problem_ir["mechanical_loads"][0]["kind"] == "prescribed_strain"
print(json.dumps(problem_ir, indent=2))
```

### Exhaustive parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Magnetoelastic.magnet` | `str` | `required` | $1$ | non-empty string | magnetic-body reference | graph validation | `energy_terms[].magnet` |
| `Magnetoelastic.body` | `str` | `required` | $1$ | non-empty string | elastic-body reference | FEM planner validation | `energy_terms[].body` |
| `Magnetoelastic.law` | `str` | `required` | $1$ | non-empty string | magnetostriction-law reference | graph validation | `energy_terms[].law` |
| `ElasticMaterial.name` | `str` | `required` | $1$ | non-empty string | elastic material identifier | FEM prescribed-strain metadata | `elastic_materials[].name` |
| `ElasticMaterial.C11` | `float` | `required` | $\mathrm{Pa}$ | strictly positive | cubic stiffness constant C11 | FEM prescribed-strain | `elastic_materials[].c11` |
| `ElasticMaterial.C12` | `float` | `required` | $\mathrm{Pa}$ | strictly positive | cubic stiffness constant C12 | FEM prescribed-strain | `elastic_materials[].c12` |
| `ElasticMaterial.C44` | `float` | `required` | $\mathrm{Pa}$ | strictly positive | cubic shear stiffness constant C44 | FEM prescribed-strain | `elastic_materials[].c44` |
| `ElasticMaterial.rho` | `float` | `required` | $\mathrm{kg\,m^{-3}}$ | strictly positive | mass density | serialized metadata; mechanics solve deferred | `elastic_materials[].density` |
| `ElasticMaterial.eta_mech` | `float or None` | `None` | $1$ | non-negative when supplied | mechanical damping metadata | serialized metadata; mechanics solve deferred | `elastic_materials[].mechanical_damping` |
| `ElasticBody.name` | `str` | `required` | $1$ | non-empty string | elastic-body identifier | FEM prescribed-strain | `elastic_bodies[].name` |
| `ElasticBody.geometry` | `Geometry` | `required` | $1$ | geometry exposes a stable name | mechanical-domain geometry reference | FEM shared mesh | `elastic_bodies[].geometry` |
| `ElasticBody.elastic_material` | `ElasticMaterial` | `required` | $1$ | serialized by material name | elastic material binding | FEM prescribed-strain | `elastic_bodies[].elastic_material` |
| `MagnetostrictionLaw.name` | `str` | `required` | $1$ | non-empty string | law identifier | graph validation | `magnetostriction_laws[].name` |
| `MagnetostrictionLaw.kind` | `str` | `cubic` | $1$ | cubic or isotropic | law family | cubic path; isotropic FEM conversion rejected | `magnetostriction_laws[].kind` |
| `MagnetostrictionLaw.B1` | `float or None` | `None` | $\mathrm{Pa}$ | required for cubic | diagonal cubic coupling constant | prescribed-strain B1/B2 path | `magnetostriction_laws[].b1` |
| `MagnetostrictionLaw.B2` | `float or None` | `None` | $\mathrm{Pa}$ | required for cubic | shear cubic coupling constant | prescribed-strain B1/B2 path | `magnetostriction_laws[].b2` |
| `MagnetostrictionLaw.lambda_s` | `float or None` | `None` | $1$ | required for isotropic | isotropic saturation magnetostriction | semantic object; FEM conversion rejected | `magnetostriction_laws[].lambda_s` |
| `MechanicalBoundaryCondition.kind` | `str` | `required` | $1$ | one of four supported kinds | boundary operator kind | serialized; mechanics solve deferred | `mechanical_bcs[].kind` |
| `MechanicalBoundaryCondition.surface` | `str` | `required` | $1$ | non-empty string | boundary marker/name | serialized; mechanics solve deferred | `mechanical_bcs[].surface` |
| `MechanicalBoundaryCondition.u` | `Sequence[float] or None` | `None` | $\mathrm{m}$ | exactly three values when used | prescribed displacement | serialized; mechanics solve deferred | `mechanical_bcs[].u` |
| `MechanicalBoundaryCondition.t` | `Sequence[float] or None` | `None` | $\mathrm{Pa}$ | exactly three values when used | prescribed traction | serialized; mechanics solve deferred | `mechanical_bcs[].t` |
| `MechanicalLoad.kind` | `str` | `required` | $1$ | body_force, prescribed_strain, or prescribed_stress | load family | prescribed strain has native FEM plan | `mechanical_loads[].kind` |
| `MechanicalLoad.f` | `Sequence[float] or None` | `None` | $\mathrm{N\,m^{-3}}$ | required for body force; three values | body-force density | semantic-only; mechanics solve deferred | `mechanical_loads[].f` |
| `MechanicalLoad.strain` | `Sequence[float] or None` | `None` | $1$ | exactly six Voigt values | engineering-Voigt prescribed strain | prescribed-strain path | `mechanical_loads[].strain` |
| `MechanicalLoad.stress` | `Sequence[float] or None` | `None` | $\mathrm{Pa}$ | exactly six Voigt values | engineering-Voigt prescribed stress | semantic-only; mechanics solve deferred | `mechanical_loads[].stress` |
| `PrescribedStrain` | no parameters | — | $1$ | mode marker | external deformation with no mechanical solve | semantic object; not wired to LLG | `study.dynamics.mechanics` |
| `QuasistaticElasticity.max_picard_iterations` | `int` | `3` | $1$ | at least one | Picard iteration cap | semantic object; FEM planner rejects | `study.dynamics.mechanics.max_picard_iterations` |
| `QuasistaticElasticity.picard_tolerance` | `float` | `1e-6` | $1$ | strictly positive | Picard convergence tolerance | semantic object; FEM planner rejects | `study.dynamics.mechanics.picard_tolerance` |
| `Elastodynamics.mechanical_dt` | `float or None` | `None` | $\mathrm{s}$ | strictly positive when supplied | mechanical integration step | semantic object; FEM planner rejects | `study.dynamics.mechanics.mechanical_dt` |

(mel-problem-ir)=
## Python-to-`ProblemIR` representation

The low-level example lowers the coupling as a reference graph. The coupling term contains names,
not duplicated material or strain data:

```json
{
  "energy_terms": [
    {"kind": "exchange"},
    {"kind": "magnetoelastic", "magnet": "free_layer", "body": "elastic_body", "law": "cubic-law"}
  ],
  "elastic_materials": [
    {"name": "CoFeB-elastic", "c11": 241000000000.0, "c12": 146000000000.0, "c44": 112000000000.0, "density": 8900.0}
  ],
  "elastic_bodies": [
    {"name": "elastic_body", "geometry": "strip", "elastic_material": "CoFeB-elastic"}
  ],
  "magnetostriction_laws": [
    {"kind": "cubic", "name": "cubic-law", "b1": -6950000.0, "b2": -5620000.0}
  ],
  "mechanical_loads": [
    {"kind": "prescribed_strain", "strain": [0.0001, 0.0, 0.0, 0.0, 0.0, 0.0]}
  ]
}
```

The Python graph is therefore useful for inspecting names, values, units, and validation. It is
not a promise that every serialized mechanics mode can be selected by the current public stage
builder or accepted by every planner lane.

(mel-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the original Python graph: names, scalar values, six-component load vectors,
law family, and optional boundary/mode metadata. Normalization serializes values into the named
`ProblemIR` collections without silently converting `lambda_s` into $B_1/B_2$.

Resolved execution adds the planner-selected solver, device, precision, mesh, active-node mask,
resolved $M_s$, resolved strain storage, and energy-reduction policy. These are not determined by
the Python constructor alone.

Validation errors include duplicate or unknown references, missing cubic $B_1/B_2$, missing load
data, malformed six-component arrays, and invalid positive constants. Unsupported combinations
include an FDM planner request with a complete Magnetoelastic term, FEM
quasistatic/elastodynamic mode requests, and isotropic FEM magnetostriction without a physically
justified conversion. Each is an error, not a silent CPU fallback.

(mel-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU

The native reference routines support `Uniform` and `PerCell` prescribed strain. Each active cell
converts engineering shear to tensor shear, evaluates `h_mel_single`, adds the result into the
effective-field buffer, and evaluates the same density through `e_mel_density_single`. The total
is multiplied by the cell volume. A strain array with the wrong cell count is rejected by the
native routine. The public planner currently rejects the complete term, so native source support
must not be reported as a runnable public FDM lane.

### FDM GPU

The FP64 and FP32 CUDA effective-field kernels receive $B_1$, $B_2$, diagonal strain, and tensor
shear values as scalar kernel inputs. Their magnetoelastic branch is fused into effective-field
combination. The FP64 and FP32 branches are separate precision realizations; source presence is
not device execution evidence, and the current planner rejection prevents a complete public
FDM qualification claim.

### FEM CPU

`resolve_fem_magnetoelastic_plan` accepts exactly one term, a known elastic body/material/law
graph, a prescribed-strain load, and the prescribed-strain mechanics boundary. The CPU evaluator
zeros its field and energy buffers, skips nonmagnetic nodes, uses a per-node $M_s$ when present,
converts engineering shear, evaluates the exact field components, and accumulates energy with
the MFEM lumped weight. It does not assemble or solve a mechanical stiffness system.

### FEM GPU

The CUDA path allocates and uploads six-component strain data, keeps magnetization, $M_s$, masks,
lumped weights, coupling constants, and output buffers in device state, then evaluates field and
block energy in `magnetoelastic_field_energy_blocks_kernel`. The upload routine rejects missing or
undersized device storage and requires six values per node. A host FEM fallback is not implied by
kernel availability.

(mel-observables)=
## Observables

| Observable | Kind | SI unit | Availability |
|---|---|---|---|
| `H_mel` | vector field | $\mathrm{A\,m^{-1}}$ | Prescribed-strain realization when the selected lane materializes the field. |
| `E_mel` | scalar | $\mathrm{J}$ | Native prescribed-strain reduction; request `E_total` through the current public `SaveScalar` selector. |
| `e_mel` | local scalar density | $\mathrm{J\,m^{-3}}$ | Native FDM/FEM evaluator; public output legality remains planner-controlled. |

(mel-implementation-mapping)=
## Implementation mapping

| Layer | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Python coupling | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Magnetoelastic` | named coupling term and IR reference |
| Python elastic material | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticMaterial` | $C_{11}$, $C_{12}$, $C_{44}$, density, damping metadata |
| Python elastic body | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticBody` | geometry/material graph node |
| Python law | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MagnetostrictionLaw` | cubic/isotropic law validation and IR |
| Python load | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MechanicalLoad` | six-component strain/stress validation |
| Python mechanics modes | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class PrescribedStrain`, `class QuasistaticElasticity`, `class Elastodynamics` | semantic mode objects; not wired into `LLG` |
| FDM CPU | `crates/fullmag-engine/src/magnetoelastic.rs` | `h_mel_single`, `e_mel_density_single`, `h_mel_field`, `e_mel_total` | field, density, mask, and cell-volume reduction |
| FDM GPU FP64 | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | fused prescribed-strain branch |
| FDM GPU FP32 | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | fused prescribed-strain branch |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `resolve_fem_magnetoelastic_plan` | graph checks, prescribed-strain legality, rejection semantics |
| FEM CPU | `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp` | `compute_magnetoelastic_field` | nodal field and lumped energy |
| FEM GPU kernel | `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu` | `magnetoelastic_field_energy_blocks_kernel` | device field and block energy |
| FEM GPU upload | `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp` | `gpu_magnetoelastic_upload_strain` | six-component strain transfer |

(mel-validation)=
## Validation and qualification

| Check | Evidence | Status boundary |
|---|---|---|
| Python graph serialization | `ElasticMaterial.to_ir`, `ElasticBody.to_ir`, `MagnetostrictionLaw.to_ir`, `MechanicalLoad.to_ir`, and `Magnetoelastic.to_ir` | API contract; not solver execution |
| FDM field derivative | `h_mel_consistent_with_energy_gradient` | Native unit/sign evidence; public FDM planner still rejects the complete term |
| FDM zero cases | `h_mel_zero_strain_gives_zero_field`, `h_mel_zero_coupling_gives_zero_field`, `e_mel_zero_strain_gives_zero_energy` | Native kernel evidence |
| FEM planner acceptance | `fem_prescribed_strain_magnetoelastic_lowers_to_native_plan` | Planner contract; no executed-device qualification |
| FEM planner rejection | `fem_quasistatic_magnetoelastic_is_explicitly_rejected_until_mechanics_solver_exists`, `fem_elastodynamic_magnetoelastic_is_explicitly_rejected_until_mechanics_solver_exists` | Fail-closed mechanics boundary |
| FEM CPU/GPU source | `compute_magnetoelastic_field`, `magnetoelastic_field_energy_blocks_kernel` | Implementation evidence; runtime parity requires managed execution |

The source and Python tests establish structural, algebraic, and planner contracts. They do not
prove a GPU device executed the kernel, do not prove cross-backend parity, and do not qualify a
coupled displacement solve.

(mel-limitations)=
## Limitations and deferred work

* The public `StudyBuilder` cannot currently register the complete elastic/magnetostriction/load
  graph, so a full magnetoelastic `study.stages` script is not yet available.
* The current executable interaction is prescribed strain; displacement is not solved.
* FEM quasistatic and elastodynamic mechanics are rejected by the planner.
* The FEM planner rejects isotropic magnetostriction when no physically justified $B_1/B_2$
  conversion is available.
* The FDM public planner rejects the complete Magnetoelastic `ProblemIR` despite native field and
  energy routines and CUDA kernel branches.
* Finite deformation, nonlinear elasticity, thermal expansion, plasticity, and inter-body
  magnetoelastic coupling are outside this contract.
* Source presence and skipped/device-capable tests are not executed-device qualification.

(mel-scientific-bibliography)=
## Scientific bibliography

1. Y. C. Shu, M. P. Lin, and K. C. Wu, “Micromagnetic modeling of magnetostrictive materials
   under intrinsic stress,” *Mechanics of Materials* **36**, 975 (2004).
2. C. Y. Liang *et al.*, “Finite difference magnetoelastic simulator,” *npj Computational
   Materials* (2023). [doi:10.1038/s41524-023-01073-w](https://doi.org/10.1038/s41524-023-01073-w).
3. C. M. Pfeiler *et al.*, “A decoupled, convergent and fully linear algorithm for the
   Landau–Lifshitz–Gilbert equation with magnetoelastic effects,” arXiv:2309.00605 (2023).
4. FullMag canonical semantics: `docs/physics/0700-shared-magnetoelastic-semantics.md`.

(mel-source-code-index)=
## Source-code and test index

| Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Magnetoelastic` | coupling constructor and IR reference | `Magnetoelastic.to_ir` |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticMaterial` | elastic material validation and IR | `ElasticMaterial.to_ir` |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticBody` | geometry/material graph binding | `ElasticBody.to_ir` |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MagnetostrictionLaw` | cubic/isotropic law validation | `MagnetostrictionLaw.to_ir` |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MechanicalLoad` | Voigt load validation and IR | `MechanicalLoad.to_ir` |
| `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class PrescribedStrain` | semantic no-solve mode object | `PrescribedStrain.to_ir` |
| `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class QuasistaticElasticity` | semantic Picard settings | `QuasistaticElasticity.to_ir` |
| `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class Elastodynamics` | semantic mechanical timestep | `Elastodynamics.to_ir` |
| `crates/fullmag-engine/src/magnetoelastic.rs` | `h_mel_single` | FDM local field | `h_mel_consistent_with_energy_gradient` |
| `crates/fullmag-engine/src/magnetoelastic.rs` | `e_mel_density_single` | FDM local density | `e_mel_zero_strain_gives_zero_energy` |
| `crates/fullmag-engine/src/magnetoelastic.rs` | `e_mel_total` | FDM cell-volume reduction | `e_mel_total_consistent_with_density` |
| `crates/fullmag-plan/src/fem.rs` | `resolve_fem_magnetoelastic_plan` | FEM planner boundary | acceptance/rejection tests |
| `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp` | `compute_magnetoelastic_field` | FEM CPU field and energy | native contract |
| `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu` | `magnetoelastic_field_energy_blocks_kernel` | FEM GPU field and block energy | CUDA contract |
| `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp` | `gpu_magnetoelastic_upload_strain` | FEM GPU strain upload | fail-closed upload checks |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | FDM GPU FP64 fused branch | source-only evidence |
| `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | FDM GPU FP32 fused branch | source-only evidence |
