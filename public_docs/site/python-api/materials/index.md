---
title: Materials
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-root)=
# Materials

```{versionchanged} development
Added a decision guide for scalar materials, spatial parameter fields, elastic materials, and magnetostriction laws.
```

Materials assign constitutive parameters to magnetic and mechanical bodies. This family separates
four contracts that should not be conflated:

- a **base magnetic material record** supplies object-wide scalar values and optional mesh-aligned
  compatibility arrays;
- a **spatial parameter field** overrides one parameter over an object or an object-owned region;
- an **elastic material** supplies stiffness, density, and mechanical damping;
- a **magnetostriction law** supplies the magnetic–mechanical coupling coefficients.

```{toctree}
:maxdepth: 1

material
spatial-parameter-fields
elastic-materials
magnetostriction-laws
```

## Which page owns my input?

| Goal | Canonical page | Key boundary |
|---|---|---|
| Assign uniform `Ms`, `Aex`, damping, anisotropy, or DMI to one magnet | {doc}`material` | one base value per owned parameter before regional overrides |
| Define a gradient, radial profile, sampled map, or region-local override | {doc}`spatial-parameter-fields` | typed serializable field plus explicit ownership and conflict policy |
| Describe an elastic body | {doc}`elastic-materials` | mechanical constitutive parameters, density, and frame |
| Couple strain and magnetization through cubic coefficients | {doc}`magnetostriction-laws` | coupling law; mechanics execution remains a separate capability |

## Precedence model

A spatial field or region override replaces the corresponding base value only on its declared
support. It is not added to the base scalar. Overlap is resolved by explicit priority and conflict
policy, not authoring order. The planner then materializes the requested value onto the selected
FDM or FEM representation and records the realized array or coefficient field in provenance.

Material authoring, numerical materialization, and scientific qualification are distinct:

1. Python validates typed values and serializable identities.
2. ProblemIR preserves units, frames, object/region references, and field definitions.
3. The planner checks parameter/location/device capability.
4. The runtime builds or uploads the mesh-aligned representation.
5. Interaction-specific validation establishes whether the resolved field is scientifically
   adequate for the requested observable.

## Common failure modes

- supplying non-SI values to spatial fields: their constructors preserve a non-empty `unit` string
  as metadata but do not validate parameter dimensions or convert units, so authors must provide
  SI-valued numbers;
- interpreting a linear gradient as having the same unit as its value rather than value per metre;
- using a region override to model an interlayer coupling;
- assuming a sampled cell field can be consumed as a nodal or quadrature field without an explicit
  projection contract;
- treating successful serialization as proof of GPU support;
- leaving equal-priority overlapping assignments to insertion order.

Use the detailed pages above for exact constructor fields, ProblemIR destinations, backend
boundaries, and validation requirements.
