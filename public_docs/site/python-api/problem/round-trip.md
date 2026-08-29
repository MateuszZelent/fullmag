---
title: Round Trip
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-round-trip)=
# Round Trip

(python-api-problem-round-trip-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Round trip covers authoring-to-IR lowering and the reverse normalization paths that keep the
Python surface, canonical `ProblemIR`, and exports consistent.

(python-api-problem-round-trip-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This page introduces no governing equation.

(python-api-problem-round-trip-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Units carried by parameters follow their owning pages; exact lowering is unit-preserving.

(python-api-problem-round-trip-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Lowering resolves runtime selection and converts authored parameters to canonical quantities
without changing requested intent. Validation failures happen at authoring or planning time.

(python-api-problem-round-trip-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Meaning |
|---|---|
| `Problem.to_ir(requested_backend=..., execution_mode=..., execution_precision=...)` | Canonical lowering with explicit runtime intent |
| `RuntimeSelection.resolved(backend=..., mode=..., precision=...)` | Resolve requested descriptors onto the runtime record |
| `RuntimeSelection.to_runtime_metadata()` | Serialize the resolved selection into provenance metadata |

### Complete stage-first context

Round trip starts from the study scenario; the builder lowers it to `Problem` and then to IR.

```python
# %% Stage-first study ready for lowering
import fullmag as fm

nm = 1.0e-9

study = fm.study("round_trip_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-problem-round-trip-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Problem.to_ir()` builds the request with resolved runtime, geometry assets, materials, regions,
study pipeline, and builder/script-sync manifests while preserving script-source hashing.

(python-api-problem-round-trip-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested and resolved descriptors remain distinct. An FDM selection with FEM-only policy such as
`pbc.demag="periodic_airbox_k0"` fails lowering rather than being silently converted.

(python-api-problem-round-trip-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Lowering is runtime-independent and exercised by authoring tests.

(python-api-problem-round-trip-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/problem.py` (`Problem.to_ir`,
`RuntimeSelection.resolved`, `RuntimeSelection.to_runtime_metadata`).

(python-api-problem-round-trip-validation)=
<!-- (validation)= -->
## Validation
Authoring and graph round-trip tests exercise the same lowering as the public export.

(python-api-problem-round-trip-limitations)=
<!-- (limitations)= -->
## Limitations
Exact serialized output shape may evolve with `IR_VERSION`; consumers must read the version field
instead of assuming a frozen layout.

(python-api-problem-round-trip-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-problem-round-trip-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: The Control Room authors a study and lowers it to ProblemIR; direct Problem/IR editing is not exposed.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `No standalone Control Room route` | `TODO` | No supported frontend transaction |
| Parameters without a named UI field | `No standalone Control Room route` | `TODO` | Python-only until implemented |

TODO: frontend support for standalone Problem/ProblemIR authoring.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx (StudyInspectorPanel)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Canonical lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `Problem.to_ir` | Authoring-to-IR mapping | Round-trip tests |
| Runtime resolution | `packages/fullmag-py/src/fullmag/model/problem.py` | `RuntimeSelection.resolved` | Requested-vs-resolved | Ownership test |
