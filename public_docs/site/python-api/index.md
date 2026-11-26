---
title: Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-root)=
# Python API

FullMag's public authoring surface is the embedded stage-first Python DSL
(`import fullmag as fm`), usable either in **batch stage-first scripts** (`fm.study(...)` and
`study.stages.add_*`) or **interactive live sessions** connected to a running FullMag instance
({doc}`runtime/live-session`, `fm.connect()`). The tree is organized by authoring owner.

Each reference page documents the public Python constructor, SI units, `ProblemIR` serialization,
and Control Room availability. Browser coverage and Python-only parameters are tracked in
{doc}`../frontend/capability-register`.

```{image} /_static/images/ui/control-room-workspace-overview.png
:alt: FullMag Control Room workspace with Ribbon, Model Explorer, interactive 3D Viewport, Semantic Inspector, and status bar
:align: center
:width: 100%
```

Meshing is a dedicated family with separate FDM and FEM branches. Within FEM, ferromagnet and
airbox commands are separated, and every topology mode has its own page. Low-level composite
discretization objects remain in a small compatibility branch instead of mixing with mesh workflows.

## Public submodule map

Beyond the top-level `fullmag` namespace (`import fullmag as fm`), FullMag organizes specialized
helpers, post-processing utilities, and transport clients into focused public submodules:

| Submodule | Role | Primary documentation |
| --- | --- | --- |
| `fullmag.shapes` | Ergonomic geometry factories (`box`, `cylinder`, `disk`, `cone`, `torus`, `polygon_prism`, `ellipsoid`, `ellipse`, `sphere`, `imported`, `sin_waveguide`, `arch_waveguide`, `rotate`, `scale`, `affine`, `slice_plane`, `array_3d`) | {doc}`geometry/index` |
| `fullmag.fields` | Spatial material parameter field factories (`constant`, `linear`, `radial`, `sampled`, `function`) | {doc}`materials/spatial-parameter-fields` |
| `fullmag.init` | Initial magnetization value classes, preset texture evaluators, and field-state I/O (`load_magnetization`, `save_magnetization`, `load_field_state`, `save_field_state`, `FieldState`) | {doc}`magnets-and-textures/index`, {doc}`runtime/artifacts` |
| `fullmag.couplings` | Inter-object, inter-region, and surface coupling endpoints and registries | {doc}`interactions/inter-region-couplings` |
| `fullmag.antennas` | Ready-to-use wavevector/spatial excitation builders (`gaussian_k_source`, `delayed_sine`, `READY_ANTENNAS`) | {doc}`current-and-excitations/index` |
| `fullmag.units` | SI scaling constants (`nm`, `um`, `mm`, `ps`, `ns`, `MHz`, `GHz`, `mT`, `T`) | {doc}`problem/index` |
| `fullmag.live` | Interactive live-session attachment, transactions, streaming reads, parameter sweeps, and notebook monitors (`fm.connect()`, `fm.sweep()`, `fullmag.live.jupyter.monitor`) | {doc}`runtime/live-session` |
| `fullmag.client` | Typed HTTP/WebSocket API client, binary FMVP/FMTB decoders, and revision-conflict exceptions | {doc}`runtime/live-session` |
| `fullmag.analysis` | Post-processing utilities for state comparison, vortex-core tracking, FFT spectra, Lorentzian linewidth fits, and FEM-to-Cartesian restriction | {doc}`outputs/index` |
| `fullmag.export3d` | 3D visualization exporters (`export_glb`, `export_gltf`, `export_pvd`, `export_grid_3d`, `export_mesh_3d`, `export_mode_animation_3d`) | {doc}`outputs/index` |

## Hardware acceleration and solver policy controls

Recent solver and runtime controls exposed through the Python API include:

- **FEM GPU direct and preconditioned solvers**: `FemLinearSolverPolicy.gpu_strategy` (`"auto"`, `"cg_amg"`, `"cudss"`), `fm.fem_demag_solver(..., atol=..., print_level=..., gpu_strategy=...)`, `FEM.gpu_bb_preconditioner` / `study.fem_bb_preconditioner`, and `FrequencyResponseSolverPolicy.method="gpu_sparse_direct"` for cuDSS-accelerated driven response.
- **FEM thin-film P2 prism discretization and open-airbox eigenmodes**: `transition_policy="pure_prism"` (enabling automatic `pure_prism_p2` quadratic wedge potential on pure-prism thin films) and `Eigenmodes.magnetostatic_bc="open_airbox_k0"`.
- **FDM precision, FFT, and runtime execution policies**: `FdmPrecisionPolicy` (`full_double`, `single_storage_fp64_reduction`), `FDMDemag.fft_backend` and `FDMDemag.common_cell_size`, `FDM.projection_policy`, `ParallelExecutionPolicy`, `ExecutionProfile`, `ComputeResources`, and per-stage `study.stages.change_device(...)`.

For algorithmic details, benchmarks, and hardware qualification across FDM and FEM CPU/GPU lanes,
see {ref}`numerical-methods-performance`.

## Live & batch round-trip

Interactive REPL / notebook sessions (`fm.connect()`, `fm.transaction()`, `fm.relax()`, `fm.run()`,
`fm.field()`, `fm.table()`, `fm.sweep()`) operate over the same underlying `SceneDocument` and
SI-normalized `ProblemIR` schema as batch scripts, and can export a canonical stage-first Python script
at any time via `fm.export_script()`.

```{image} /_static/images/ui/ribbon-tabs-automation-python.png
:alt: Control Room File menu showing Save canonical copy as... for canonical Python script export alongside the Workspace ribbon and Model Explorer
:align: center
:width: 100%
```

```{toctree}
:maxdepth: 4

problem/index
geometry/index
materials/index
magnets-and-textures/index
interactions/index
current-and-excitations/index
boundary-conditions/index
meshing/index
discretization/index
dynamics/index
studies/index
outputs/index
runtime/index
```
