# ADR 0021: Calibrated FEM runtime crossover policy

- Status: accepted for implementation
- Date: 2026-07-27
- Owners: Fullmag runtime and native FEM maintainers
- Supersedes: node-count-only FEM auto-device selection and the FEM GPU
  fallback example in `runtime-distribution-and-managed-backends-v1.md`

## Context

FEM runtime selection currently has an opt-in
`FULLMAG_FEM_GPU_MIN_NODES` threshold. Node count alone cannot predict the
relative cost of the MFEM/hypre CPU and CUDA lanes: assembled operator size,
demagnetization, relaxation algorithm, preview work, runtime build, and exact
hardware identity materially change the crossover. More importantly, a
performance heuristic must never override explicit user intent.

The available RTX 4080 SUPER measurements are red/noisy baseline evidence,
and the broader attribution work is still blocked. They do not qualify an
active production crossover profile.

## Decision

### Requested intent is a hard boundary

The existing public device vocabulary remains `cpu | gpu | auto`.

- Explicit `cpu` always resolves to CPU or fails if that exact lane is not
  executable.
- Explicit `gpu` always resolves to GPU or fails closed if its runtime,
  capability, or hardware is unavailable.
- A performance crossover is evaluated only for requested `auto`, independent
  of `strict`, `extended`, or `hybrid` execution mode. It never creates a new
  hybrid lane or changes backend legality.

Provenance and the v2 status resource publish `requested`, `resolved`,
`reason`, optional `calibration_id`, and optional `confidence`. An explicit
request therefore remains distinguishable from `auto -> cpu` or `auto -> gpu`.

### Feature ownership

`FemCrossoverFeatures` contains:

- `node_count` from the planned mesh,
- optional `matrix_nnz`,
- `demag_enabled`,
- the canonical relaxation algorithm token,
- `preview_enabled`.

The native assembled FEM operator owner is the canonical future owner of
matrix rows and nonzero count. It may publish a read-only operator summary
after assembly. `FemPlanIR` is not extended merely for this selector, and the
runtime must not estimate or invent `matrix_nnz`. Until that summary is
available before selection, `matrix_nnz` is `None`; profiles whose matching
stratum requires it are inapplicable and selection uses the fallback below.

### Profile v1

An applicable `FemCrossoverProfileV1` is generated offline and contains:

- schema version and stable calibration ID;
- qualification state and confidence;
- sample strata keyed by feature vector and fixture ID;
- CPU/GPU p50, p95, standard deviation, and sample count;
- warmup and repeat policy;
- hysteresis lower and upper bounds plus the calibrated preference inside the
  band;
- runtime bundle and native-library SHA-256 hashes;
- GPU UUID, name, compute capability, driver, and CUDA toolkit;
- CPU identity;
- profile SHA-256; schema v1 reserves a nullable `signature` field but does not
  accept a non-null value.

The profile hash covers the canonical unsigned serialized payload with both
`profile_sha256` and `signature` omitted. Schema v1 has no signing algorithm,
key identifier, trust-root, or verification policy, so a non-null signature is
unsupported and rejected. A later schema may add signatures only together
with those missing trust semantics.

Loading is fail closed: unknown schema, unqualified status, malformed or
mismatched hash, GPU identity mismatch, runtime/library hash mismatch, or a
feature stratum that requires unavailable values rejects the profile. Runtime
identity must be derived from the selected managed-runtime manifest, the
libraries actually loaded, and the detected GPU; caller-provided profile and
identity JSON cannot attest to each other. The current runtime registry does
not yet expose that joined authoritative identity, so production profile
activation remains deliberately unavailable and `auto` uses the no-profile
behavior below. `FULLMAG_FEM_CROSSOVER_RUNTIME_IDENTITY` is ignored and untrusted;
it has no production or diagnostic consumer and cannot activate or attest to a
profile. A profile for one GPU is never applied to another GPU.

The selected stratum resolves CPU below its lower bound, GPU above its upper
bound, and its recorded stable preference inside the hysteresis band. Runtime
selection reads this data only; it never performs a CPU/GPU trial solve in a
user run.

Selection is one atomic operation. The decision used to choose the engine is
pinned in the engine/session result and threaded unchanged into run artifacts,
the CLI session manifest, v2 status, and persistent interactive-runtime
provenance. Those consumers never reload the profile. Preview is supplied from
the real execution cadence (`field_every_n != u64::MAX`), not invented problem
metadata; batch and idle snapshot paths explicitly select no-preview.

### No-profile behavior and debug override

When no qualified, identity-matching profile is available, requested `auto`
keeps the existing availability-first GPU preference. If GPU is unavailable,
normal capability resolution may choose CPU and records that reason. This is
not a performance claim.

`FULLMAG_FEM_GPU_MIN_NODES` remains temporarily as an explicit debug override
for `auto` only and emits a deprecation warning. It has no effect on explicit
CPU/GPU. It is removed after two releases containing a distributed qualified
profile and profile-selection telemetry, or when profile schema v2 ships,
whichever happens first.

### Distribution and API

Managed runtime packaging may ship crossover profiles beside the runtime
manifest. A profile is active only after the runtime registry exposes, and the
selector independently derives, one authoritative identity covering that
manifest, loaded native libraries, and detected device. Merely pointing two
environment variables at matching JSON files never activates it. The checked-in
`benchmarks/fem-gpu/crossover/rtx4080-sm89.json` is deliberately unqualified
and cannot affect runtime selection.

The resource-first v2 status JSON carries only the small decision summary.
Benchmark distributions and profiles remain artifacts/data-plane resources;
they are not embedded in status. Control Room consumes generated types and the
central session resource hooks, with no direct fetch or alternate state owner.

## Consequences

- Explicit requests become predictable and fail closed.
- Auto selection is reproducible and auditable without adding a public enum.
- Unqualified or stale benchmark data cannot silently change user execution.
- Matrix structure can improve a future profile without leaking numerical
  storage layout into public problem semantics.
- Until qualified calibration exists, auto remains availability-first rather
  than pretending the current measurements establish a crossover.

## Rollback

Disable profile discovery and retain availability-first `auto`; explicit
device behavior and decision provenance remain unchanged. Do not restore the
node-count threshold as a production policy.

## Acceptance

- RED/GREEN tests prove explicit GPU is not switched by the debug threshold.
- Profile tests cover lower/upper hysteresis decisions and rejection of bad
  profile hash, unsupported signatures, GPU identity, and library hashes.
- Tests prove caller JSON cannot self-attest, resolution is pinned across
  profile mutation/removal, preview uses real cadence, and request precedence
  is deterministic.
- Managed FEM relaxation, time-domain, and frequency-domain contract gates
  pass through repository `just` recipes.
- Generated v2 API types, Control Room typecheck, lint, and tests pass.
