# Fullmag Magnetoelastic Frequency Patch Specs

Status: patch contract for staged implementation
Last updated: 2026-05-20
Source report: `docs/reports/20.05.2026/backend_deep_report.md`
Related plan: `docs/plans/fullmag_magnetoelastic_frequency_implementation_plan.md`

## Scope

This spec defines the contract boundary for frequency-response and coupled
magnetoelastic work. It separates public semantics from executable backend
support. A type or artifact may be legal in IR before any backend can run it,
but execution must be rejected unless the backend capability says otherwise.

## Study And IR Types

Semantic concepts:

These types live in `crates/fullmag-ir/src/frequency_response_contract.rs`; `eigen_contract.rs` keeps only the magnetic eigen helper contract.

- `StudyIR::FrequencyResponse`
- `FrequencyResponseStudyFieldsIR`
- `FrequencyExcitationIR`
- `FrequencySweepIR`
- `FrequencyResponseNormalizationIR`
- `DampingPolicyIR`
- `SpinWaveBoundaryIR`
- `ResponseObservableIR`
- `FrequencyResponseOutputIR`
- `OutputIR::FrequencyResponseOutput`
- future `CoupledModeTrackingIR`

`StudyIR::FrequencyResponse` must describe a driven linear response without
selecting a backend implementation. Minimum public fields:

```text
dynamics
operator
equilibrium artifact path
optional k_sampling
normalization
damping_policy
spin_wave_bc
excitation
frequencies_hz
sampling/output request, including `frequency_response_output` observables
```

The study is valid only when frequencies are finite and positive, excitation
components are finite, equilibrium references are non-empty, and requested
outputs are compatible with frequency-domain response or modal data. Public Python authoring uses `fm.SaveResponse(...)` for response observables, with flat-script equivalents `fm.save_response(...)` and `fm.frequency_response(...)`, and must not disguise response output as `SaveSpectrum`.

## Planner Contract

- If the study is semantic-only, the planner must reject execution with an
  explicit diagnostic.
- The diagnostic must name driven frequency-domain execution, not generic study
  incompatibility.
- Rejection must happen before a backend launches.
- Future executable lanes must still reject unsupported combinations such as
  nonzero-k demag without a valid dynamic demag-k operator.

The current public contract keeps `StudyIR::FrequencyResponse` semantic-only for
all public FDM and FEM lanes.

## Runtime Capability Contract

| Field | Meaning | Current value |
|---|---|---|
| `supports_frequency_response` | driven magnetic frequency response can execute | false for all current engines |
| `supports_coupled_magnetoelastic_quasistatic` | two-way quasistatic mechanics can execute | false for all current engines |
| `supports_coupled_magnetoelastic_elastodynamic` | time-domain elastodynamic two-way mechanics can execute | false for all current engines |
| `supports_frequency_domain_elastodynamics` | harmonic elastodynamic mechanics can execute | false for all current engines |
| `supports_coupled_eigenmodes` | coupled magnon-phonon eigenmodes can execute | false for all current engines |

Do not collapse these fields. Prescribed-strain magnetoelasticity,
magnetic-only FEM eigenmodes, and future driven response are different
capabilities with different acceptance gates.

## Backend Contracts

### Magnetic-only frequency response

The first executable driven response backend must solve in the tangent plane of
the equilibrium magnetization. Required diagnostics:

- frequency value in Hz and angular frequency in rad/s;
- residual norm per frequency;
- tangent leakage diagnostic;
- excitation provenance;
- solver model and damping policy;
- warm-start or no-warm-start provenance across sweep points.

### Quasistatic mechanics

Bidirectional quasistatic magnetoelasticity must include a mechanics owner, not
only `mel_*` compatibility fields. The first executable slice may require
`Omega_m == Omega_s` and same-mesh transfer. If those conditions are not met,
the planner or backend must reject.

Required diagnostics:

- elasticity residual norm;
- rigid-body constraint status;
- `H_mel`, `u`, `eps`, `sigma`, `E_mel`, and `E_el` provenance;
- solver/preconditioner reuse status;
- accepted-step allocation and host/device transfer checks for performance lanes.

### Elastodynamics

Frequency-domain elastodynamics must be a separate harmonic mechanics operator
family. It must not be enabled by the quasistatic capability flag. Damping,
mechanical boundary conditions, and inertial terms must be explicit.

### Coupled eigenmodes

Coupled magnon-phonon eigenmodes require a block operator and mode tracking that
can identify hybridized branches. They must not be inferred from separately run
magnetic and mechanical spectra.

## Artifact Contracts

Magnetic-only eigen and dispersion artifacts remain governed by
`docs/specs/frequency-domain-artifacts-v2.md`.

Driven response artifacts should add:

- `m_complex`
- `susceptibility_tensor`
- `absorbed_power_density`
- `response_amplitude`
- `response_phase`
- residual per frequency
- excitation provenance

Coupled magnetoelastic response adds:

- `u_complex`
- `strain_complex`
- `stress_complex`
- `elastic_residual_norm`
- `mode_hybridization_index`
- branch anticrossing diagnostics when coupled eigenmodes are enabled.

Every artifact must state schema version, SI units, backend engine id, solver
model, damping policy, and lane classification.

## UI And API Contracts

- Semantic-only features can be authored or inspected.
- Execution controls must be disabled or rejected with the backend diagnostic.
- Missing optional artifacts must show explicit diagnostics.
- Plots must not synthesize empty spectra or response curves as success.

API resources must expose missing optional artifacts as diagnostic 404 responses
and keep requested versus resolved backend information visible.

## Test Contracts

Minimum contract tests:

- `StudyIR::FrequencyResponse` round-trips as a first-class study;
- invalid frequency vectors are rejected;
- invalid excitation vectors are rejected;
- planners reject semantic-only response execution explicitly;
- all current runtime capability constructors keep the five deferred flags false;
- Python `FrequencyResponse` lowers to first-class IR, emits `frequency_response_output` via `fm.SaveResponse`, supports flat `fm.save_response(...)`/`fm.frequency_response(...)` rewrite round-trips, rejects invalid shared eigen options, and keeps `SaveResponse` out of `Eigenmodes`.

Minimum future numerical gates:

- energy/field consistency for magnetoelastic coupling;
- tangent-space leakage for frequency-domain magnetic operators;
- rigid-body nullspace rejection or constraint validation;
- frequency sweep residual convergence;
- branch tracking under mode crossing;
- CPU/GPU parity for any production label;
- no accepted-step hot-loop heap allocation;
- no hidden host/device sync in GPU accepted-step paths.

## Benchmark Contracts

Every executable promotion must record backend engine id, mesh size, degree of
freedom count, solver policy, preconditioner, mode or frequency count, hardware,
wall time, iteration counts, residuals, and validation summary.

## Compatibility Rules

- Existing prescribed-strain magnetoelastic inputs remain backward compatible.
- Existing v2 eigen artifacts remain readable.
- New response artifacts must use new schema names rather than silently changing
  eigen artifact semantics.
- Capability flags default to false for old serialized records when possible.
- Docs and examples must name semantic-only status until execution is real.
