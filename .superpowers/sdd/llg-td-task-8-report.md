# Task 8 report: finite, norm, rotation, and normalization guards

## Outcome

Task 8 makes native FEM explicit RK attempts fail closed on invalid active
magnetization vectors and on enabled norm/rotation limits. CPU and CUDA use
the accepted pre-attempt state and the unnormalized high-order candidate for
relative scaling and geometry guards. Nonmagnetic shared-domain/airbox nodes
are excluded consistently.

The legacy FEM adaptive C layout remains unchanged. Guard-capable adaptive
plans use the versioned `fullmag_fem_adaptive_config_v2` and
`fullmag_fem_backend_create_v2` boundary.

## Physics and controller semantics

- Advanced relative scaling is
  `atol + rtol * max(||m_old||, ||m_hi||)` per active node.
- Norm defect is measured before normalization.
- Spin rotation is measured against the accepted pre-attempt state and enters
  the acceptance metric independently of the embedded RK estimate.
- Zero, subnormal-norm, NaN, and Inf active vectors fail closed; normalization
  is not used as a repair.
- Inactive airbox nodes are skipped before finite/norm checks on both CPU and
  CUDA.

## Transaction and runtime behavior

- Every CPU intermediate stage uses guarded active-node normalization.
- The CPU high-order candidate is guarded before normalization. Rejected or
  invalid attempts restore magnetization, preserve time and step count, and
  invalidate the rejected FSAL candidate.
- CUDA stage normalization reduces invalid-vector state on device and copies
  one bounded scalar flag to the host. Adaptive error, norm, and rotation
  reduce on device over active nodes.
- CUDA preserves the unnormalized high-order candidate in device workspace for
  error/geometry measurement. Stage, normalization, reduction, readback, and
  decision failures restore `m_backup` before returning.

## ABI compatibility

- `fullmag_fem_adaptive_config` and `fullmag_fem_backend_create` retain their
  legacy layout and interpretation.
- `fullmag_fem_adaptive_config_v2` starts with `abi_version`, `struct_size`, and
  the complete legacy base before optional guard fields.
- `fullmag_fem_backend_create_v2` validates version and exact size before
  interpreting the v2 tail. The Rust FFI and native FEM runner construct and
  call v2 only for adaptive plans.
- Stale version/size and invalid enabled guard values fail before stepping.

## Verification

Authoritative managed native gate:

```text
env COMPOSE_PROJECT_NAME=fullmag-llg-time-domain-remediation \
  just verify-fem-time-domain-native-contract
FEM CUDA Zhang-Li skew-tetra numeric contract PASS
FEM CUDA RK guard contract PASS
PASS: FEM relaxation energy derivative matrix
exit 0
```

The first full ABI rebuild reached the native library and contract compilation
but exceeded the 240-second command limit. The cached rerun executed the whole
gate successfully. Subsequent guard-test and inactive-airbox reruns also exited
zero.

Additional gates:

```text
cargo check -p fullmag-fem-sys       # passed
cargo check -p fullmag-runner        # passed; two pre-existing dead-code warnings
cargo test -p fullmag-plan --lib     # 230 passed
cargo test -p fullmag-runner --lib   # 561 passed
git diff --check                     # passed
```

Host tests used an isolated `/tmp` Cargo target because the managed container
owns the worktree `target/` directory. The managed native gate remains the
authoritative C++/CUDA/MFEM proof.

## Focused regression coverage

- CPU relative-only tolerance ignores a zero inactive airbox node.
- CPU production RK rejects norm and rotation guards at `dt_min` with exact
  magnetization/time/step rollback.
- CPU production RK injects nonfinite intermediate stages and a nonfinite
  high-order candidate and proves exact rollback.
- CPU helper contracts cover zero, subnormal, NaN, and Inf active vectors.
- Executed CUDA contract covers active zero/subnormal/NaN/Inf rejection without
  repair, inactive-airbox skip, and valid normalization.
- C++ and Rust layout contracts preserve the legacy config size and v2 base
  offset; v2 stale size fails closed.

## Review

- Specification review: APPROVED after CPU airbox masking, ABI v2, and runtime
  rollback coverage were added.
- Quality review: APPROVED after confirming legacy ABI preservation, production
  CPU rollback, executable CUDA guard behavior, and attempt-loop restoration.

## Honest residual limits

1. The CUDA contract executes the production guarded normalization kernel and
   the managed build verifies all production stage call sites; it is not a
   full physical CPU/GPU trajectory qualification.
2. Candidate field/work/demag-cache atomicity remains Task 10.
3. Demagnetization convergence failure propagation remains Task 9.
4. FDM guard intent remains transported but fail-closed until a separately
   qualified FDM enforcement task; Task 8 is the FEM guard implementation.
