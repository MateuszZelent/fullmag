---
title: Magnetoelastic Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0700-shared-magnetoelastic-semantics.md
---

(magnetoelastic-api-problem-statement)=
# Magnetoelastic Python API

The magnetoelastic API describes one coupling energy between a magnetic body,
an elastic body, and a magnetostriction law. Elastic material, body, boundary,
load, and mechanics-mode objects lower to separate ProblemIR sections. The
current executable public realization is prescribed-strain coupling. FDM has
the local field and energy kernels; native FEM has a prescribed-strain plan.
Quasistatic and elastodynamic mechanics are semantic objects, not proof of an
available mechanics solve.

(magnetoelastic-api-governing-equations)=
## Governing equations

For reduced magnetization $\mathbf m$, tensor strain $\varepsilon_{ij}$, and
cubic constants $B_1,B_2$:

```{math}
:label: eq-magnetoelastic-api-energy
e_{\mathrm{mel}} =
B_1(\varepsilon_{11}m_1^2+\varepsilon_{22}m_2^2+\varepsilon_{33}m_3^2)
+2B_2(\varepsilon_{12}m_1m_2+\varepsilon_{13}m_1m_3+\varepsilon_{23}m_2m_3).
```

MechanicalLoad.strain uses engineering-shear Voigt order
$(\varepsilon_{11},\varepsilon_{22},\varepsilon_{33},2\varepsilon_{23},
2\varepsilon_{13},2\varepsilon_{12})$. The last three entries are therefore
twice the tensor shear components.

```{math}
:label: eq-magnetoelastic-api-field
\mathbf H_{\mathrm{mel}} =
-\frac{1}{\mu_0 M_s}\frac{\partial e_{\mathrm{mel}}}{\partial\mathbf m}.
```

```{math}
:label: eq-magnetoelastic-api-field-x
H_{\mathrm{mel},1} =
-\frac{2B_1m_1\varepsilon_{11}
+2B_2(m_2\varepsilon_{12}+m_3\varepsilon_{13})}{\mu_0M_s}.
```

```{math}
:label: eq-magnetoelastic-api-total-energy
E_{\mathrm{mel}}=\sum_{c\in\Omega_{\mathrm{active}}}
e_{\mathrm{mel},c}V_c.
```

The small-strain mechanical relation is

```{math}
:label: eq-magnetoelastic-api-small-strain
\varepsilon_{ij}(\mathbf u)=\frac12
(\partial_j u_i+\partial_i u_j),\qquad
\sigma_{ij}=C_{ijkl}(\varepsilon_{kl}-\varepsilon^{\mathrm{mag}}_{kl}).
```

(magnetoelastic-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_{ij}$ | tensor strain | $1$ |
| $\gamma_{ij}=2\varepsilon_{ij}$ | engineering shear strain | $1$ |
| $\varepsilon^{\mathrm{mag}}_{ij}$ | magnetostrictive eigenstrain | $1$ |
| $\sigma_{ij}$ | stress tensor | $\mathrm{Pa}$ |
| $C_{11},C_{12},C_{44}$ | cubic stiffness constants | $\mathrm{Pa}$ |
| $\rho$ | mass density | $\mathrm{kg\,m^{-3}}$ |
| $\eta_{\mathrm{mech}}$ | mechanical damping coefficient | $1$ |
| $B_1,B_2$ | cubic magnetoelastic constants | $\mathrm{Pa}$ |
| $\lambda_s$ | isotropic saturation magnetostriction | $1$ |
| $\mathbf u$ | displacement | $\mathrm{m}$ |
| $\mathbf v=\dot{\mathbf u}$ | mechanical velocity | $\mathrm{m\,s^{-1}}$ |
| $\mathbf f$ | body-force density | $\mathrm{N\,m^{-3}}$ |
| $\mathbf H_{\mathrm{mel}}$ | magnetoelastic field | $\mathrm{A\,m^{-1}}$ |
| $e_{\mathrm{mel}}$ | coupling energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm{mel}}$ | coupling energy | $\mathrm{J}$ |
| $V_c$ | cell or element volume | $\mathrm{m^3}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |

(magnetoelastic-api-assumptions-and-validity)=
## Assumptions and validity

The contract is small-strain, linear-elastic, and saturated-magnetization
micromagnetics. It excludes finite deformation, nonlinear constitutive laws,
thermal expansion, plasticity, and magnetomechanical hysteresis. Cubic laws
provide B1 and B2 directly. Isotropic lambda_s is preserved semantically, but
current FEM planning refuses an unjustified conversion to B1 and B2.

(magnetoelastic-api-python-api)=
## Python API and stage-first availability

The mechanics graph is currently documented as an API/IR contract only. The public stage builder
does not yet register magnetoelastic bodies, loads, or couplings, so this page does not publish a
disconnected Python constructor example. A copyable example belongs here only after a complete
study and ordered stage workflow can execute it.

(magnetoelastic-api-example)=
````python
# %% Magnetoelastic coupling constructor (IR contract only)
import fullmag as fm

nm = 1e-9

# Constructor-level example: magnetoelastic coupling between ferromagnet and elastic body
# Note: full study execution requires stage builder mechanics graph support
coupling = fm.Magnetoelastic(
    magnet="cobalt_layer",
    body="substrate",
    law="cubic_b1_b2",
)
print(f"Magnetoelastic coupling (constructor): {coupling}")

# ElasticMaterial and ElasticBody are defined for the mechanics graph contract
elastic_mat = fm.ElasticMaterial(
    name="silicon",
    density_kg_m3=2329.0,
    c11=1.66e11,
    c12=6.39e10,
    c44=7.96e10,
)
print(f"ElasticMaterial: {elastic_mat}")

elastic_body = fm.ElasticBody(name="substrate", material="silicon")
print(f"ElasticBody: {elastic_body}")

# Magnetostriction law parameters (cubic)
law = fm.MagnetostrictionLaw(
    name="cubic_b1_b2",
    b1=2.4e6,
    b2=3.1e6,
)
print(f"MagnetostrictionLaw: {law}")
# Full study example pending stage builder mechanics graph support
````

(magnetoelastic-api-parameter-reference)=
## Exhaustive parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| ElasticMaterial.name | str | required | $1$ | non-empty and unique | material identifier | FDM/FEM metadata | elastic_materials[].name |
| ElasticMaterial.C11 | float | required | $\mathrm{Pa}$ | strictly positive | stiffness C11 | FEM prescribed strain | elastic_materials[].c11 |
| ElasticMaterial.C12 | float | required | $\mathrm{Pa}$ | strictly positive | stiffness C12 | FEM prescribed strain | elastic_materials[].c12 |
| ElasticMaterial.C44 | float | required | $\mathrm{Pa}$ | strictly positive | shear stiffness C44 | FEM prescribed strain | elastic_materials[].c44 |
| ElasticMaterial.rho | float | required | $\mathrm{kg\,m^{-3}}$ | strictly positive | mass density | FEM metadata; dynamics deferred | elastic_materials[].density |
| ElasticMaterial.eta_mech | float or None | None | $1$ | non-negative when supplied | mechanical damping | serialized metadata; dynamics deferred | elastic_materials[].mechanical_damping |
| ElasticBody.name | str | required | $1$ | non-empty and unique | body identifier | FEM prescribed strain | elastic_bodies[].name |
| ElasticBody.geometry | Geometry | required | — | exposes geometry_name | mechanical-domain geometry | FEM shared mesh | elastic_bodies[].geometry |
| ElasticBody.elastic_material | ElasticMaterial | required | — | serialized by name | material binding | FEM prescribed strain | elastic_bodies[].elastic_material |
| MagnetostrictionLaw.name | str | required | $1$ | non-empty and unique | law identifier | FDM/FEM metadata | magnetostriction_laws[].name |
| MagnetostrictionLaw.kind | str | cubic | $1$ | cubic or isotropic | law family | cubic executable; isotropic FEM conversion rejected | magnetostriction_laws[].kind |
| MagnetostrictionLaw.B1 | float or None | None | $\mathrm{Pa}$ | required for cubic | first coupling constant | prescribed strain | magnetostriction_laws[].b1 |
| MagnetostrictionLaw.B2 | float or None | None | $\mathrm{Pa}$ | required for cubic | second coupling constant | prescribed strain | magnetostriction_laws[].b2 |
| MagnetostrictionLaw.lambda_s | float or None | None | $1$ | required for isotropic | saturation magnetostriction | semantic-only FEM | magnetostriction_laws[].lambda_s |
| Magnetoelastic.magnet | str | required | $1$ | non-empty; known magnet | magnetic-body reference | planner validation | energy_terms[].magnet |
| Magnetoelastic.body | str | required | $1$ | non-empty; known body | elastic-body reference | FEM prescribed strain | energy_terms[].body |
| Magnetoelastic.law | str | required | $1$ | non-empty; known law | law reference | planner validation | energy_terms[].law |
| MechanicalBoundaryCondition.kind | str | required | $1$ | one of four allowed kinds | boundary operator | serialized; solve deferred | mechanical_bcs[].kind |
| MechanicalBoundaryCondition.surface | str | required | $1$ | non-empty | boundary marker | FEM metadata | mechanical_bcs[].surface |
| MechanicalBoundaryCondition.u | Sequence[float] or None | None | $\mathrm{m}$ | three values for prescribed displacement | displacement data | semantic-only | mechanical_bcs[].u |
| MechanicalBoundaryCondition.t | Sequence[float] or None | None | $\mathrm{Pa}$ | three values for prescribed traction | traction data | semantic-only | mechanical_bcs[].t |
| MechanicalLoad.kind | str | required | $1$ | body_force, prescribed_strain, or prescribed_stress | load family | prescribed strain executable | mechanical_loads[].kind |
| MechanicalLoad.f | Sequence[float] or None | None | $\mathrm{N\,m^{-3}}$ | required for body_force | body-force density | dynamics deferred | mechanical_loads[].f |
| MechanicalLoad.strain | Sequence[float] or None | None | $1$ | six Voigt values | engineering-shear strain | prescribed strain | mechanical_loads[].strain |
| MechanicalLoad.stress | Sequence[float] or None | None | $\mathrm{Pa}$ | six Voigt values | Voigt stress | dynamics deferred | mechanical_loads[].stress |
| PrescribedStrain | no parameters | — | — | mode marker | external deformation; no solve | semantic mode | study.dynamics.mechanics |
| QuasistaticElasticity.max_picard_iterations | int | 3 | $1$ | at least 1 | Picard cap | semantic-only; FEM rejected | study.dynamics.mechanics.max_picard_iterations |
| QuasistaticElasticity.picard_tolerance | float | 1e-6 | $1$ | positive | Picard tolerance | semantic-only; FEM rejected | study.dynamics.mechanics.picard_tolerance |
| Elastodynamics.mechanical_dt | float or None | None | $\mathrm{s}$ | positive when supplied | mechanical step | semantic-only; FEM rejected | study.dynamics.mechanics.mechanical_dt |

(magnetoelastic-api-problem-ir)=
## Python to ProblemIR lowering

Magnetoelastic.to_ir emits only references:

```json
{
  "kind": "magnetoelastic",
  "magnet": "free_layer",
  "body": "substrate_body",
  "law": "cubic_ms"
}
```

ElasticMaterial, ElasticBody, MagnetostrictionLaw, MechanicalBoundaryCondition,
and MechanicalLoad each lower independently to their named top-level IR
collections. The coupling term does not duplicate constants or strain data.
This preserves graph identity and allows planner errors to identify the missing
reference.

(magnetoelastic-api-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the named magnet, body, law, mechanics mode, and load.
Resolved execution is the validated IR graph plus backend plan. Validation errors
include unknown references, duplicate coupling terms, malformed six-component
Voigt arrays, missing required load data, invalid positive parameters, and
inconsistent mechanics metadata.

Unsupported combinations are explicit: FEM quasistatic and elastodynamic modes
are rejected; FEM isotropic magnetostriction is rejected without a justified
B1/B2 mapping; and FDM public planning currently rejects the full magnetoelastic
ProblemIR term. No lossy fallback is silently selected.

(magnetoelastic-api-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU

The engine supports uniform and per-cell prescribed Voigt strain. It converts
engineering shear to tensor shear, evaluates h_mel_single, adds the field to
the effective field buffer, and reduces the same density to E_mel. Inactive
cells receive zero field and zero energy. The public planner does not currently
qualify the complete Magnetoelastic ProblemIR path.

### FDM GPU

FDM CUDA contains prescribed-strain B1/B2 field paths in FP64 and FP32. They
share the Voigt convention and units with the CPU equations. Kernel presence is
not end-to-end planner or executed-device qualification.

### FEM CPU

Native FEM supports one prescribed-strain term on a shared mesh. It requires a
prescribed-strain MechanicalLoad, a cubic law, valid elastic references, and
prescribed-strain mechanics. Quasistatic and elastodynamic mechanics are
rejected by the planner.

### FEM GPU

Native FEM GPU owns prescribed-strain upload, node-local field evaluation, and
final energy reductions. It obeys the same one-term, same-mesh, cubic-law
restrictions. Source existence is not executed-device qualification.

(magnetoelastic-api-implementation-mapping)=
## Implementation mapping

| Layer | Repository path and stable symbol | Responsibility |
|---|---|---|
| Python energy | packages/fullmag-py/src/fullmag/model/energy.py, class Magnetoelastic | coupling IR reference |
| Python mechanics | packages/fullmag-py/src/fullmag/model/mechanics.py, class ElasticMaterial | elastic constants |
| Python body | same file, class ElasticBody | geometry/material reference |
| Python law | same file, class MagnetostrictionLaw | cubic/isotropic law |
| Python load | same file, class MechanicalLoad | mechanical input |
| Python boundary | same file, class MechanicalBoundaryCondition | boundary data |
| Python modes | packages/fullmag-py/src/fullmag/model/dynamics.py, class QuasistaticElasticity | mechanics intent |
| IR validation | crates/fullmag-ir/src/validation.rs, validate_magnetoelastic | graph and value checks |
| FEM planner | crates/fullmag-plan/src/fem.rs, resolve_fem_magnetoelastic_plan | FEM legality and lowering |
| FDM field | crates/fullmag-engine/src/magnetoelastic.rs, h_mel_single | local field |
| FDM energy | same file, e_mel_density_single | local energy density |
| FEM GPU upload | backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp, gpu_magnetoelastic_upload_strain | strain transfer |
| FEM GPU kernel | backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu, fullmag_cuda_magnetoelastic_field_energy_blocks | field and energy partials |

(magnetoelastic-api-validation)=
## Validation and qualification

This page requires source-map validation, execution of all Python blocks, IA
tests, scientific-contract tests, strict Sphinx rendering, and rendered HTML
validation. Current lane status:

| Lane | Status | Boundary |
|---|---|---|
| FDM CPU | partial | engine functions exist; public planner path is not qualified |
| FDM GPU | partial | CUDA kernels exist; public planner/device proof is separate |
| FEM CPU | partial | prescribed strain exists; quasistatic/dynamic rejected |
| FEM GPU | partial | upload/kernel/energy paths exist; device proof is separate |

E_mel is valid only after a prescribed strain is resolved. Mechanical kinetic and
elastic energies are not inferred from prescribed-strain data.

(magnetoelastic-api-limitations)=
## Limitations and deferred work

- no finite-strain or nonlinear elasticity;
- no thermal or plastic coupling;
- FDM public planner support is not end-to-end qualified;
- FEM supports prescribed strain only;
- isotropic lambda_s has no automatic FEM B1/B2 conversion;
- no executable hybrid FDM/FEM transfer;
- no fresh executed-device GPU qualification claim.

(magnetoelastic-api-scientific-bibliography)=
## Scientific bibliography

1. R. C. O’Handley, Modern Magnetic Materials, Wiley (2000), magnetostriction
   and magnetoelastic anisotropy chapters.
2. A. Hubert and R. Schäfer, Magnetic Domains, Springer (1998), magnetoelastic
   domain energetics.
3. Fullmag contracts: docs/physics/0700-shared-magnetoelastic-semantics.md,
   docs/physics/0710-fdm-magnetoelastic-small-strain.md, and
   docs/physics/0720-fem-magnetoelastic-small-strain-mfem-gpu.md.

(magnetoelastic-api-source-code-index)=
## Source-code index

| Claim | File | Stable symbol |
|---|---|---|
| coupling object | packages/fullmag-py/src/fullmag/model/energy.py | class Magnetoelastic |
| elastic material | packages/fullmag-py/src/fullmag/model/mechanics.py | class ElasticMaterial |
| elastic body | packages/fullmag-py/src/fullmag/model/mechanics.py | class ElasticBody |
| law | packages/fullmag-py/src/fullmag/model/mechanics.py | class MagnetostrictionLaw |
| boundary | packages/fullmag-py/src/fullmag/model/mechanics.py | class MechanicalBoundaryCondition |
| load | packages/fullmag-py/src/fullmag/model/mechanics.py | class MechanicalLoad |
| prescribed mode | packages/fullmag-py/src/fullmag/model/dynamics.py | class PrescribedStrain |
| quasistatic mode | packages/fullmag-py/src/fullmag/model/dynamics.py | class QuasistaticElasticity |
| dynamic mode | packages/fullmag-py/src/fullmag/model/dynamics.py | class Elastodynamics |
| IR validation | crates/fullmag-ir/src/validation.rs | validate_magnetoelastic |
| FEM resolution | crates/fullmag-plan/src/fem.rs | resolve_fem_magnetoelastic_plan |
| local field | crates/fullmag-engine/src/magnetoelastic.rs | h_mel_single |
| local energy | crates/fullmag-engine/src/magnetoelastic.rs | e_mel_density_single |
| FEM GPU upload | backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp | gpu_magnetoelastic_upload_strain |
| FEM GPU kernel | backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu | fullmag_cuda_magnetoelastic_field_energy_blocks |

