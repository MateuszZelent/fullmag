---
title: Outputs
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-root)=
# Outputs

Outputs turn solver results into inspectable scientific artifacts: periodic field and scalar
requests (`fm.SaveField`, `fm.SaveScalar`), generic quantity selectors (`fm.SaveQuantity`,
`QuantityHandle`), modal spectra and eigenmodes (`fm.SaveMode`, `fm.SaveSpectrum`,
`fm.SaveEigenDiagnostics`), dispersion and driven-response outputs (`fm.SaveDispersion`,
`fm.SaveResponse`, `fm.GammaResponseAnalysis`, `fm.FiniteKResponseAnalysis`), field snapshots and
planar monitors (`fm.Snapshot`, `fm.PlanarMonitor`), and stage autosave policies
(`fm.TableAutosave`, `fm.FieldAutosave`, `fm.StageAutosave`, `fm.OutputStorage`).

## Additional output, analysis, and export namespaces

| Namespace / API | Key public symbols | Purpose |
| --- | --- | --- |
| Planar monitors | `fm.PlanarMonitor`, `fm.MonitorTarget`, `fm.PlanarFrame`, `fm.PlanarExtent`, `fm.PlaneSample`, `fm.SlabAverage`, `fm.DepthProjection`, `fm.SurfaceProjection`, `fm.SurfaceBoundary`, `study.monitors` | Author 2D slice, slab-average, depth-projection, and surface-projection monitors on objects, regions, or domains (see {doc}`snapshots`). |
| Output storage | `fm.OutputStorage(output_dir, temp_dir, data_format="zarr", cleanup="on_success", existing_output="timestamp")`, `study.storage(...)` | Control run output directory, temporary staging directory, persistence format, cleanup, and collision behavior (see {doc}`autosave` and {doc}`../runtime/artifacts`). |
| Response FFT analysis | `fm.GammaResponseAnalysis`, `fm.FiniteKResponseAnalysis`, `study.stages.fft_response(...)` | Configure time-domain-to-frequency-domain susceptibility and finite-$k$ dispersion post-processing (see {doc}`dispersion-and-response`). |
| Quantity handles & tables | `study.m`, `QuantityHandle.{get,average,region,comp}`, `study.tableadd`, `study.tableautosave`, `study.visualization` | Inspect live quantities and configure tabular expressions or viewport styling (see {doc}`quantities`). |
| Post-processing (`fullmag.analysis`) | `compare_magnetization_textures`, `compare_relaxed_states`, `analyze_stno_artifacts`, `write_stno_report`, `track_vortex_core`, `track_vortex_core_subpixel`, `compute_orbit_metrics`, `fft_from_trace`, `psd_from_trace`, `fit_lorentzian_linewidth`, `linewidth_halfmax`, `linewidth_lorentzian`, `peak_frequency`, `build_tet4_cartesian_restriction`, `build_prism6_cartesian_restriction`, `restrict_fem_magnetization`, `load_fullmag_fem_magnetization`, `load_mumax_magnetization` | Compare FEM/FDM/MuMax3 magnetization states, analyze STNO/vortex trajectories, and compute PSD/Lorentzian linewidths. |
| 3D export (`fullmag.export3d`) | `export_glb`, `export_gltf`, `export_vtu`, `export_pvd`, `export_grid_3d`, `export_mesh_3d`, `export_mode_animation_3d`, `export_result_bundle_3d`, `Export3DResult` | Export structured grids, unstructured meshes, time series, and animated complex eigenmodes to glTF/GLB and ParaView VTU/PVD. |
| Remote client (`fullmag.client`) | `Client`, `CommandHandle`, `Target`, `ApiError`, `CommandFailedError`, `CommandTimeoutError`, `StaleRevisionError`, `ValidationError`, `UnsupportedCapabilityError` | Low-level typed HTTP client for the Control Room / runtime v2 session API. |
| SI unit helpers (`fullmag.units`) | `nm`, `um`, `mm`, `ps`, `ns`, `mT`, `MHz`, `GHz` | Convenience SI scale factors for readable scripts. |

```{toctree}
:maxdepth: 1

fields-and-scalars
quantities
modes-and-spectra
dispersion-and-response
snapshots
autosave
```
