---
title: Inter-region couplings Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Inter-region couplings

(public-docs-python-api-interactions-inter-region-couplings)=
(python-api-interactions-inter-region-couplings-problem-statement)=
## Problem statement

CouplingRegistry keeps cross-region endpoint identity and capability policy explicit.

This page covers the Python authoring contract: construction validates endpoint pairs, coupling constants, averaging modes, and runtime capability policies in Python, while `to_ir()` emits the canonical `ProblemIR` list of coupling records before planning.

(python-api-interactions-inter-region-couplings-governing-equations)=
## Governing equations

Inter-region couplings connect distinct magnetic subdomains $\Omega_A$ and $\Omega_B$ across an interface or spacer via bilinear/biquadratic RKKY and interlayer areal energy density $w_{\mathrm{inter}} = -J_1(\mathbf{m}_A\cdot\mathbf{m}_B) - J_2(\mathbf{m}_A\cdot\mathbf{m}_B)^2$, or scaled continuous interface exchange averaging. Constitutive formulas and averaging modes are documented in {doc}`../../physics/interactions/inter-region-couplings/index`.

(python-api-interactions-inter-region-couplings-symbols-and-si-units)=
## Symbols and SI units

RKKY and interlayer coupling constants (`J1`, `J2`) use areal energy density in joules per square metre ($\mathrm{J\,m^{-2}}$). Endpoint identifiers (`source/target`, `coupling_id`), interface `mode`, dimensionless `scale`, `enabled`, and `capability_policy` are dimensionless ($1$).

(python-api-interactions-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

`source` and `target` must be non-empty typed endpoints referencing distinct regions or objects, `J1` (and optional `J2`) / `scale` must be finite, `enabled` is boolean, and `capability_policy` must be a supported planner policy. Self-couplings, non-finite constants, or missing runtime capabilities under `"require_runtime"` fail closed.

(python-api-interactions-inter-region-couplings-python-api)=
## Python API

### Constructor or function

`fm.CouplingRegistry().exchange/rkky/interlayer_exchange(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `source/target` | `str or endpoint` | `required` | $1$ | typed, non-empty endpoints | coupling endpoints | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `source/target` |
| `mode` | `str` | `harmonic_mean` | $1$ | source validation modes | cross-interface averaging mode | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `mode` |
| `scale` | `float or None` | `None` | $1$ | finite when supplied | exchange scale | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `scale` |
| `J1/J2` | `float` | `J1 required; J2 None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | RKKY/interlayer constants | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | `J1/J2` |
| `coupling_id` | `str or None` | `None` | $1$ | non-empty when supplied | stable coupling ID | FEM/FDM CPU/GPU: IR; resolver-specific | `coupling_id` |
| `enabled` | `bool` | `True` | $1$ | boolean | activation flag | FEM/FDM CPU/GPU: IR; resolver-specific | `enabled` |
| `capability_policy` | `str` | `require_runtime` | $1$ | supported policy | runtime capability policy | FEM/FDM CPU/GPU: IR; resolver-specific | `capability_policy` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.CouplingRegistry(); value.exchange("film.a", "film.b", mode="harmonic_mean")
canonical_ir = value.to_ir()
```

In a complete simulation script, register cross-region couplings on the study coupling registry rather than constructing an unattached `CouplingRegistry` instance.

(python-api-interactions-inter-region-couplings-problem-ir)=
## ProblemIR

`value.to_ir()` emits a list of typed coupling dictionaries, each containing `"coupling_id"`, `"kind"` (`"exchange"`, `"rkky"`, or `"interlayer_exchange"`), `"source"`, `"target"`, `"enabled"`, `"parameters"`, and `"capability_policy"`.

(python-api-interactions-inter-region-couplings-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves endpoint identity, coupling family, signed `J1`/`J2` constants, and `capability_policy` in `ProblemIR` independently of `resolved execution`. `Validation errors` reject malformed endpoints or non-finite constants, while `unsupported combinations` fail closed when a requested coupling family lacks solver support under the declared capability policy.

(python-api-interactions-inter-region-couplings-discrete-realization)=
## Discrete realization

The Python contract supplies typed endpoint records and capability policy in `ProblemIR` only; cross-cell FDM spacer fields, FEM interface facet pairings, and runtime capability checking are implemented by the solver planners and backends.

(python-api-interactions-inter-region-couplings-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/couplings.py` (`class CouplingRegistry`). Constructor/method parameters, validation branches, defaults, and `to_ir()` entries come directly from that module.

(python-api-interactions-inter-region-couplings-validation)=
## Validation

Focused repository unit tests covering `CouplingRegistry` lowering and round-tripping include `test_class_api_exchange_coupling_lowers_to_ir` and `test_coupling_registry_round_trips_all_families`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-inter-region-couplings-limitations)=
## Limitations and Control Room

Inter-object and inter-region couplings (`CouplingRegistry`) are inspected and toggled (`toggle-enabled`, `delete`) in Control Room via `CouplingInspectorPanel` (`coupling` selection route, backed by `MODEL_COUPLINGS_RESOURCE_KEY` and undo/redo history). Creating new custom coupling formulas or asymmetric tensor couplings without inspector fields remains `Python-only`. Explicit spin-mixing interfaces additionally surface `SpinInterfaceInspectorPanel` and FEM `tet4` facet orientation verification.

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
| `packages/fullmag-py/src/fullmag/model/couplings.py` | `class CouplingRegistry` | public constructor and IR lowering |
