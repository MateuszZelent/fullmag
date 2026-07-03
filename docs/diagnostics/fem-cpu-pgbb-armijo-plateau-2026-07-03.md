# FEM CPU PG-BB Armijo Plateau Diagnostic - 2026-07-03

## Scope

This report diagnoses the interactive Fullmag failure:

```text
RunError: projected-gradient BB relaxation failed Armijo line search after 40 backtracks;
previous state restored; current_energy_j=-0.000000 last_trial_energy_j=-0.000000
armijo_rhs_j=-0.000000 last_trial_step=0.000000
direction_dot_gradient=-0.000000 gradient_norm_sq=0.000000
```

The failing run was the managed FEM runtime launched through the control room.
The live stage was `stage_00_flat_relax` for session
`session-1783087152623-852584`.

## Primary Evidence

- The error string is owned by
  `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`, not the CUDA
  PG-BB implementation. The relevant lane is FEM CPU/MFEM direct minimization.
- The corresponding live scalar artifact is
  `.fullmag/local-live/history/session-1783087152623-852584/stages/stage_00_flat_relax/scalars.csv`.
- The scalar trace contains 300 accepted rows plus the header. It stops exactly
  at the terminal step shown in the log.
- `E_total` is not physically zero. The log printed zeros because the exhausted
  Armijo diagnostics used `std::to_string`, which rounds joule-scale values near
  `1e-18` to six fixed decimal places.

Scalar summary from the live artifact:

```text
rows=300
first E_total = -2.10606993587589587e-18 J
last  E_total = -2.30826646370159010e-18 J
net dE        = -2.02196527825694228e-19 J
energy increases = 0
last max_torque_T = 4.64432536184433437e-03 T
```

Late-stage energy deltas:

```text
step=297 E_total=-2.30826645019070004e-18 dE=-7.58970243914756105e-24 dt=5.000000000000000e-07
step=298 E_total=-2.30826645914017409e-18 dE=-8.949474050894795e-27 dt=9.570594235286124e-09
step=299 E_total=-2.30826646370158317e-18 dE=-4.561409072955673e-27 dt=6.448495345998975e-09
step=300 E_total=-2.30826646370159010e-18 dE=-6.933347799794049e-33 dt=3.928743397813841e-13
```

The accepted trajectory is monotone. The final accepted energy improvement is
about `7e-33 J`, far below the meaningful energy resolution of a FEM energy
sum at `2.3e-18 J` scale. The terminal `dt=3.928743397813841e-13` shows the
line search was already driven into a near-zero step regime.

## Root Cause

The CPU/MFEM `projected_gradient_bb` Armijo loop required strict Armijo
sufficient decrease for every main-loop trial and only accepted a recovery
trial when `trial_energy <= current_energy` exactly. At the observed energy
scale, the accepted run had already reached an energy plateau where additional
decrease is below floating-point/reduction noise.

The CUDA PG-BB implementation and CPU NCG recovery path already had the right
numerical idea: allow a bounded monotone/noise-level acceptance window using:

```text
max(1e-23 J, 1e-12 * max(abs(E_current), abs(E_trial)))
```

CPU/MFEM PG-BB did not apply that policy in the main Armijo loop, and its
failure diagnostics hid the actual magnitudes.

## Rejected Hypotheses

- Physical energy was zero: rejected. The CSV records `E_total` near
  `-2.308e-18 J`; the zero-looking values were formatting artifacts.
- Energy was increasing: rejected. The accepted scalar rows have zero positive
  `E_total` increments.
- This was the previous GPU PG-BB failure class: rejected. The error string
  lacks the `GPU` prefix and includes `direction_dot_gradient`, matching the
  CPU/MFEM PG-BB implementation.
- The web/control-room process caused the numerical failure: rejected for the
  solver root cause. The web process failed because the parent runtime aborted
  after the native solver returned an error.

## Source Fix

Changed `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp` to:

- add the same finite-energy, noise-level monotone acceptance window used by
  the maintained direct-minimizer paths;
- apply it in the main CPU/MFEM PG-BB Armijo loop before exhausting
  `kProjectedGradientMaxBacktracks`;
- apply it in recovery through a named helper instead of exact
  `trial <= current` comparison;
- format exhausted-line-search diagnostics with scientific notation and
  17-digit precision.

Changed `backends/fem/tests/relaxation_source_contract.cpp` to protect the new
CPU/MFEM PG-BB contract.

Changed `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` to document
the tolerance as a finite-precision numerical safeguard, not a physical
relaxation tolerance.

## Verification

Completed:

```text
just verify-fem-relaxation-source-contract
```

Result: passed in the FEM build container after the source fix.

Completed:

```text
just ensure-managed-fem-runtime
```

Result: passed after the managed runtime export rebuilt the bundle. The fresh
runtime executable is
`.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu`.

Attempted but not counted as a complete runtime proof:

```text
just run-cofeb-rings-relax-headless cpu
```

This started the same example family through the managed runtime and reached
stage 1 CPU/MFEM steps, but the current checkout materialized a much larger
mesh than the failing pasted log:

```text
current attempt: 144565 nodes, 907012 tetrahedra, legacy_mag_len=433695
pasted failure:  legacy_mag_len=64356, about 21452 magnetic vector nodes
```

The attempt was manually interrupted after stage 1 reached step 6 because the
current mesh made an exact step-300 window proof impractical for an interactive
diagnostic run. Its exit code was therefore 130 and it must not be reported as
passing the full runtime scenario.

The remaining end-to-end proof is to rerun a mesh-equivalent version of the
failing case, or a bounded reproduction fixture, until it crosses the old
step-300 Armijo failure window without aborting.
