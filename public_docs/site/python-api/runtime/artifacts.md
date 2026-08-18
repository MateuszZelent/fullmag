---
title: Artifacts
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-artifacts)=
# Artifacts

(python-api-runtime-artifacts-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Artifacts are the persisted run outputs: the output directory, saved magnetization states, tables,
and field snapshots written by the runtime.

(python-api-runtime-artifacts-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is owned here.

(python-api-runtime-artifacts-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Magnetization state is stored with its own unit metadata; table quantities carry the units defined
by the corresponding observables.

(python-api-runtime-artifacts-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
State formats are validated against the supported set (`json`, `zarr`, `h5`); format is inferred
from the path extension when `"auto"` is requested.

(python-api-runtime-artifacts-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `Result.output_dir` | `str \| None` | `None` | Directory path | Directory for run artifacts | output dir |
| `Result.save_state(path, format=..., dataset=...)` | method | `format="auto"`, `dataset="values"` | Requires `final_magnetization` | Persist final state | n/a (runtime output) |
| `save_magnetization(path, values, ...)` | function | `format="auto"` | `json`, `zarr`, or `h5` | Low-level state writer | n/a |

### Complete stage-first context

```python
# %% Stage-first study whose executed result can persist final state
import fullmag as fm

nm = 1.0e-9

study = fm.study("artifacts_api_example")
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
study.stages.add_run(stage_id="run", until=1.0e-12)

# After execution with a final magnetization, the result persists state:
# result.save_state("relaxed_m.zarr", format="zarr")
```

(python-api-runtime-artifacts-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Artifacts are runtime outputs; they are not authoring inputs and have no lowering destination.

(python-api-runtime-artifacts-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Saving without `final_magnetization` raises immediately. Unsupported formats raise rather than
writing a best-effort file.

(python-api-runtime-artifacts-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
State serialization lives in `fullmag/init/state_io.py` and supports JSON, Zarr, and HDF5.

(python-api-runtime-artifacts-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/runtime/simulation.py` (`Result.save_state`) and
`packages/fullmag-py/src/fullmag/init/state_io.py` (`save_magnetization`).

(python-api-runtime-artifacts-validation)=
<!-- (validation)= -->
## Validation
State round-trip is covered by read/write tests; ownership tests validate the source map.

(python-api-runtime-artifacts-limitations)=
<!-- (limitations)= -->
## Limitations
Artifact format support does not guarantee interchange with other tools; readers must honor the
stored unit and dataset metadata.

(python-api-runtime-artifacts-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-runtime-artifacts-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| State persistence | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `Result.save_state` | Public save entrypoint | Ownership test |
| Serialization formats | `packages/fullmag-py/src/fullmag/init/state_io.py` | `save_magnetization`, `load_magnetization` | JSON/Zarr/HDF5 round-trip | Read/write tests |
