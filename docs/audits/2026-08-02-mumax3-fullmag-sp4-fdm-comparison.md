# MuMax3–Fullmag FDM: µMAG Standard Problem 4 comparison

Date: 2026-08-02

## Status

The two physical simulations were executed and their final magnetization
fields were compared on the same `128 x 32 x 1` Cartesian grid. The numerical
agreement is good, but this run is not a complete current-HEAD table/telemetry
qualification: the local Fullmag launcher was built on 2026-07-27 and the
attempt to rebuild it from the current checkout is blocked by an unrelated
CLI/runner `coupled_checkpoint` compilation mismatch.

## Common physical problem

| quantity | value |
|---|---:|
| domain | `500 x 125 x 3 nm` |
| cells | `128 x 32 x 1` |
| cell size | `3.90625 x 3.90625 x 3 nm` |
| `Ms` | `800 kA/m` |
| `Aex` | `13 pJ/m` |
| `alpha` | `0.02` |
| initial `m` | `(1, 0.1, 0)` normalized to `(0.9950371902, 0.0995037190, 0)` |
| external field | zero |

MuMax3 used `minimize()`. Fullmag used CPU/FDM `projected_gradient_bb` with
`tolT=1e-6 T`; it stopped after 342 accepted steps at
`max_torque=8.3994e-7 T`.

## Executed artifacts

MuMax3 was built and executed in the local CUDA image
`mumax3-build:latest` on an NVIDIA GeForce RTX 4080 SUPER (CUDA 12.4,
MuMax3 3.12):

```text
.fullmag/reports/mumax-fullmag-validation-smoke/mumax-build/mumax-sp4-energy/table.txt
.fullmag/reports/mumax-fullmag-validation-smoke/mumax-build/mumax-sp4-energy/m000000.ovf
```

Fullmag was executed with:

```text
.fullmag/reports/mumax-fullmag-validation-smoke/sp4_fdm_pgbb.py
```

The final field and solver provenance are in:

```text
.fullmag/local-live/history/session-1785654947421-2/stages/stage_00_flat_relax/m_final.json
.fullmag/reports/mumax-fullmag-validation-smoke/fullmag-sp4-pgbb/states/relaxed_m.zarr.zip
```

## Global averages and units

`m` is the reduced/normalized magnetization and is dimensionless (`1`). The
Fullmag table schema identifies `mx`, `my`, and `mz` as `reduction=average`,
`dimension=normalized_magnetization`, `unit=1`. Energy is in joules and the
torque threshold is reported in tesla (with the corresponding `A/m` value in
Fullmag telemetry).

The MuMax3 run that also saved `E_total` reported:

```text
mx = 0.96696650
my = 0.12527856
mz = 0
E_total = 6.261341e-19 J
```

Independent averaging of the MuMax3 OVF gave:

```text
(0.96696658, 0.12527857, 0)
```

The storage-vs-table discrepancy is below `8.4e-8` per component.

Independent averaging of Fullmag's final `m_final.json` gave:

```text
(0.96696102, 0.12528809, -1.9e-27)
```

The Fullmag final energy was `6.297777e-19 J`, a difference of
`3.6436e-21 J` (`0.5819%`) from the MuMax3 run.

## Texture comparison

The comparison used all 4096 common cells and the same `(x, y, z)` component
order:

| metric | `mx` | `my` | `mz` |
|---|---:|---:|---:|
| mean Fullmag − MuMax3 | `-5.561e-6` | `+9.521e-6` | `-1.895e-27` |
| MAE | `5.569e-6` | `9.802e-6` | `2.225e-14` |
| RMSE | `1.447e-5` | `1.842e-5` | `2.855e-14` |
| maximum absolute error | `8.132e-5` | `7.101e-5` | `1.118e-13` |

Vector RMSE is `2.342e-5`; the maximum per-cell vector error is `1.041e-4`.
These differences are consistent with two different minimizer
implementations stopping at slightly different points, not with a component
swap or an incorrect physical unit.

## Table/telemetry finding

The Fullmag PGBB artifact contains the initial table row and the final field,
but the stale launcher did not materialize a final accepted-step table row or
final telemetry row for this pseudotime relaxation. A time-based table cadence
cannot be used as proof for a zero-physical-time minimizer stage. This must be
rechecked with a freshly built current-HEAD launcher using the accepted-step
stage autosave path before declaring the table/telemetry contract closed.

The current checkout cannot currently produce that launcher because
`cargo build -p fullmag-cli --release` fails on pre-existing
`coupled_checkpoint` references in `crates/fullmag-cli` that are absent from
the current `fullmag-runner` API. No unrelated source was changed to bypass
that blocker.

## Conclusion

The solver-level FDM comparison passed for the final magnetization texture:
global component differences are about `1e-5`, and the normalized field units
are consistent. The table/telemetry end-to-end gate remains open until the
current checkout is buildable and the final accepted PGBB row is observed in
both `table.csv` and telemetry.
