---
title: Inter-region couplings Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: public_docs/site/physics/interactions/inter-region-couplings/index.md
---

(public-docs-python-api-interactions-inter-region-couplings)=
# Inter-region couplings Python API

This page documents CouplingRegistry and the stage-first study.couplings facade. The
physical equations and four-lane matrix are owned by the interaction page.

(iapi-problem-statement)=
## Physical problem

The API represents region exchange, RKKY, and interlayer exchange as distinct tagged
couplings. A separate magnetic object is never implicitly exchange-connected.

(iapi-governing-equations)=
## Governing equations

The shared surface energy is

```{math}
:label: eq-irc-api-surface
\sigma_{\mathrm{surf}}=-J_1(\mathbf m_a\cdot\mathbf m_b)-J_2(\mathbf m_a\cdot\mathbf m_b)^2.
```

The region coefficient is

```{math}
:label: eq-irc-api-link
A_{ab}=s\,\frac{2A_aA_b}{A_a+A_b},\qquad s\geq0.
```

(iapi-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf m_a,\mathbf m_b$ | reduced endpoint magnetizations | $1$ |
| $J_1$ | bilinear surface coefficient | $\mathrm{J\,m^{-2}}$ |
| $J_2$ | biquadratic surface coefficient | $\mathrm{J\,m^{-2}}$ |
| $A_a,A_b$ | adjacent exchange stiffnesses | $\mathrm{J\,m^{-1}}$ |
| $A_{ab}$ | realized region-link stiffness | $\mathrm{J\,m^{-1}}$ |
| $s$ | harmonic-mean scale | $1$ |

(iapi-assumptions-and-validity)=
## Assumptions and validity

Python validates finite scalars and endpoint shape but does not calculate surface areas or
execute a solver. Runtime currently materializes only FDM CUDA region-to-region exchange.
Other enabled runtime combinations fail closed.

(iapi-python-api)=
## Complete Python API

### Stage-first executable example

```python
# %% Stage-first region coupling
import fullmag as fm

nm = 1e-9
study = fm.study("api_region_exchange")
study.engine("fdm")
study.device("cuda", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

# %% Geometry, state, and regions
body = study.geometry(fm.Box(80 * nm, 20 * nm, 4 * nm), name="bilayer")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
left = body.add_region("left", fm.Box(40 * nm, 20 * nm, 4 * nm))
right = body.add_region("right", fm.Box(40 * nm, 20 * nm, 4 * nm))

# %% Coupling and stages
study.couplings.exchange(left, right, mode="explicit", inter_exchange=13e-12)
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk23",
    dt_initial=1e-15,
    dt_min=1e-17,
    dt_max=1e-14,
    max_err=1e-7,
    relax_alpha=1.0,
    tolT=1e-6,
    max_steps=50_000,
)
study.stages.add_run(stage_id="run", until=1e-9)
```

### Authoring-only surface fragment


### Parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| exchange.source, target | endpoint-like | required | $1$ | valid endpoint resolution | coupling endpoints | FDM CUDA region pair | source/target |
| exchange.mode | str | harmonic_mean | $1$ | harmonic_mean, explicit, disabled | region coefficient policy | FDM CUDA | parameters.mode |
| exchange.scale | float or None | None | $1$ | finite, non-negative | harmonic multiplier | FDM CUDA | parameters.scale |
| exchange.inter_exchange | float or None | None | $\mathrm{J\,m^{-1}}$ | finite; explicit requires value | region stiffness | FDM CUDA if non-negative | parameters.inter_exchange |
| exchange.coupling_id | str or None | derived | $1$ | non-empty when supplied | stable identifier | authoring | coupling_id |
| exchange.enabled | bool | True | $1$ | boolean | activate entry | disabled ignored by planner | enabled |
| exchange.capability_policy | str | require_runtime | $1$ | two enum values | runtime/export policy | all authoring lanes | capability_policy |
| rkky.J1 | float | required | $\mathrm{J\,m^{-2}}$ | finite, signed | bilinear coefficient | authored only | parameters.j1 |
| interlayer_exchange.J1 | float | required | $\mathrm{J\,m^{-2}}$ | finite, signed | bilinear coefficient | authored only | parameters.j1 |
| interlayer_exchange.J2 | float or None | None | $\mathrm{J\,m^{-2}}$ | finite when supplied | biquadratic coefficient | authored only | parameters.j2 |
| CouplingEndpoint.object.object_name | str | required | $1$ | non-empty | whole object | endpoint.object | object |
| CouplingEndpoint.region.region_id | str | required | $1$ | non-empty | named region | FDM CUDA region pair | object, region_id |
| CouplingEndpoint.surface.selector | str | required | $1$ | six canonical faces | selected face | authored surface terms | object, selector |

(iapi-problem-ir)=
## ProblemIR lowering

A region exchange entry contains its kind, endpoints, enabled state, parameters, and
capability policy. RKKY and interlayer exchange use different tagged parameter variants.

```json
{
  "kind": "exchange",
  "source": {"kind": "region", "object": "bilayer", "region_id": "bilayer:left"},
  "target": {"kind": "region", "object": "bilayer", "region_id": "bilayer:right"},
  "parameters": {"kind": "exchange", "mode": "explicit", "inter_exchange": 1.3e-11},
  "capability_policy": "require_runtime"
}
```

| Python operation | Canonical IR | Normalization |
|---|---|---|
| CouplingEndpoint.object(name) | endpoint kind object | non-empty name |
| CouplingEndpoint.region(object, region_id) | endpoint kind region | non-empty names |
| CouplingEndpoint.surface(object, selector) | endpoint kind surface | selector lower-cased |
| exchange(..., mode=...) | coupling kind exchange | mode lower-cased |
| rkky(..., J1=...) | coupling kind rkky | finite j1 |
| interlayer_exchange(..., J1, J2) | coupling kind interlayer_exchange | optional j2 |
| capability_policy | coupling capability policy | two enum values |

(iapi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the Python coupling graph before planning. Resolved execution records
backend, device, precision, numeric region indices, and runtime materialization. Export
preserves endpoint kinds and signed values. Validation rejects empty names, bad selectors,
unknown modes or policies, non-finite scalars, invalid mode/parameter combinations, and
surface methods receiving non-surface endpoints. Unsupported enabled require_runtime
combinations are planner errors; authored_only is not executable strict planning.
Validation errors and unsupported combinations are reported explicitly and do not trigger
an implicit fallback.

(iapi-discrete-realization)=
## Discrete realization

FDM CUDA maps region IDs to numeric region-mask indices and emits exchange-link overrides.
FDM CPU, FEM CPU, and FEM GPU currently reject enabled runtime couplings. Surface terms
have no discrete runtime realization in the current planner.

(iapi-implementation-mapping)=
## Implementation mapping

CouplingEndpoint and CouplingRegistry own Python validation and lowering.
StudyCouplingsHandle is the stage-first facade. CouplingIR and its tagged enums are the
canonical Rust representation. validate_region_owned_planning enforces runtime legality,
and materialize_region_exchange_couplings implements the FDM CUDA region path.

(iapi-validation)=
## Validation

Focused Python tests cover endpoint serialization, RKKY surface restrictions, region
exchange lowering, interlayer lowering, region removal, and authoring round-trip. Planner
tests cover unsupported surface terms, authored-only strict rejection, disabled entries,
and the supported FDM CUDA region path. Future surface runtime work requires energy-sign,
area/refinement, and device-runtime evidence.

(iapi-limitations)=
## Limitations

The API does not yet provide surface quadrature, curved-contact geometry, spacer transport,
automatic layer-pair generation, or executable surface terms. The stage facade can author
them, but strict planning reports their unsupported status.

(iapi-scientific-bibliography)=
## Scientific bibliography

- Grünberg et al., Physical Review Letters 57, 2442 (1986),
  DOI 10.1103/PhysRevLett.57.2442.
- Parkin et al., Physical Review Letters 64, 2304 (1990),
  DOI 10.1103/PhysRevLett.64.2304.
- Fullmag specification: docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md.

(iapi-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Endpoint constructors | packages/fullmag-py/src/fullmag/model/couplings.py | class CouplingEndpoint | endpoint validation and IR | Python |
| Registry methods | packages/fullmag-py/src/fullmag/model/couplings.py | class CouplingRegistry | public coupling API | Python |
| Interlayer lowering | packages/fullmag-py/src/fullmag/model/couplings.py | interlayer_exchange | j1/j2 tagged payload | Python |
| Study facade | packages/fullmag-py/src/fullmag/world.py | class StudyCouplingsHandle | stage-first entry point | Python |
| Canonical coupling | crates/fullmag-ir/src/model.rs | struct CouplingIR | ProblemIR identity | IR |
| Runtime gate | crates/fullmag-plan/src/validate.rs | validate_region_owned_planning | fail-closed capability check | planner |
| FDM realization | crates/fullmag-plan/src/fdm.rs | materialize_region_exchange_couplings | numeric link overrides | FDM GPU |
