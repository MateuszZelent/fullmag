---
title: Artifacts
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-artifacts)=
# Artifacts

(python-api-runtime-artifacts-problem-statement)=
## Contract
Artifacts are persisted run outputs and interchangeable state files: the run output storage policy
(`OutputStorage`), saved magnetization states (`load_magnetization`, `save_magnetization`,
`Result.save_state`), general vector/scalar field states (`FieldState`, `load_field_state`,
`save_field_state`), and format inference (`infer_magnetization_state_format`).

(python-api-runtime-artifacts-governing-equations)=
## Governing equations
No physical equation is owned here.

(python-api-runtime-artifacts-symbols-and-si-units)=
## Symbols and SI units
Reduced magnetization vectors are dimensionless ($1$). `FieldState` records its physical `units`
metadata string (e.g. $\mathrm{A\,m^{-1}}$ or $\mathrm{T}$) alongside optional structured-grid
geometry metadata (`grid_origin` and `grid_spacing` in $\mathrm{m}$, `grid_shape` dimensionless
counts $1$). Storage policy fields, paths, formats, dataset keys, and sample indices are
dimensionless ($1$).

(python-api-runtime-artifacts-assumptions-and-validity)=
## Assumptions and validity
Supported state formats are validated fail-closed against the live format tuples:

- `MAGNETIZATION_STATE_FORMATS = ("json", "zarr", "h5", "ovf", "npz", "npy")`
- `FIELD_STATE_FORMATS = ("zarr", "h5", "ovf", "npz", "npy", "json")`

When `format="auto"` is passed, `infer_magnetization_state_format(path)` derives the format from
the path suffix (`.json`, `.zarr`, `.h5`/`.hdf5`, `.ovf`/`.omf`, `.npz`, `.npy`) and raises on
unrecognized extensions. `sample` defaults to `-1` (the final frame in multi-sample archives).

(python-api-runtime-artifacts-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Result.output_dir` | `str \| None` | `None` | $1$ | Resolved run directory path | Directory holding persisted run artifacts | FEM/FDM CPU/GPU runtime output | `resolved_output_storage.output_dir` |
| `Result.save_state.path` | `str \| Path` | `required` | $1$ | Non-empty filesystem path; requires `final_magnetization` | Destination path for final magnetization state | FEM/FDM CPU/GPU runtime output | none (runtime output) |
| `Result.save_state.format` | `str` | `"auto"` | $1$ | `"auto"` or member of `MAGNETIZATION_STATE_FORMATS` (`json`, `zarr`, `h5`, `ovf`, `npz`, `npy`) | Serialization format selector | FEM/FDM CPU/GPU runtime output | none (runtime output) |
| `Result.save_state.dataset` | `str` | `"values"` | $1$ | Dataset key for hierarchical formats (`zarr`, `h5`, `npz`) | Target dataset name inside archive | FEM/FDM CPU/GPU runtime output | none (runtime output) |
| `load_magnetization.path` | `str \| Path` | `required` | $1$ | Existing readable file/directory path | Source state file to load as `SampledMagnetization` | FEM/FDM CPU/GPU authoring/runtime | `magnets[].initial_magnetization` |
| `load_magnetization.format` | `str` | `"auto"` | $1$ | `"auto"` or `MAGNETIZATION_STATE_FORMATS` | Explicit or extension-inferred reader format | FEM/FDM CPU/GPU authoring/runtime | `magnets[].initial_magnetization.source_format` |
| `load_magnetization.dataset` | `str \| None` | `None` | $1$ | Optional dataset/key inside archive | Selects dataset in `zarr`/`h5`/`npz` files | FEM/FDM CPU/GPU authoring/runtime | `magnets[].initial_magnetization.dataset` |
| `load_magnetization.sample` | `int` | `-1` | $1$ | Frame index (`-1` selects final frame) | Sample index extracted from time-series state archive | FEM/FDM CPU/GPU authoring/runtime | `magnets[].initial_magnetization.sample_index` |
| `save_magnetization.format` | `str` | `"auto"` | $1$ | `"auto"` or `MAGNETIZATION_STATE_FORMATS` (`json`, `zarr`, `h5`, `ovf`, `npz`, `npy`) | Low-level magnetization state writer format | FEM/FDM CPU/GPU runtime I/O | none (file output) |
| `infer_magnetization_state_format.path` | `str \| Path` | `required` | $1$ | Path with recognized suffix (`.json`, `.zarr`, `.h5`, `.hdf5`, `.ovf`, `.omf`, `.npz`, `.npy`) | Returns canonical format token from file extension | FEM/FDM CPU/GPU authoring/runtime | none (helper) |
| `load_field_state.path` | `str \| Path` | `required` | $1$ | Readable path in `FIELD_STATE_FORMATS` (`zarr`, `h5`, `ovf`, `npz`, `npy`, `json`) | Loads arbitrary scalar or vector `FieldState` with metadata and optional grid geometry | FEM/FDM CPU/GPU authoring/runtime | external field state asset |
| `load_field_state.sample` | `int` | `-1` | $1$ | Frame index (`-1` selects last sample) | Sample index for multi-frame field archives | FEM/FDM CPU/GPU authoring/runtime | `FieldState.sample_index` |
| `load_field_state.source_origin` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | Optional finite 3-vector overriding grid origin | Explicit spatial origin when absent from file header | FEM/FDM CPU/GPU authoring/runtime | `FieldState.grid_origin` |
| `save_field_state.path` | `str \| Path` | `required` | $1$ | Writable destination path in `FIELD_STATE_FORMATS` | Persists a `FieldState`, `SampledMagnetization`, or array with quantity/target/unit metadata | FEM/FDM CPU/GPU runtime I/O | none (file output) |
| `OutputStorage.output_dir` | `str \| None` | `None` | $1$ | Optional non-empty directory path | Explicit output directory for study/run artifacts | FEM/FDM CPU/GPU authoring and runtime | `output_storage.output_dir` |
| `OutputStorage.temp_dir` | `str \| None` | `None` | $1$ | Optional non-empty parent directory for run scratch | Private scratch parent directory (never deleted itself) | FEM/FDM CPU/GPU authoring and runtime | `output_storage.temp_dir` |
| `OutputStorage.data_format` | `str` | `"zarr"` | $1$ | `"zarr"` or `"hdf5"` | Primary archive format for run outputs | FEM/FDM CPU/GPU authoring and runtime | `output_storage.data_format` |
| `OutputStorage.cleanup` | `str` | `"on_success"` | $1$ | `"on_success"`, `"always"`, or `"never"` | Private scratch cleanup policy | FEM/FDM CPU/GPU authoring and runtime | `output_storage.cleanup` |
| `OutputStorage.existing_output` | `str` | `"timestamp"` | $1$ | `"timestamp"`, `"overwrite"`, or `"fail"` | Policy when `output_dir` already exists | FEM/FDM CPU/GPU authoring and runtime | `output_storage.existing_output` |

### `FieldState` dataclass fields

`fm.FieldState` (`packages/fullmag-py/src/fullmag/init/state_io.py`) carries both sample values and
spatial/quantity metadata across all six `FIELD_STATE_FORMATS`:

- `values`: `list[tuple[float, ...]]` — per-point scalar or vector samples
- `quantity_id`, `target_kind`, `target_id`, `units`: quantity identity, target scope, and SI unit label
- `source_path`, `source_format`, `dataset`, `sample_index`: archive provenance
- `grid_shape`, `grid_origin`, `grid_spacing`, `origin_explicit`: optional regular-grid geometry metadata (for OVF/structured field transfer and resampling)

### Complete stage-first context

```python
# %% Stage-first study with OutputStorage policy and format inference check
import fullmag as fm

nm = 1.0e-9

study = fm.study("artifacts_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

storage = fm.OutputStorage(
    output_dir="runs/artifacts_api_example",
    data_format="zarr",
    cleanup="on_success",
    existing_output="timestamp",
)
study.storage(
    output_dir=storage.output_dir,
    data_format=storage.data_format,
    cleanup=storage.cleanup,
    existing_output=storage.existing_output,
)

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
study.stages.add_save_state(artifact_name="final_m.zarr", format="zarr", dataset="values")

# Verify format inference across supported formats:
assert fm.infer_magnetization_state_format("relaxed.ovf") == "ovf"
assert fm.infer_magnetization_state_format("snapshot.npz") == "npz"
assert fm.infer_magnetization_state_format("state.zarr") == "zarr"
```

(python-api-runtime-artifacts-problem-ir)=
## ProblemIR
`OutputStorage.to_ir()` lowers into `output_storage` (with `output_dir`, `temp_dir`, `data_format`,
`cleanup`, and `existing_output`). Saved field/magnetization files are runtime artifacts; when
loaded via `load_magnetization(...)` as an initial state, their provenance lowers into
`magnets[].initial_magnetization`.

(python-api-runtime-artifacts-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Saving without `final_magnetization` raises immediately. Unsupported extensions, unknown archive
formats, or out-of-range `sample` indices raise fail-closed errors rather than writing or loading
best-effort data.

(python-api-runtime-artifacts-discrete-realization)=
## Discrete realization

| Solver | Device | Artifact & state I/O behavior | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Full `json`, `zarr`, `h5`, `ovf`, `npz`, `npy` state read/write and `OutputStorage` archival | Grid ordering and OVF metadata covered by state I/O tests |
| FDM | GPU | Host-synchronized state export/import via the shared format layer | GPU solver parity qualified independently |
| FEM | CPU | Nodal/field state persistence (`zarr`, `h5`, `npz`, `npy`, `json`) and `OutputStorage` archival | Mesh-cardinality matching validated at load time |
| FEM | GPU | Host-synchronized state export/import via the shared format layer | GPU solver parity qualified independently |

State serialization lives in `packages/fullmag-py/src/fullmag/init/state_io.py` and supports JSON,
Zarr, HDF5 (`h5`), OVF (`ovf`), NumPy archives (`npz`), and raw NumPy arrays (`npy`).

(python-api-runtime-artifacts-implementation-mapping)=
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Result`),
`packages/fullmag-py/src/fullmag/init/state_io.py` (`class FieldState`, `load_magnetization`,
`save_magnetization`, `load_field_state`, `save_field_state`, `infer_magnetization_state_format`),
and `packages/fullmag-py/src/fullmag/model/output_storage.py` (`class OutputStorage`).

(python-api-runtime-artifacts-validation)=
## Validation
State round-trip across `json`, `zarr`, `h5`, `ovf`, `npz`, and `npy`, `sample` indexing, and
`OutputStorage` policy validation are covered by read/write and API contract tests.

(python-api-runtime-artifacts-limitations)=
## Limitations
External tools (such as OOMMF or MuMax3 for `.ovf` files) expect regular Cartesian grids; loading
an unstructured FEM nodal vector into a grid-only OVF reader requires explicit resampling.

(python-api-runtime-artifacts-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `Python-only` | Authored in Python |

Runtime-selection and artifact-publication parameters outside the workspace runtime panel remain Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` (`RuntimeExplorerInspectorPanels`).

(python-api-runtime-artifacts-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Artifact access and state persistence entrypoint | [`packages/fullmag-py/src/fullmag/runtime/simulation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L77) | [`class Result`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L77) | Runtime artifact access and `Result.save_state` | Ownership and API contract tests |
| Magnetization state I/O | [`packages/fullmag-py/src/fullmag/init/state_io.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L106) | [`save_magnetization`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L106), `load_magnetization`, `infer_magnetization_state_format` | JSON/Zarr/HDF5/OVF/NPZ/NPY magnetization round-trip | Read/write tests |
| General field state container and I/O | [`packages/fullmag-py/src/fullmag/init/state_io.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L22) | [`class FieldState`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L22), `load_field_state`, `save_field_state` | Multi-format field-state container and metadata | Read/write tests |
| Run output storage policy | [`packages/fullmag-py/src/fullmag/model/output_storage.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/output_storage.py#L35) | [`class OutputStorage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/output_storage.py#L35) | Output directory, scratch, format, cleanup, and collision policies | Output storage tests |
