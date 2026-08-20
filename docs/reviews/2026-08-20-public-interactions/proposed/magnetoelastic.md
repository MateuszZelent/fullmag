---
title: Magnetoelastic interaction — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/magnetoelastic/index.md
  - public_docs/site/python-api/interactions/magnetoelastic.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Magnetoelastic interaction

## Audit verdict

| Area | Verdict |
|---|---|
| Prescribed-strain B1/B2 energy and field | Correct for tensor strain expressed in the same cubic crystal frame as magnetization. |
| Engineering-shear conversion | Correctly identified, but must remain visible next to every Voigt API. |
| Mechanics scope | Correctly admits that quasistatic and elastodynamic objects are semantic-only. |
| Python example | Incorrect: constructor keywords and required object references do not match the live dataclasses. |
| Public workflow | Partial: no complete stage-builder mechanics graph exists. |
| Completeness | Needs crystal-frame transforms, fixed-strain versus fixed-stress thermodynamics, and two-way energy tests. |

## Concrete API defects in the current example

The present constructor block uses names such as `density_kg_m3`, `c11`, `c12`, `c44`, `material`,
`b1`, and `b2`. The live dataclasses require:

- `ElasticMaterial(name, C11, C12, C44, rho, eta_mech=None)`;
- `ElasticBody(name, geometry, elastic_material)`;
- `MagnetostrictionLaw(name, kind="cubic", B1=..., B2=...)`.

The current example therefore must not be described as copyable or validated. This is exactly the
kind of error that executing all documentation code blocks would catch.

## Required corrections

1. Change the summary status to `partial` until a complete stage-first mechanics graph can be
   authored, serialized, planned, and executed.
2. Replace the invalid constructor example with an exact signature-checked IR fixture and clearly
   label it non-executable at study level.
3. State that the cubic formula assumes magnetization and strain components in the material's
   cubic crystal frame. Add an explicit rotation contract for laboratory-frame strain.
4. Separate prescribed strain, prescribed stress, quasistatic elasticity, and elastodynamics.
   They are different thermodynamic/numerical problems, not selectable names for one kernel.
5. Record the exact engineering-shear Voigt order in API, IR, source maps, and rendered tables.
6. Do not convert an isotropic `lambda_s` to `B1/B2` without elastic constants, symmetry, and an
   explicit approximation policy.

## Proposed canonical prescribed-strain model

For reduced magnetization components `m_i` and small tensor strain `epsilon_ij` in a cubic crystal
frame,

```math
w_{mel}
=B_1(\epsilon_{11}m_1^2+\epsilon_{22}m_2^2+\epsilon_{33}m_3^2)
+2B_2(\epsilon_{12}m_1m_2+\epsilon_{13}m_1m_3+\epsilon_{23}m_2m_3).
```

The field is

```math
H_{mel}=-\frac{1}{\mu_0M_s}\frac{\partial w_{mel}}{\partial m},
```

or componentwise

```math
H_{mel,1}
=-\frac{2B_1\epsilon_{11}m_1
+2B_2(\epsilon_{12}m_2+\epsilon_{13}m_3)}{\mu_0M_s},
```

with cyclic permutations for the other components.

The total prescribed-strain coupling energy is

```math
E_{mel}=\int_{\Omega_m}w_{mel}\,dV.
```

### Voigt convention

The public six-component strain vector is engineering-shear Voigt order

```math
(\epsilon_{11},\epsilon_{22},\epsilon_{33},
2\epsilon_{23},2\epsilon_{13},2\epsilon_{12}).
```

The factor of two must be removed before insertion into the tensor formula. Stress Voigt entries do
not use that factor in the same way and must not be passed through the strain converter.

## Crystal-frame transform

Let `R` map crystal-frame vectors into the laboratory frame. Before evaluating the cubic law,

```math
m_c=R^T m_{lab},
\qquad
\epsilon_c=R^T\epsilon_{lab}R.
```

Compute `H_c` from the cubic energy and transform back:

```math
H_{lab}=R H_c.
```

The current docs implicitly use `R = I`. That assumption must be explicit until oriented elastic
bodies/materials are supported.

## Relation to magnetostriction constants

Under the common cubic convention consistent with the energy above,

```math
B_1=-\frac{3}{2}\lambda_{100}(C_{11}-C_{12}),
\qquad
B_2=-3\lambda_{111}C_{44}.
```

Published data use multiple sign and strain conventions. A conversion helper must require the
source convention and must never silently infer `B1/B2` from one scalar `lambda_s`.

## Prescribed strain versus prescribed stress

- **Prescribed strain:** `epsilon` is an external input and the coupling energy above is evaluated
  directly.
- **Prescribed stress:** strain is not known a priori. The mechanical equilibrium/enthalpy problem
  must be solved with elastic energy and boundary conditions.
- **Quasistatic two-way coupling:** displacement and magnetization are iterated or solved in a
  coupled system while preserving one total energy.
- **Elastodynamics:** displacement/velocity have their own time integration, mass density,
  damping, stability limits, and coupling work balance.

The public page must not present source files for local prescribed-strain kernels as evidence that
the last three modes are executable.

## Correct constructor-level IR fixture

```python
# Constructor and IR fixture; not yet a complete stage-first mechanics workflow.
import fullmag as fm

nm = 1.0e-9
substrate_geometry = fm.Box(200 * nm, 100 * nm, 20 * nm, name="substrate_geometry")

silicon = fm.ElasticMaterial(
    name="silicon",
    C11=1.66e11,
    C12=6.39e10,
    C44=7.96e10,
    rho=2329.0,
)
substrate = fm.ElasticBody(
    name="substrate",
    geometry=substrate_geometry,
    elastic_material=silicon,
)
law = fm.MagnetostrictionLaw(
    name="cubic_b1_b2",
    kind="cubic",
    B1=2.4e6,
    B2=3.1e6,
)
load = fm.MechanicalLoad(
    kind="prescribed_strain",
    strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0),
)
coupling = fm.Magnetoelastic(
    magnet="cobalt_layer",
    body="substrate",
    law="cubic_b1_b2",
)
```

This fixture should live on the API page only while the stage builder lacks mechanics registration.
The generic “all examples must be stage-first” validator needs an explicit, narrow IR-fixture class
rather than fence tricks or pseudo-runnable code.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `B1`, `B2` | cubic magnetoelastic coefficients | Pa = J/m³ |
| `epsilon_ij` | small tensor strain | 1 |
| `gamma_ij = 2 epsilon_ij` | engineering shear strain | 1 |
| `C11`, `C12`, `C44` | cubic elastic stiffnesses | Pa |
| `lambda100`, `lambda111` | cubic magnetostriction constants | 1 |
| `u` | displacement | m |
| `sigma` | Cauchy stress | Pa |
| `H_mel` | magnetoelastic field | A/m |
| `E_mel` | coupling energy | J |

## Capability statement

| Scope | Recommended status |
|---|---|
| Constructor/IR graph | `semantic_only` until signature tests and graph round-trip pass |
| FDM prescribed-strain kernels | implementation evidence only until planner path is qualified |
| FEM CPU prescribed strain | `reference_executable` or `production_executable` only for the exact shared-mesh contract |
| FEM GPU prescribed strain | requires executed-device upload, field, and energy evidence |
| Quasistatic elasticity | `semantic_only` / `unsupported` |
| Elastodynamics | `semantic_only` / `unsupported` |

## Required validation suite

1. **Pure normal strain:** compare analytic easy-direction energies and fields.
2. **Pure shear:** verify engineering-to-tensor shear conversion and B2 sign.
3. **Directional derivative:** compare coupling-energy finite differences with `H_mel`.
4. **Frame covariance:** rotate `m`, strain, and crystal frame together.
5. **B/lambda conversion:** compare known material constants under an explicitly named convention.
6. **FEM interpolation:** test nonuniform strain and material fields on distorted meshes.
7. **CPU/GPU:** compare field and energy for all six independent strain components.
8. **Two-way future gate:** verify total magnetic + elastic + coupling energy and reciprocal work
   transfer before claiming quasistatic or dynamic coupling.

## Recommended extensions

- oriented cubic elastic/magnetostrictive material frames;
- complete stage-builder registration for elastic materials, bodies, loads, boundaries, and modes;
- quasistatic monolithic/block solver with energy-consistent Jacobians;
- elastodynamics with stable subcycling and reciprocal work accounting;
- piezoelectric/electrostrictive loading as separate coupled-physics modules;
- experiment-facing conversion tools for `lambda`, `B`, stiffness, stress, and strain conventions.

## Bibliography

- E. du Trémolet de Lacheisserie, *Magnetostriction: Theory and Applications of
  Magnetoelasticity*, CRC Press, 1993.
- J. B. Restorff et al., *Journal of Applied Physics* **111**, 023905 (2012), DOI
  `10.1063/1.3674318`.
- R. C. O'Handley, *Modern Magnetic Materials*, Wiley, 2000.
