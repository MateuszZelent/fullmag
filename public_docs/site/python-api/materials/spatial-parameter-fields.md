---
title: Spatial Parameter Fields
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-spatial-parameter-fields)=
# Spatial Parameter Fields

```{versionchanged} development
Expanded from a constructor stub into the complete authoring, precedence, unit, lowering, and backend-realization contract for spatial material fields.
```

(python-api-materials-spatial-parameter-fields-problem-statement)=
## Contract

Spatial parameter fields replace a single material scalar by a deterministic field defined over a
magnetic object or one of its object-owned regions. They are authored as typed data, not arbitrary
Python callbacks, so the request can be serialized, validated, reproduced, and materialized by FDM
or FEM planners.

A field assignment has five independent pieces of intent:

1. the owning magnetic object;
2. the optional object-region restriction;
3. the material parameter being replaced;
4. the typed field definition;
5. priority and conflict policy when assignments overlap.

The field is an override of the corresponding base material value. It is not added to the scalar
and it does not implicitly create another magnetic object, interface coupling, or exchange break.

(python-api-materials-spatial-parameter-fields-governing-equations)=
## Governing equations

```{math}
:label: eq-material-spatial-effective

q_{\mathrm{IR}} = \mathrm{material-spatial-effective}(\text{qualified inputs})
```

For a scalar material parameter $p$, the base material supplies $p_0$. An active field assignment
$a$ supplies $p_a(\mathbf x)$. After ownership, region membership, priority, and conflict resolution,
the realized value is

```{math}
:label: eq-material-spatial-effective-2
p_{\mathrm{eff}}(\mathbf x)=
p_0+w_{a_*}(\mathbf x)\bigl(p_{a_*}(\mathbf x)-p_0\bigr),
\qquad 0\le w_{a_*}(\mathbf x)\le 1,
```

Here $w_{a_*}=0$ when no assignment owns the point. A sharp transition has binary weight
$w_{a_*}\in\{0,1\}$; a weighted transition blends the winning field with the base value. For
`Ms` and `Aex`, omitting `material_transition` resolves to
`mesh_relative(cells=3, scope="boundary")`, so the default boundary width is three local mesh
spacings and points on both sides of the boundary can have $0<w_{a_*}<1$.

The built-in analytic field families are:

```{math}
:label: eq-material-spatial-constant
p_{\mathrm{constant}}(\mathbf x)=p_c,
```

```{math}
:label: eq-material-spatial-linear
p_{\mathrm{linear}}(\mathbf x)=p_b+\mathbf g\cdot\mathbf x_f,
```

```{math}
:label: eq-material-spatial-radial
p_{\mathrm{radial}}(\mathbf x)=
\begin{cases}
p_{\mathrm{in}}, & \lVert\mathbf x_f-\mathbf c\rVert\le r,\\
p_{\mathrm{out}}, & \lVert\mathbf x_f-\mathbf c\rVert>r,
\end{cases}
```

where $\mathbf x_f$ is evaluated in the authored `object` or `world` frame. A sampled field instead
references an immutable asset and declares its component count, mesh location, and unit metadata;
sampled material-field materialization is currently authoring-only and is rejected by the planner.

(python-api-materials-spatial-parameter-fields-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

| Symbol | Meaning | SI unit |
|---|---|---:|
| $p_0$ | base material value | parameter-dependent |
| $p_{\mathrm{eff}}$ | value consumed by the realized operator | parameter-dependent |
| $p_{a_*}$ | field value from the winning assignment | parameter-dependent |
| $p_b$ | linear-field base value | parameter-dependent |
| $p_c$ | constant-field value | parameter-dependent |
| $p_{\mathrm{in}}$ | radial inside value | parameter-dependent |
| $p_{\mathrm{out}}$ | radial outside value | parameter-dependent |
| $\mathbf g$ | spatial gradient of a scalar parameter | parameter unit per metre |
| $\mathbf x_f$ | position evaluated in the declared frame | $\mathrm m$ |
| $\mathbf c$ | radial centre in the declared frame | $\mathrm m$ |
| $r$ | radial transition radius | $\mathrm m$ |
| $w_{a_*}$ | transition weight for the winning assignment | $1$ |
| `priority` | integer precedence input | $1$ |
| `component_count` | number of stored components per sample | $1$ |

For example, an `Ms` field has values in $\mathrm{A\,m^{-1}}$, while its linear gradient has units
$\mathrm{A\,m^{-2}}$. `Aex` values use $\mathrm{J\,m^{-1}}$ and their spatial gradients use
$\mathrm{J\,m^{-2}}$. The `unit` string records the authored value-unit metadata without checking
its dimensional consistency; the gradient unit follows from the spatial derivative and is not a
second free choice.

(python-api-materials-spatial-parameter-fields-assumptions-and-validity)=
## Assumptions and validity

- Field values must be finite. The `unit` string is preserved as non-empty metadata when supplied;
  the Python factories do not check parameter-specific dimensions or convert units. Authors must
  provide SI-valued numbers according to the parameter table, while planner/runtime validation
  remains responsible for lane-specific legality.
- `frame` is exactly `object` or `world`. Object-frame fields move with the object; world-frame
  fields remain fixed in laboratory coordinates.
- Scalar parameters use scalar fields. Directional parameters such as `AnisotropyAxis` require a
  three-component constant or sampled representation supported by the selected lane.
- `sampled` fields require a non-empty asset identity, `component_count >= 1`, an explicit location
  from `cell`, `node`, `element`, or `quadrature`, and a non-empty unit. They are currently
  authoring-only: `evaluate_parameter_field` rejects sampled values before materialization.
- Region membership is evaluated before conflict resolution. A region-local assignment does not
  affect points outside that region.
- Equal-precedence overlaps with `conflict_policy="error"` fail closed. They are not resolved by
  insertion order.
- Mesh cardinality, interpolation, discontinuity handling, and device support are planner/runtime
  responsibilities and remain separate from successful Python construction.

### Supported material parameter names

The canonical authoring vocabulary is:

| Python name | ProblemIR name | Value type | Typical SI unit |
|---|---|---|---:|
| `Ms` | `ms` | scalar | $\mathrm{A\,m^{-1}}$ |
| `Aex` | `aex` | scalar | $\mathrm{J\,m^{-1}}$ |
| `Alpha` | `alpha` | scalar | $1$ |
| `Ku1`, `Ku2` | `ku1`, `ku2` | scalar | $\mathrm{J\,m^{-3}}$ |
| `AnisotropyAxis` | `anisotropy_axis` | three-vector | $1$ |
| `Kc1`, `Kc2`, `Kc3` | `kc1`, `kc2`, `kc3` | scalar | $\mathrm{J\,m^{-3}}$ |
| `Dind`, `Dbulk` | `dind`, `dbulk` | scalar | $\mathrm{J\,m^{-2}}$ |

Aliases such as `A`, `Aex`, `alpha`, `anisU`, and case variants are normalized before lowering.
The serialized form always uses the canonical ProblemIR name.

(python-api-materials-spatial-parameter-fields-python-api)=
## Python API

### Typed field factories and parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `MaterialParameterField.constant.value` | `float \| tuple[float,float,float]` | required | parameter-dependent | finite scalar or finite three-vector | authored constant value | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.value` |
| `MaterialParameterField.constant.unit` | `str \| None` | `None` | $1$ | non-empty metadata when supplied; no dimensional check | authored value unit metadata | all lanes preserve metadata; runtime does not convert | `material_parameter_fields[].value.unit` |
| `MaterialParameterField.linear.base` | `float` | required | parameter-dependent | finite scalar | affine-field base value | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.base` |
| `MaterialParameterField.linear.gradient` | `tuple[float,float,float]` | required | parameter unit per metre | three finite components | spatial gradient | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.gradient` |
| `MaterialParameterField.linear.frame` | `str` | `"object"` | $1$ | exactly `object` or `world` | coordinate frame for evaluation | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.frame` |
| `MaterialParameterField.linear.unit` | `str \| None` | `None` | $1$ | non-empty metadata when supplied; no dimensional check | affine-field value unit metadata | all lanes preserve metadata; runtime does not convert | `material_parameter_fields[].value.unit` |
| `MaterialParameterField.radial.center` | `tuple[float,float,float]` | required | $\mathrm m$ | three finite coordinates | radial centre in the declared frame | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.center` |
| `MaterialParameterField.radial.radius` | `float` | required | $\mathrm m$ | finite and positive | radial profile radius | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.radius` |
| `MaterialParameterField.radial.inside` | `float` | required | parameter-dependent | finite scalar inside radius | inside value | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.inside` |
| `MaterialParameterField.radial.outside` | `float` | required | parameter-dependent | finite scalar outside radius | outside value | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.outside` |
| `MaterialParameterField.radial.frame` | `str` | `"object"` | $1$ | exactly `object` or `world` | coordinate frame for evaluation | FDM/FEM CPU analytic fields; GPU lane checks apply | `material_parameter_fields[].value.frame` |
| `MaterialParameterField.radial.unit` | `str \| None` | `None` | $1$ | non-empty metadata when supplied; no dimensional check | radial-field value unit metadata | all lanes preserve metadata; runtime does not convert | `material_parameter_fields[].value.unit` |
| `MaterialParameterField.sampled.asset_id` | `str` | required | $1$ | non-empty immutable asset identity | reference to sampled data | authoring-only; planner rejects materialization on all lanes | `material_parameter_fields[].value.asset_id` |
| `MaterialParameterField.sampled.component_count` | `int` | required | $1$ | integer >= 1 | components per sample | authoring-only; planner rejects materialization on all lanes | `material_parameter_fields[].value.component_count` |
| `MaterialParameterField.sampled.location` | `str` | required | $1$ | one of `cell`, `node`, `element`, `quadrature` | location of sampled values | authoring-only; planner rejects materialization on all lanes | `material_parameter_fields[].value.location` |
| `MaterialParameterField.sampled.unit` | `str` | required | $1$ | non-empty metadata; no dimensional check | sampled-value unit metadata | authoring-only; planner rejects materialization on all lanes | `material_parameter_fields[].value.unit` |

The public convenience namespace `fm.fields` may expose the same typed factories. The serialized
payload is identical; the factory spelling is not a second physical model.

### Assignment controls

| Control | Meaning |
|---|---|
| `parameter` | normalized material parameter name |
| `region` | optional object-owned region limiting support |
| `assignment_id` | stable identity used by round-trip and provenance |
| `priority` | integer precedence input for overlapping assignments |
| `conflict_policy="error"` | reject ambiguous overlap |
| `conflict_policy="higher_priority_wins"` | select the unique highest priority |
| `conflict_policy="min_mesh_size_wins"` | mesh-policy-oriented resolution where supported |

### Complete region-owned gradient example

```python
# %% Build a stage-first FEM study with one region-scoped Ms field
import fullmag as fm

study = fm.study("region_owned_gradient_ms")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="auto",
    size=(300e-9, 180e-9, 120e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=5e-9, maximum_element_size=80e-9)

track = study.geometry(
    fm.Box(size=(200e-9, 80e-9, 5e-9), name="permalloy_track"),
    name="permalloy_track",
)
track.Ms = 800e3
track.Aex = 13e-12
track.alpha = 0.02
track.m = fm.texture.uniform(1.0, 0.0, 0.0)

gradient_window = track.add_region(
    "gradient_window",
    fm.Box(size=(120e-9, 50e-9, 5e-9)),
    priority=10,
)
track.set_material_field(
    "Ms",
    fm.MaterialParameterField.linear(
        base=760e3,
        gradient=(0.0, 1.5e11, 0.0),
        frame="object",
        unit="A/m",
    ),
    region=gradient_window,
    assignment_id="permalloy_track_gradient_window_ms",
    priority=10,
    conflict_policy="error",
)

study.exchange()
study.stages.add_run(stage_id="inspect_material_field", until=1.0e-15)
```

This field changes `Ms` only inside `gradient_window`. The rest of `permalloy_track` retains the
base value `800e3 A/m`. Because the region belongs to the same object, ordinary exchange remains an
intra-object interaction; no inter-object coupling is created.

(python-api-materials-spatial-parameter-fields-problem-ir)=
## ProblemIR

The field remains typed in `material_parameter_fields`; it is not flattened to mesh arrays before
planning. The example above lowers conceptually to:

```json
{
  "assignment_id": "permalloy_track_gradient_window_ms",
  "owner_object": "permalloy_track",
  "region_id": "permalloy_track:gradient_window",
  "parameter": "ms",
  "value": {
    "kind": "linear",
    "base": 760000.0,
    "gradient": [0.0, 150000000000.0, 0.0],
    "frame": "object",
    "unit": "A/m"
  },
  "priority": 10,
  "conflict_policy": "error"
}
```

Requested field identity, frame, region, units, and conflict policy remain visible after
serialization. The resolved mesh-aligned array belongs to execution provenance, not requested
intent.

(python-api-materials-spatial-parameter-fields-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** preserves the factory kind, authored values, coordinate frame, asset identity,
object/region ownership, priority, conflict policy, and assignment ID. **Resolved execution** adds
the concrete mesh location, interpolation/projection rule, normalized field storage, precision,
device placement, and any emitted materialization statistics/provenance. No materialization digest
is currently part of `MaterialParameterAssignmentIR` or the resolved field asset contract.

**Validation errors** reject non-finite data, invalid frames, non-positive radii, unknown parameter
names, invalid sampled locations, empty asset identities, malformed component counts, and unresolved
references. Asset existence and sampled-value loading are not performed by the current factories.
**Unsupported combinations** fail capability checks explicitly; FullMag does not
silently replace a sampled field by a scalar, move a world-frame field into object coordinates, or
fall back from GPU to CPU in strict mode.

Changing geometry, region membership, mesh topology, sampled asset content, or field definition
invalidates the corresponding resolved field provenance. Reusing an old materialized array after
such a change is not a legal round-trip.

(python-api-materials-spatial-parameter-fields-discrete-realization)=
## Discrete realization

| Solver | Device | Realization contract | Qualification boundary |
|---|---|---|---|
| FDM | CPU | evaluate constant, linear, and radial fields on active cells under object/region masks; sampled fields are authoring-only | cell-centre frame transform, overlap policy, cardinality, and stencil use must be tested |
| FDM | GPU | unsupported for region-owned `Ms`, `Aex`, and `Alpha` fields; planner rejects the request before upload | no CUDA material-field upload or no-fallback claim is valid until runtime support and qualification exist |
| FEM | CPU | evaluate analytic fields on the selected FEM representation; sampled fields are authoring-only | interpolation, projection, discontinuities, mass/quadrature ownership, and mesh convergence are explicit |
| FEM | GPU | consume only a resolved FEM field representation that the selected GPU planner/runtime accepts; sampled fields are authoring-only | residency, precision, projection, and reduction parity require executed-device evidence |

A field being representable in Python and ProblemIR is not proof that every parameter, location,
interpolation, or device combination is executable. The planner's capability decision is
authoritative for the requested slice.

### Interfaces and discontinuities

A sharp jump in `Ms`, `Aex`, anisotropy, or DMI is physically and numerically meaningful only with
the consuming interaction's interface contract. In particular:

- exchange uses interface/link or weak-flux treatment rather than pointwise averaging chosen by the
  field API;
- DMI boundary/interface terms remain owned by the DMI formulation;
- a region override does not automatically introduce RKKY or other spacer coupling;
- mesh-relative transitions for `Ms` and `Aex` are explicit authoring policy, not an undocumented
  smoothing pass.

(python-api-materials-spatial-parameter-fields-implementation-mapping)=
## Implementation mapping

- `MaterialParameterField` owns constant, linear, radial, and sampled field payloads.
- `MaterialParameterAssignment` owns object/region scope, canonical parameter name, identity,
  priority, and conflict policy.
- `ObjectRegion` owns local overrides and optional material-transition intent.
- The `Ferromagnet` `material_parameter_fields` collection carries assignments through canonical
  problem lowering.
- FDM/FEM planners and runners own mesh-specific materialization and capability decisions.
- `crates/fullmag-plan/src/material.rs` owns analytic evaluation, transition weighting, and the
  fail-closed sampled-field boundary.
- `crates/fullmag-plan/src/material_transition.rs` resolves the default `Ms`/`Aex` transition.

(python-api-materials-spatial-parameter-fields-validation)=
## Validation

The minimum validation suite is:

1. analytic value checks for constant, linear, and radial factories in object and world frames;
2. exact normalization of parameter aliases to canonical ProblemIR names;
3. region support tests at inside, outside, and boundary points;
4. deterministic overlap tests for every conflict policy and equal-priority failure;
5. sampled asset identity, component-count, location, and mesh-cardinality checks (materialization
   remains unsupported until the asset-loading path exists);
6. scalar-versus-vector compatibility tests;
7. round-trip preservation of IDs, units, frames, priorities, and region references;
8. FDM/FEM refinement tests that separate field interpolation error from operator error;
9. CPU/GPU comparison of materialized arrays before comparing solver trajectories;
10. stale-provenance rejection after geometry, mesh, region, or asset revision changes.

Construction and serialization tests validate authoring. Scientific qualification additionally
requires interaction-specific observables, convergence, and device evidence.

(python-api-materials-spatial-parameter-fields-limitations)=
## Limitations

- Arbitrary Python callables are intentionally not serializable field definitions.
- The current analytic family is constant, linear, and radial; more complex profiles require a
  sampled asset or a separately versioned typed field.
- Sampled-field interpolation is not globally interchangeable between cell, node, element, and
  quadrature locations.
- Object-region v1 supports a bounded set of canonical shapes and realization policies.
- Conflict resolution cannot repair physically inconsistent overlapping material definitions.
- A smooth authored parameter field does not guarantee that the mesh resolves its shortest spatial
  scale; convergence remains the user's and validator's responsibility.

(python-api-materials-spatial-parameter-fields-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
- A. Hubert and R. Schäfer, *Magnetic Domains*, Springer, 1998.
- O. C. Zienkiewicz, R. L. Taylor, and J. Z. Zhu, *The Finite Element Method: Its Basis and
  Fundamentals*, 7th ed., Butterworth-Heinemann, 2013.

(python-api-materials-spatial-parameter-fields-source-code-index)=

## Control Room crosswalk

Status: Scalar magnetic fields are partial; spatial fields and material-law-specific parameters remain not implemented.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Material` | `partial` | Apply material draft; dependent physics and mesh resources become stale |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Material` | `not implemented` | Python-only until implemented |

frontend support is not implemented for spatial material fields and every parameter not rendered by ObjectMaterialPanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx (ObjectMaterialPanel)`.

## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| typed field factories | `packages/fullmag-py/src/fullmag/model/structure.py` | `class MaterialParameterField` | constant, linear, radial, and sampled payloads | constructor and round-trip tests |
| scoped assignment | `packages/fullmag-py/src/fullmag/model/structure.py` | `class MaterialParameterAssignment` | object/region ownership and conflict metadata | region-field tests |
| region overrides | `packages/fullmag-py/src/fullmag/model/structure.py` | `class ObjectRegion` | local material and transition policy | region transition tests |
| canonical object owner | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Ferromagnet` | `material_parameter_fields` collection in the magnetic object graph | problem-lowering tests |
| runnable example | `examples/region_owned_gradient_ms.py` | module-level stage-first study | region-owned FEM gradient scenario | documentation example validation |
