---
title: Studies
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-root)=
# Studies

A study defines what to compute: time evolution (`fm.TimeEvolution`, `study.stages.add_run`),
equilibrium relaxation (`fm.Relaxation`, `study.stages.add_relax`, `study.stages.add_minimize`),
field-sweep hysteresis (`fm.Hysteresis`, `study.stages.add_hysteresis_sweep`,
`study.stages.add_hysteresis_branch`), linearized spin-wave eigenmodes (`fm.Eigenmodes`,
`study.stages.add_eigenmodes`), or driven harmonic frequency response (`fm.FrequencyResponse`,
`study.stages.add_frequency_response`).

Stage pipelines also support utility and multiphysics stage operations on `StudyStagesBuilder`:
`add_save_state`, `add_load_state`, `add_antenna_field_solve`, `add_field_drive`,
`update_field_drive`, `remove_field_drive`, `set_transport_current`, `set_spin_torque_enabled`,
`change_device`, and `fft_response`, as well as single-stage/live helpers (`fm.relax`,
`fm.minimize`, `fm.Minimize`, `fm.run`, `fm.run_while`, `fm.RunWhile`, `fm.FieldOnly`,
`fm.AntennaFieldSolve`). For GPU acceleration of relaxation, time stepping, eigensolves, and driven
response, see {ref}`numerical-methods-performance`.

```{toctree}
:maxdepth: 1

time-evolution
relaxation
hysteresis
eigenmodes
frequency-response
```
