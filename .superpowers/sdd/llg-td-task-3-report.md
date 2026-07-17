# Task 3: lossless adaptive ProblemIR and fail-closed lane legality

## Outcome

Canonical writers emit ProblemIR `0.3.0` and every current adaptive payload
must explicitly carry `tolerance_mode`. Current `0.3.0` payloads missing the
field fail deserialization. Read migration for `0.2.0` and `0.1.0` adds
`advanced` only at canonical study dynamics paths; `0.1.0` also migrates
legacy cylinder axes. Omitted adaptive values and opaque metadata are preserved.

IR validation now covers finite gamma, exactly-one timestep policy, every
adaptive scalar and controller bound, mode semantics, field refresh, and global
runtime-selection shape/device/precision metadata.

Planner/runtime legality is fail closed:

- adaptive FDM requires explicit `runtime_selection.device='cpu'`; `auto`, GPU
  and CUDA reject because they may reach a non-lossless CUDA ABI;
- multilayer FDM rejects adaptive stepping on every lane;
- native FEM advanced mode temporarily requires both `atol>0` and `rtol>0`,
  rejects max-error mode and `safety=1` until native parity work;
- unsupported spin/norm guards reject before materialization;
- active CUDA single-grid execute/create boundaries, the future construction
  boundary, and multilayer CPU/CUDA/native-stacked boundaries duplicate guards
  before allocation/FFI.

Interactive run and LLG relaxation use one exactly-one policy resolver. Fixed
selection clears adaptive state; selecting RK23/RK45 over fixed state requires
an existing complete bounded policy; legacy scalar `max_error` commands reject.

## Verification

- `cargo test -p fullmag-ir`: 49 unit + 132 integration passed.
- `cargo check -p fullmag-plan -p fullmag-runner -p fullmag-cli`: passed; two
  pre-existing runner dead-code warnings.
- focused planner explicit-CPU and FEM both-positive tests: passed.
- `cargo test -p fullmag-cli interactive_`: 14 passed.
- Python solver/API focused suite: 25 passed + 24 subtests.
- direct CPU multilayer runner guard: passed.
- full planner gate: 229 passed. The pre-existing Floquet-airbox fixture
  failure was repaired by separating periodic face markers `10/11` from the
  independently certified outer boundary marker; production planner logic was
  unchanged.
- `git diff --check`: passed.

CUDA-feature unit tests require the managed native build environment and cannot
be executed by the host-only Rust toolchain.
