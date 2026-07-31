---
title: Inter-region couplings
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md
---

(public-docs-physics-interactions-inter-region-couplings)=
# Inter-region couplings

This page is the canonical owner for coupling magnetic regions that do not share the
ordinary continuous exchange term of one homogeneous discretized body. It covers exchange
across a material-region interface, RKKY surface coupling, and bilinear/biquadratic
interlayer exchange. The Python layer and ProblemIR represent all three. The current
executable planner is narrower: only region-to-region exchange on FDM CUDA is materialized
at runtime. The other combinations fail closed.

(irc-problem-statement)=
## Physical problem

Let $\mathbf m_a$ and $\mathbf m_b$ be reduced magnetizations on two regions or opposing
surfaces. A material boundary inside one conforming body may carry an exchange link whose
coefficient is derived from the two adjacent materials. Two bodies separated by a spacer
cannot acquire such a link implicitly; they require an authored coupling object.

Fullmag distinguishes:

1. **Region exchange**: a link between two named mesh regions, with harmonic_mean,
   explicit, or disabled mode.
2. **RKKY coupling**: a surface-to-surface energy with bilinear coefficient $J_1$.
3. **Interlayer exchange**: a surface-to-surface energy with $J_1$ and optional $J_2$.

An object endpoint denotes an entire magnetic object, a region endpoint denotes a named
subregion of one object, and a surface endpoint denotes one of the canonical faces
top, bottom, left, right, front, or back. Endpoint type is part of the canonical request
and is not inferred from geometry after lowering.

(irc-governing-equations)=
## Governing equations

For opposing surfaces, the bilinear/biquadratic surface energy density is

```{math}
:label: eq-irc-bilinear
\sigma_{\mathrm{surf}}
=-J_1(\mathbf m_a\cdot\mathbf m_b)
-J_2(\mathbf m_a\cdot\mathbf m_b)^2.
```

The total surface contribution is

```{math}
:label: eq-irc-surface-integral
E_{\mathrm{surf}}=\int_{\Gamma_{ab}}\sigma_{\mathrm{surf}}\,\mathrm dS.
```

For two adjacent regions with exchange stiffnesses $A_a$ and $A_b$, the default link
coefficient is the harmonic mean

```{math}
:label: eq-irc-harmonic-mean
A_{ab}^{\mathrm{harm}}=\frac{2A_aA_b}{A_a+A_b}.
```

The explicit mode replaces this value with the authored inter-exchange coefficient; the
disabled mode sets the link coefficient to zero. A non-negative scale multiplies the
harmonic mean:

```{math}
:label: eq-irc-scaled-exchange
A_{ab}=s\,A_{ab}^{\mathrm{harm}},\qquad s\geq0.
```

For any authored coupling energy, the effective field is defined by

```{math}
:label: eq-irc-effective-field
\mathbf H_{a,\mathrm{cpl}}
=-\frac{1}{\mu_0M_{s,a}}\frac{\delta E_{\mathrm{cpl}}}{\delta\mathbf m_a}.
```

The surface expression and the region-link stencil are different discrete operators:
the surface term acts on selected faces, while region exchange modifies links in a
cell-region mask.

(irc-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf m_a,\mathbf m_b$ | reduced magnetization on coupling endpoints | $1$ |
| $M_{s,a}$ | saturation magnetization of endpoint $a$ | $\mathrm{A\,m^{-1}}$ |
| $J_1$ | bilinear surface-coupling coefficient | $\mathrm{J\,m^{-2}}$ |
| $J_2$ | biquadratic surface-coupling coefficient | $\mathrm{J\,m^{-2}}$ |
| $\sigma_{\mathrm{surf}}$ | surface energy density | $\mathrm{J\,m^{-2}}$ |
| $E_{\mathrm{surf}}$ | integrated surface coupling energy | $\mathrm{J}$ |
| $\Gamma_{ab}$ | resolved coupled surface pair | $\mathrm{m^2}$ |
| $A_a,A_b$ | exchange stiffness on adjacent regions | $\mathrm{J\,m^{-1}}$ |
| $A_{ab}^{\mathrm{harm}}$ | harmonic-mean interface stiffness | $\mathrm{J\,m^{-1}}$ |
| $A_{ab}$ | realized region-link stiffness | $\mathrm{J\,m^{-1}}$ |
| $s$ | non-negative harmonic-mean scale | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf H_{a,\mathrm{cpl}}$ | coupling effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf n$ | outward unit normal of a selected face | $1$ |
| $\mathrm dS$ | surface measure | $\mathrm{m^2}$ |
| $r_a,r_b$ | material-region identifiers | $1$ |

(irc-assumptions-and-validity)=
## Assumptions and validity

- J1 and J2 must be finite and may be signed. Scale must be finite and non-negative.
  Inter-exchange must be finite; Python does not impose a sign restriction, while the
  executable FDM planner accepts only a finite non-negative value.
- Surface coupling requires two surface endpoints. Region coupling requires two region
  endpoints for the currently executable FDM path.
- The harmonic mean assumes that the adjacent stiffnesses define a valid interface
  coefficient. It is not a spacer-transport model and is not used for RKKY.
- The API stores endpoint selectors but does not calculate a curved contact area, a
  nearest-neighbour surface map, or self-consistent spacer spin transport.
- Authoring and to_ir prove schema construction only. They do not prove execution,
  convergence, CPU/GPU parity, or physical qualification.

(irc-python-api)=
## Python authoring

### Stage-first executable workflow

This is the public form for an executable FDM CUDA region-exchange request. Runtime support
is selected explicitly, so an unsupported lane produces a planning error instead of
silently dropping the coupling.

```python
# %% Imports, units, and requested runtime
import fullmag as fm

nm = 1e-9
study = fm.study("region_exchange")
study.engine("fdm")
study.device("cuda", precision="double")
study.mode("strict")
study.cell(2 * nm, 2 * nm, 2 * nm)

# %% Magnetic object and named regions
body = study.geometry(fm.Box(80 * nm, 20 * nm, 4 * nm), name="bilayer")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
left = body.add_region("left", fm.Box(40 * nm, 20 * nm, 4 * nm))
right = body.add_region("right", fm.Box(40 * nm, 20 * nm, 4 * nm))

# %% Coupling and ordered execution
study.couplings.exchange(
    source=left,
    target=right,
    mode="explicit",
    inter_exchange=13e-12,
)
study.stages.add_relax(stage_id="relax", tolT=1e-6, max_steps=50_000)
study.stages.add_run(stage_id="run", until=1e-9)
```

The stage facade returns the owning StudyBuilder. RKKY and interlayer exchange use the
same authoring boundary, but their current surface terms are IR-only and fail strict
executable planning.

### Complete registry and endpoint parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| CouplingRegistry.exchange.source | object, ObjectRegion, endpoint, or str | required | $1$ | valid endpoint resolution | source region | FDM CUDA region/region; other enabled lanes reject | couplings[].source |
| CouplingRegistry.exchange.target | object, ObjectRegion, endpoint, or str | required | $1$ | valid endpoint resolution | target region | FDM CUDA region/region; other enabled lanes reject | couplings[].target |
| exchange.mode | str | harmonic_mean | $1$ | three documented enum values | coefficient policy | FDM CUDA region exchange | parameters.mode |
| exchange.scale | float or None | None | $1$ | finite and non-negative; disabled requires zero/None | harmonic multiplier | FDM CUDA region exchange | parameters.scale |
| exchange.inter_exchange | float or None | None | $\mathrm{J\,m^{-1}}$ | finite; required by explicit mode | explicit link stiffness | FDM CUDA when non-negative | parameters.inter_exchange |
| exchange.coupling_id | str or None | derived | $1$ | non-empty when supplied | provenance identifier | authoring all lanes | coupling_id |
| exchange.enabled | bool | True | $1$ | normalized to boolean | enable or disable term | disabled term does not block planning | enabled |
| exchange.capability_policy | str | require_runtime | $1$ | require_runtime or authored_only | runtime requirement | planner fail-closed | capability_policy |
| rkky.J1 | float | required | $\mathrm{J\,m^{-2}}$ | finite and signed | bilinear surface coefficient | authored IR; no executable lane | parameters.j1 |
| interlayer_exchange.J1 | float | required | $\mathrm{J\,m^{-2}}$ | finite and signed | bilinear surface coefficient | authored IR; no executable lane | parameters.j1 |
| interlayer_exchange.J2 | float or None | None | $\mathrm{J\,m^{-2}}$ | finite when supplied | optional biquadratic term | authored IR; no executable lane | parameters.j2 |
| CouplingEndpoint.object.object_name | str | required | $1$ | non-empty | whole-object endpoint | authoring only | endpoint.object |
| CouplingEndpoint.region.region_id | str | required | $1$ | non-empty | named region endpoint | FDM CUDA when both are regions | endpoint.region_id |
| CouplingEndpoint.surface.selector | str | required | $1$ | six canonical face names | selected face | authored surface terms only | endpoint.selector |

Surface selectors are normalized to lower case. Endpoint resolution accepts a CouplingEndpoint,
an ObjectRegion, a named object, or a string object name. The endpoint kind is preserved.

### Surface coupling authoring fragment

This copyable fragment inspects the canonical lowering and does not launch a solver. It is
the correct inspection path while surface terms remain outside the strict runtime matrix.

```python
# %% Surface-coupling fragments; no solver is launched here.
import json
import fullmag as fm

registry = fm.CouplingRegistry()
registry.rkky(
    fm.CouplingEndpoint.surface("layer_a", "top"),
    fm.CouplingEndpoint.surface("layer_b", "bottom"),
    J1=-0.30e-3,
    capability_policy="authored_only",
)
registry.interlayer_exchange(
    fm.CouplingEndpoint.surface("layer_a", "top"),
    fm.CouplingEndpoint.surface("layer_b", "bottom"),
    J1=1.00e-3,
    J2=-0.01e-3,
    capability_policy="authored_only",
)
print(json.dumps(registry.to_ir(), indent=2))
```

(irc-problem-ir)=
## Canonical ProblemIR

The region-exchange example lowers to this tagged coupling entry:

```json
{
  "coupling_id": "exchange:bilayer_left:bilayer_right",
  "kind": "exchange",
  "source": {"kind": "region", "object": "bilayer", "region_id": "bilayer:left"},
  "target": {"kind": "region", "object": "bilayer", "region_id": "bilayer:right"},
  "enabled": true,
  "parameters": {
    "kind": "exchange",
    "mode": "explicit",
    "inter_exchange": 1.3e-11
  },
  "capability_policy": "require_runtime"
}
```

| Python source | ProblemIR destination | Normalization |
|---|---|---|
| exchange(source, target) | couplings[].source/target | endpoint kind and identity preserved |
| mode | couplings[].parameters.mode | lower-case enum |
| scale | parameters.scale | omitted when None; finite and non-negative |
| inter_exchange | parameters.inter_exchange | finite SI scalar; required for explicit |
| rkky(J1) | kind=rkky, parameters.j1 | finite signed SI scalar |
| interlayer_exchange(J1, J2) | kind=interlayer_exchange, parameters.j1/j2 | j2 omitted when None |
| coupling_id | coupling_id | supplied ID or deterministic endpoint-derived ID |
| enabled | enabled | boolean |
| capability_policy | capability_policy | require_runtime or authored_only |

The Rust semantic model keeps CouplingKindIR, CouplingEndpointIR, and
CouplingParametersIR distinct; a surface term is never converted into region exchange.

(irc-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the authored coupling kind, endpoints, signed constants, mode, and
capability policy. Resolved execution adds solver/device/precision, materialized region
indices, and runtime acceptance. Script export must preserve endpoint kind and parameters;
it must not replace RKKY with an equivalent-looking exchange link.

Python validation raises ValueError for unknown modes or policies, empty names, invalid
selectors, non-finite scalars, harmonic mean carrying inter_exchange, explicit mode without
inter_exchange, or disabled mode with nonzero scale. Surface methods reject non-surface
endpoints.

The planner rejects enabled require_runtime couplings on unsupported backends.
authored_only is suitable for export and inspection, but strict executable planning rejects
it by design. There is no silent CPU fallback, surface-to-region coercion, or omission.
Validation errors and unsupported combinations are reported at the Python or planner
boundary before a runtime is started.

(irc-discrete-realization)=
## Discrete realization

### FDM CPU

The planner does not mark an enabled region coupling executable on FDM CPU. Ordinary FDM
exchange remains available, but an authored inter-region coupling with require_runtime
produces a planning error. This is not CPU/GPU parity evidence.

### FDM GPU

FDM CUDA is the only currently materialized lane for enabled region-to-region exchange.
The planner resolves named regions to numeric mask indices and
materialize_region_exchange_couplings generates link overrides. Harmonic mean is scaled,
explicit mode uses inter_exchange, and disabled mode produces zero coupling. RKKY and
interlayer surface terms are not materialized.

### FEM CPU

The strict planner does not materialize any of these authored coupling kinds on FEM CPU. A
future implementation must specify surface trace spaces, interface measure, quadrature,
field projection, energy reduction, and convergence evidence before classification as
implemented.

### FEM GPU

The strict planner does not materialize these authored coupling kinds on FEM GPU. A future
GPU realization must document face ownership, device residency, precision, reduction order,
and device-runtime evidence; source presence alone is not parity.

(irc-implementation-mapping)=
## Implementation mapping

CouplingRegistry owns Python validation and the public canonical payload.
StudyCouplingsHandle exposes it through the stage-first study facade.
validate_region_owned_planning enforces fail-closed capability policy.
materialize_region_exchange_couplings resolves region IDs and generates numeric overrides.
The IR enum family keeps exchange, RKKY, and interlayer exchange separate.

(irc-validation)=
## Validation plan and current evidence

Current evidence covers endpoint normalization, RKKY surface validation, region exchange
lowering, interlayer-exchange lowering, removal of couplings referencing deleted regions,
Rust rejection of unsupported surface terms, authored-only strict rejection, and disabled
coupling acceptance. The executable FDM CUDA lane additionally requires a managed runtime
run recording device identity and materialized region overrides.

Scientific validation must include parallel/antiparallel energy ordering under the sign
convention, interface-refinement convergence, harmonic-mean versus explicit comparison,
zero-energy disabled behavior, surface-area convergence for J1/J2, and matched
CPU-reference/GPU-runtime comparisons once a CPU materializer exists.

(irc-limitations)=
## Limitations

- RKKY and interlayer exchange are representable and exportable but not executable in strict
  planning on any of the four lanes.
- FDM CPU, FEM CPU, and FEM GPU reject enabled region couplings with require_runtime.
- The API lacks curved/non-canonical contact surfaces, spacer transport, automatic multilayer
  pair generation, and a surface quadrature policy.
- authored_only is an explicit non-executable policy, not a validation bypass.
- Runtime qualification for the surface terms does not yet exist.

(irc-scientific-bibliography)=
## Scientific bibliography

1. P. Grünberg, R. Schreiber, Y. Pang, M. B. Brodsky, and H. Sowers, “Layered magnetic
   structures: evidence for antiferromagnetic coupling of Fe layers across Cr interlayers,”
   *Physical Review Letters* **57**, 2442 (1986),
   [doi:10.1103/PhysRevLett.57.2442](https://doi.org/10.1103/PhysRevLett.57.2442).
2. S. S. P. Parkin, N. More, and K. P. Roche, “Oscillations in exchange coupling and
   magnetoresistance in metallic superlattices,” *Physical Review Letters* **64**, 2304
   (1990), [doi:10.1103/PhysRevLett.64.2304](https://doi.org/10.1103/PhysRevLett.64.2304).
3. Fullmag internal specification:
   docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md.

(irc-source-code-index)=
## Source-code index

| Claim or equation | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Surface and region authoring | packages/fullmag-py/src/fullmag/model/couplings.py | class CouplingRegistry | validation and IR construction | Python | test_api.py coupling tests |
| Endpoint normalization | packages/fullmag-py/src/fullmag/model/couplings.py | class CouplingEndpoint | object/region/surface payload | Python | endpoint tests |
| Region exchange validation | packages/fullmag-py/src/fullmag/model/couplings.py | exchange | mode and coefficient checks | Python | test_class_api_exchange_coupling_lowers_to_ir |
| RKKY surface term | packages/fullmag-py/src/fullmag/model/couplings.py | rkky | finite J1 and surface endpoints | Python | test_flat_api_surface_rkky_coupling_lowers_to_ir |
| Interlayer surface term | packages/fullmag-py/src/fullmag/model/couplings.py | interlayer_exchange | finite J1/J2 and tagged IR | Python | test_interlayer_exchange_lowers_to_ir |
| Stage facade | packages/fullmag-py/src/fullmag/world.py | class StudyCouplingsHandle | study entry points | Python | public API tests |
| Tagged canonical model | crates/fullmag-ir/src/model.rs | struct CouplingIR | coupling identity and policy | IR | Rust model tests |
| Planner capability gate | crates/fullmag-plan/src/validate.rs | validate_region_owned_planning | fail-closed semantics | planner | Rust coupling rejection tests |
| FDM materialization | crates/fullmag-plan/src/fdm.rs | materialize_region_exchange_couplings | region index and override resolution | FDM GPU | Rust FDM planner tests |

Stable identities are path plus symbol. Generated line links may be attached to a published
revision; handwritten line ranges are not the contract.
