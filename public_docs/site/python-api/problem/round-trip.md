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
Lowering normalizes explicit requested backend, mode, and precision overrides and converts authored
parameters to canonical quantities without changing requested intent. The planner/runtime resolves
the actual execution lane later. Validation failures happen at authoring or planning time.

(python-api-problem-round-trip-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Meaning |
|---|---|
| `Problem.to_ir(requested_backend=..., execution_mode=..., execution_precision=...)` | Canonical lowering with explicit requested runtime intent |
| `RuntimeSelection.resolved(backend=..., mode=..., precision=...)` | Return a copied requested descriptor with the supplied fields overridden; despite the method name, this is not planner resolution |
| `RuntimeSelection.to_runtime_metadata()` | Serialize that requested descriptor into request metadata |

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
`Problem.to_ir()` builds the request with normalized requested runtime metadata, geometry assets,
materials, regions, study pipeline, and builder/script-sync manifests while preserving
script-source hashing. Planner-resolved backend/device reality is a later execution/provenance
record.

(python-api-problem-round-trip-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested and planner-resolved descriptors remain distinct. An FDM selection with FEM-only policy such as
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
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Canonical lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `Problem.to_ir` | Authoring-to-IR mapping | Round-trip tests |
| Requested-runtime override | `packages/fullmag-py/src/fullmag/model/problem.py` | `RuntimeSelection.resolved` | Copies and overrides the requested descriptor before planning | Ownership test |
| Canonical script rewrite | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `render_loaded_problem_as_script` | Re-emits stage-first Python from a loaded problem/session model | Script-builder round-trip tests |
