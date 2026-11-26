---
title: Inter-region couplings Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Inter-region couplings

(public-docs-python-api-interactions-inter-region-couplings)=
(python-api-interactions-inter-region-couplings-problem-statement)=
## Problem statement

`fm.CouplingRegistry`, `fm.Coupling`, `fm.CouplingEndpoint`, the `fm.couplings` helper namespace, and `study.couplings` keep cross-object, cross-region, and cross-surface endpoint identity, coupling parameters, and runtime capability policy explicit.

This page covers the Python authoring contract: construction validates endpoint kinds, averaging modes, finite coupling constants, and capability policies in Python, while `to_ir()` emits the canonical `ProblemIR` list of coupling records before planning.

(python-api-interactions-inter-region-couplings-governing-equations)=
## Governing equations

Inter-region couplings connect distinct magnetic subdomains $\Omega_A$ and $\Omega_B$ across an interface or non-magnetic spacer via bilinear/biquadratic RKKY and interlayer areal energy density $w_{\mathrm{inter}} = -J_1(\mathbf{m}_A\cdot\mathbf{m}_B) - J_2(\mathbf{m}_A\cdot\mathbf{m}_B)^2$, or via continuous interface exchange averaging (harmonic mean, explicit interfacial exchange, or disabled decoupling). Constitutive formulas and averaging modes are documented in {doc}`../../physics/interactions/inter-region-couplings/index`.

(python-api-interactions-inter-region-couplings-symbols-and-si-units)=
## Symbols and SI units

- RKKY and interlayer coupling constants `J1` and `J2` carry areal energy density in joules per square metre ($\mathrm{J\,m^{-2}}$), with $J_1 < 0$ favoring antiferromagnetic alignment and $J_1 > 0$ favoring ferromagnetic alignment.
- Explicit cross-interface exchange stiffness `inter_exchange` uses exchange-stiffness units ($\mathrm{J\,m^{-1}}$), while `scale` is a dimensionless multiplier ($1$).
- Endpoint descriptors (`source`, `target`), `coupling_id`, `mode`, `enabled`, and `capability_policy` are dimensionless identifiers or flags ($1$).

(python-api-interactions-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

- `source` and `target` must resolve via `resolve_coupling_endpoint` to typed `fm.CouplingEndpoint` instances (from a `fm.CouplingEndpoint`, `ObjectRegion`, magnet/object handle with `_name` or `name`, or non-empty string).
- For `exchange(...)`, `mode` must be `"harmonic_mean"`, `"explicit"`, or `"disabled"`. `"harmonic_mean"` forbids `inter_exchange`, `"explicit"` requires `inter_exchange`, `"disabled"` requires `scale` to be `None` or `0.0`, and any supplied `scale` must be finite and $\ge 0$.
- For `rkky(...)` and `interlayer_exchange(...)`, both `source` and `target` MUST resolve to `"surface"` endpoints (for example `lower.surface("top")` or `fm.couplings.surface("lower", "top")`); object or region endpoints raise `ValueError`.
- Allowed surface selectors on `fm.CouplingEndpoint.surface(...)`, `fm.couplings.surface(...)`, and `magnet.surface(...)` are `"top"`, `"bottom"`, `"left"`, `"right"`, `"front"`, and `"back"` (case-insensitive, normalized to lowercase).
- `J1`, optional `J2`, and optional `inter_exchange` must be finite floats; `capability_policy` must be `"require_runtime"` or `"authored_only"`.

(python-api-interactions-inter-region-couplings-python-api)=
## Python API

### Constructor or function

`fm.CouplingRegistry().exchange/rkky/interlayer_exchange(...)` (and study handle `study.couplings.exchange/rkky/interlayer_exchange(...)`)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `source` | `CouplingEndpoint \| ObjectRegion \| object \| str` | `required` | $1$ | resolves to typed endpoint; must be `"surface"` for `rkky`/`interlayer_exchange` | source coupling endpoint | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `source` |
| `target` | `CouplingEndpoint \| ObjectRegion \| object \| str` | `required` | $1$ | resolves to typed endpoint; must be `"surface"` for `rkky`/`interlayer_exchange` | target coupling endpoint | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `target` |
| `mode` | `str` | `"harmonic_mean"` | $1$ | `"harmonic_mean"`, `"explicit"`, or `"disabled"` (`exchange` only) | cross-interface exchange averaging mode | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `parameters.mode` |
| `scale` | `float \| None` | `None` | $1$ | finite and `>= 0` when supplied (`exchange` only) | dimensionless exchange multiplier | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `parameters.scale` |
| `inter_exchange` | `float \| None` | `None` | $\mathrm{J\,m^{-1}}$ | required for `mode="explicit"`, forbidden for `mode="harmonic_mean"`, finite | explicit interfacial exchange stiffness | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `parameters.inter_exchange` |
| `J1` | `float` | `required` (`rkky`, `interlayer_exchange`) | $\mathrm{J\,m^{-2}}$ | finite float | bilinear RKKY / interlayer exchange constant | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `parameters.j1` |
| `J2` | `float \| None` | `None` (`interlayer_exchange` only) | $\mathrm{J\,m^{-2}}$ | finite float when supplied | biquadratic interlayer exchange constant | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `parameters.j2` |
| `coupling_id` | `str \| None` | `None` | $1$ | non-empty when supplied; auto-generated `<kind>:<src>:<dst>` if omitted | stable coupling identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `coupling_id` |
| `enabled` | `bool` | `True` | $1$ | boolean | coupling activation flag | FEM/FDM CPU/GPU: IR; resolver-specific | `enabled` |
| `capability_policy` | `str` | `"require_runtime"` | $1$ | `"require_runtime"` or `"authored_only"` | runtime capability enforcement policy | FEM/FDM CPU/GPU: IR; resolver-specific | `capability_policy` |

### Endpoint builders, `fm.couplings`, and `study.couplings`

| API surface | Signature | Behavior |
|---|---|---|
| `fm.CouplingEndpoint.object` / `fm.couplings.object` | `(object_name: str) -> CouplingEndpoint` | creates `{"kind": "object", "object": object_name}` |
| `fm.CouplingEndpoint.region` / `fm.couplings.region` | `(object_name: str, region_id: str) -> CouplingEndpoint` | creates `{"kind": "region", "object": object_name, "region_id": region_id}` |
| `fm.CouplingEndpoint.surface` / `fm.couplings.surface` | `(object_name: str, selector: str) -> CouplingEndpoint` | creates `{"kind": "surface", "object": object_name, "selector": selector}` (`top`, `bottom`, `left`, `right`, `front`, `back`) |
| `magnet.surface(selector)` | `MagnetHandle.surface(selector: str) -> CouplingEndpoint` | shorthand surface endpoint bound to the magnet object |
| `fm.couplings.registry()` | `() -> CouplingRegistry` | constructs a standalone `fm.CouplingRegistry` |
| `study.couplings` | `StudyCouplingsHandle` (`.exchange(...)`, `.rkky(...)`, `.interlayer_exchange(...)`) | registers couplings directly on the study and returns `StudyBuilder` for chaining |
| `fm.Coupling` | `(coupling_id, kind, source, target, parameters, enabled=True, capability_policy="require_runtime")` | immutable coupling record produced by registry methods |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("inter-region-couplings-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
lower = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="lower")
upper = study.geometry(
    fm.Translate(fm.Box(size=(100e-9, 20e-9, 5e-9)), (0.0, 0.0, 6e-9)),
    name="upper",
)
for layer, mz in ((lower, 1.0), (upper, -1.0)):
    layer.Ms = 800.0e3
    layer.Aex = 13.0e-12
    layer.alpha = 0.02
    layer.m = fm.texture.uniform(0.0, 0.0, mz)

# %%
study.couplings.rkky(
    lower.surface("top"),
    upper.surface("bottom"),
    J1=-1.0e-3,
    coupling_id="saf_rkky",
)
study.couplings.exchange(lower, upper, mode="harmonic_mean", scale=0.5)
study.stages.add_relax(stage_id="saf-relax", dt=5e-13, max_steps=1)

registry = fm.couplings.registry()
registry.interlayer_exchange(
    fm.couplings.surface("lower", "top"),
    fm.couplings.surface("upper", "bottom"),
    J1=-1.0e-3,
    J2=0.2e-3,
)
canonical_ir = registry.to_ir()
```

(python-api-interactions-inter-region-couplings-problem-ir)=
## ProblemIR

`registry.to_ir()` emits a list of typed coupling dictionaries, each containing `"coupling_id"`, `"kind"` (`"exchange"`, `"rkky"`, or `"interlayer_exchange"`), `"source"`, `"target"`, `"enabled"`, `"parameters"` (including `"kind"` plus `"mode"`/`"scale"`/`"inter_exchange"` or `"j1"`/`"j2"`), and `"capability_policy"`.

(python-api-interactions-inter-region-couplings-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves endpoint identity, coupling family, signed `J1`/`J2` constants, exchange averaging mode, and `capability_policy` in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid endpoint kinds (such as non-surface endpoints for `rkky`/`interlayer_exchange`), invalid surface selectors, contradictory `exchange` mode/parameter combinations, or non-finite constants. `Unsupported combinations` fail closed when a requested coupling family lacks solver support under `"require_runtime"`.

(python-api-interactions-inter-region-couplings-discrete-realization)=
## Discrete realization

The Python contract supplies typed endpoint records and capability policy in `ProblemIR`; discrete cross-interface stencils and surface pairings are executed by the solver planners and backends across the four execution lanes:

| Backend lane | Authoring & IR | Runtime status & discretization notes |
|---|---|---|
| FEM CPU | Supported | Conforming/non-conforming interface facet pairings for RKKY/interlayer exchange and multi-region exchange; capability-gated by planner. |
| FEM GPU | Supported | IR lowering supported; runtime follows FEM GPU coupling kernel readiness and fails closed under `"require_runtime"` if absent. |
| FDM CPU | Supported | Cross-cell interface exchange averaging (harmonic mean, explicit, disabled) and finite-difference surface RKKY coupling. |
| FDM GPU | Supported | Cross-cell FDM GPU exchange and surface RKKY kernels subject to planner capability checks. |

(python-api-interactions-inter-region-couplings-implementation-mapping)=
## Implementation mapping

The authoritative implementations are `packages/fullmag-py/src/fullmag/model/couplings.py` (`class CouplingRegistry`, `class Coupling`, `class CouplingEndpoint`), `packages/fullmag-py/src/fullmag/couplings.py` (`fm.couplings` convenience constructors), and `packages/fullmag-py/src/fullmag/world.py` (`class StudyCouplingsHandle` and `class MagnetHandle`).

(python-api-interactions-inter-region-couplings-validation)=
## Validation

Focused repository unit tests covering `fm.CouplingRegistry` lowering and round-tripping include `test_class_api_exchange_coupling_lowers_to_ir` and `test_coupling_registry_round_trips_all_families`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-inter-region-couplings-limitations)=
## Limitations and Control Room

Inter-object and inter-region couplings (`fm.CouplingRegistry`) are inspected and toggled (`toggle-enabled`, `delete`) in Control Room via `CouplingInspectorPanel` (`apps/control-room/src/modules/inspector/inspectors/objects/physics/DemagAndCouplingSpecs.tsx`, backed by `MODEL_COUPLINGS_RESOURCE_KEY` and undo/redo history). Creating new custom coupling formulas or asymmetric tensor couplings without inspector fields remains `Python-only`. Explicit spin-mixing interfaces additionally surface `SpinInterfaceInspectorPanel` and FEM `tet4` facet orientation verification.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Enabled state & inspection of explicit object/region couplings | `Model Explorer -> Physics / Couplings -> <coupling>` (`CouplingInspectorPanel`) | `partial` | `runAuthoringMutationWithHistory` via `MODEL_COUPLINGS_RESOURCE_KEY` |
| Spin interface parameters & `tet4` facet orientation check | `Model Explorer -> Physics / Spin Interfaces` (`SpinInterfaceInspectorPanel`) | `partial` | `verifySpinInterfaceMeshOrientation` & scene transaction |
| Custom tensor coupling laws without UI widgets | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-physics-couplings-frozen-spins.png
:alt: Control Room Frozen Spins constraint inspector showing region-scoped pinning selection (frz_edge_pin on reg_pinning_ring) inside the Physics constraints view
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-interactions-inter-region-couplings-scientific-bibliography)=
## Scientific bibliography

- P. Grünberg, R. Schreiber, Y. Pang, M. B. Brodsky, and H. Sowers, “Layered Magnetic Structures: Evidence for Antiferromagnetic Coupling of Fe Layers across Cr Interlayers,” *Physical Review Letters* **57**(19), 2442–2445 (1986), [doi:10.1103/PhysRevLett.57.2442](https://doi.org/10.1103/PhysRevLett.57.2442).
- P. Bruno, “Theory of interlayer magnetic coupling,” *Physical Review B* **52**(1), 411–439 (1995), [doi:10.1103/PhysRevB.52.411](https://doi.org/10.1103/PhysRevB.52.411).
- D. Suess, S. Koraltan, F. Slanovc, F. Bruckner, and C. Abert, “Accurate finite-difference micromagnetics of magnets including RKKY interaction: Analytical solution and comparison to standard micromagnetic codes,” *Physical Review B* **107**(10), 104424 (2023), [doi:10.1103/PhysRevB.107.104424](https://doi.org/10.1103/PhysRevB.107.104424) | [arXiv:2206.11063](https://arxiv.org/abs/2206.11063).

(python-api-interactions-inter-region-couplings-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/couplings.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/couplings.py#L85) | `class CouplingRegistry` | public coupling registry (`exchange`, `rkky`, `interlayer_exchange`) and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/couplings.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/couplings.py#L47) | `class Coupling` | immutable coupling record and `to_ir()` validation |
| [`packages/fullmag-py/src/fullmag/model/couplings.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/couplings.py#L13) | `class CouplingEndpoint` | object, region, and surface endpoint selectors |
| [`packages/fullmag-py/src/fullmag/couplings.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/couplings.py#L18) | `registry` | `fm.couplings` convenience namespace (`object`, `region`, `surface`, `registry`) |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyCouplingsHandle` | `study.couplings` chainable study registration handle |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class MagnetHandle` | `magnet.surface(selector)` endpoint helper |
