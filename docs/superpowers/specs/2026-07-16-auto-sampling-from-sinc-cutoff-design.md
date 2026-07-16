# Automatic Time-Domain Sampling from Sinc Cutoff

## Status

Approved authoring syntax and numerical rule; implementation pending.

## Problem

Time-domain antenna workflows currently require a numeric sampling period in
both `study.stages.tableautosave(...)` and `study.stages.autosave(...)`. The
user must manually translate a sinc-pulse cutoff into a Nyquist-safe sampling
clock and repeat the same number for scalar and field outputs. The Python DSL
rejects `"auto"` because it immediately converts the value to `float`.

The required public syntax is:

```python
t_sampling = "auto"

study.stages.tableautosave(t_sampling, quantities=["t", "mx", "my", "mz"])
study.stages.autosave("m", every=t_sampling)
```

The symbolic request must survive Python/UI round-trip and must not be reduced
to a UI-only convenience or a Python-only computed literal.

## Numerical Rule

For a target `Run`, let `F` be the set of positive `cutoff_hz` values from sinc
field drives that:

1. were added before that `Run`,
2. remain enabled at that point in the ordered workflow, and
3. are active for that `Run` according to their activation policy.

The effective cutoff and sampling clock are

```text
f_cutoff,max = max(F)
f_guard      = 1.3 * f_cutoff,max
f_sample     = 2 * f_guard
t_sampling   = 1 / f_sample
```

Equivalently:

```text
t_sampling = 1 / (2 * 1.3 * f_cutoff,max)
```

For `f_cutoff,max = 5 GHz`, the target Nyquist frequency is `6.5 GHz`, the
sampling frequency is `13 GHz`, and `t_sampling` is approximately
`76.923076923 ps`.

The factor `1.3` is a canonical fixed safety factor in the first version. It is
not a user-facing tuning parameter. Making it configurable would weaken
reproducibility and is deferred until there is a demonstrated use case.

The runtime event scheduler may shorten integration steps to land on sampling
events. The resolved period therefore does not need to be an integer multiple
of the nominal solver `dt`. A fixed-step backend that cannot land on the clock
must reject the plan rather than silently shift output times.

## Ordered Workflow Semantics

`"auto"` is a requested sampling policy, not an eagerly computed Python value.
Resolution occurs for each `Run` from the workflow state active immediately
before that run. Consequently, one persistent auto Table Autosave instruction
may resolve to different numerical periods for later runs if the active drive
set changes.

An explicit numeric sampling period keeps its current behavior and always wins
over auto resolution for that instruction.

`tableautosave("auto")` defines the response/table clock. An autosave output
with `every="auto"` resolves from the same active-drive rule. When both are
active for one run, they must resolve to the same numerical period. Numeric
autosave cadences remain independent.

If no active sinc drive with a valid positive cutoff exists, auto resolution
fails closed during workflow validation/planning with a diagnostic that names
the auto instruction and target run. It does not guess from solver `dt`, run
duration, sinusoidal frequency, or a UI preview clock.

## Canonical Data Model

The canonical model must preserve requested intent separately from resolved
execution reality.

Sampling cadence is represented as a tagged policy:

```text
explicit { period_s }
auto_sinc_cutoff { nyquist_guard_factor: 1.3 }
```

The requested policy belongs in ProblemIR and scene/study authoring payloads.
The resolved run plan and provenance contain at least:

- requested policy,
- resolved `sample_period_s`,
- source drive identifiers,
- maximum source `cutoff_hz`,
- guard factor,
- target Nyquist frequency,
- sampling frequency,
- target run/stage identifier.

Legacy payloads containing only `sample_period_s` deserialize as the explicit
policy. Existing scripts and artifacts remain valid without migration.

## Python DSL and Script Export

The following inputs are accepted:

```python
study.stages.tableautosave(5e-13, quantities=[...])
study.stages.tableautosave("auto", quantities=[...])
study.stages.autosave("m", every=5e-13)
study.stages.autosave("m", every="auto")
```

Only the exact lowercase token `"auto"` is canonical. Other strings produce a
clear `ValueError`. Boolean values are not accepted as numerical periods.

Script export emits `"auto"` when the requested policy is automatic, even
after execution has produced a resolved numerical period. Export must never
replace the user's automatic intent with a machine-specific resolved literal.

## Planner and Runtime

The planner resolves auto cadence after ordered workflow actions and drive
activation have been resolved for a target run, and before the output event
schedule is constructed. The same backend-neutral resolver serves FDM and FEM,
CPU and GPU.

Backends consume only the resolved positive `sample_period_s`; they do not
independently reimplement the cutoff or safety-factor formula. This prevents
FDM/FEM and CPU/GPU drift.

Validation rejects non-finite or non-positive cutoffs and any unresolved auto
policy reaching backend dispatch. Requested and resolved values are recorded
in stage provenance and sampling artifacts.

## Control Room

The Table Autosave and Autosave stage inspectors offer an `Automatic from sinc
cutoff` mode alongside an explicit period. The ordered stage model resolves
the drives applicable to each following Run.

For auto mode the UI displays:

- source drive names/ids,
- maximum sinc cutoff,
- fixed 30% guard band,
- target Nyquist frequency,
- sampling frequency,
- resolved `t_sampling`,
- run duration, sample count, `df`, and actual Nyquist when a target Run is
  available,
- an explicit unresolved/error state when no active sinc drive applies.

The sinc preview and FFT diagnostics use the same pure shared sampling model.
The UI must not carry a second formula. UI-authored data and exported Python
round-trip through the canonical tagged policy.

## API and Compatibility

OpenAPI authoring schemas expose the tagged requested policy and resolved
sampling diagnostics. Generated frontend types and the typed API facade are
regenerated. No React component may construct endpoint strings or bypass the
resource layer.

Unknown future sampling-policy kinds fail closed and are preserved losslessly
as read-only authoring payloads. Legacy explicit-period payloads remain
accepted.

## Error Handling

Required diagnostics include:

- auto sampling has no active sinc drive for the target run,
- an applicable sinc cutoff is non-finite or non-positive,
- the selected backend cannot land on the resolved sampling events,
- the resolved sample count exceeds an existing bounded preview/analysis
  limit,
- an unsupported sampling-policy token or kind was authored.

Preview-size limits do not invalidate a physically valid runtime sampling
clock; they disable or decimate only the preview and state that explicitly.

## Alternatives Considered

### Python-only eager calculation

The DSL could search its current drive registry and replace `"auto"` with a
float. This was rejected because it loses requested intent, cannot correctly
model later ordered changes, and breaks UI/Python round-trip.

### UI-only convenience

The inspector could calculate a number and save it as an explicit period. This
was rejected because headless scripts would differ from UI-authored studies and
the exported script would lose automatic semantics.

### Canonical symbolic policy

The selected approach preserves intent in the canonical model and resolves it
once in backend-neutral planning. It has a larger cross-layer implementation
surface but is the only approach consistent with Fullmag's public contract.

## Verification

Required tests cover:

1. Python acceptance and serialization of both numeric and `"auto"` periods.
2. Rejection of unsupported strings, booleans, and invalid numeric values.
3. Python script export and reload preserving `"auto"`.
4. ProblemIR legacy explicit-period compatibility and tagged-policy round-trip.
5. Maximum cutoff selection across multiple active sinc drives.
6. Exclusion of disabled, not-yet-added, or activation-inapplicable drives.
7. A `5 GHz` cutoff resolving to a `6.5 GHz` target Nyquist and
   `1 / 13 GHz` period.
8. Fail-closed behavior when no applicable sinc drive exists.
9. Identical resolution for table autosave and `every="auto"` field autosave.
10. Planner provenance containing requested and resolved sampling facts.
11. Runtime event times landing on the resolved clock for supported FDM and FEM
    time integrators.
12. UI authoring, inspector diagnostics, generated OpenAPI types, and canonical
    Python export.
13. The periodic-antidot example loading successfully with
    `t_sampling = "auto"`.

## Scope Boundaries

This change does not automatically choose run duration, sinc center `t0`, FFT
window, solver integration `dt`, or spatial sampling. It does not infer a
bandwidth from non-sinc waveforms. Those remain independently authored.

