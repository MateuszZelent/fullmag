# Arch Waveguide Production Mesh Diagnostic

- Date: 2026-05-30
- Script: `examples/arch_waveguide_relax_50nm.py`
- Command: `PYTHONPATH=packages/fullmag-py/src FULLMAG_GMSH_THREADS=8 /usr/bin/time -v .fullmag/local/python/bin/python -m fullmag.runtime.helper export-run-config --script examples/arch_waveguide_relax_50nm.py --backend fem`
- Result: passed
- Wall time: 0:14.38
- Peak RSS: 234,340 KB

## Interactive Budget

| Metric | Limit | Measured | Status |
|---|---:|---:|---|
| Total nodes | 75,000 | 30,029 | passed |
| Total tetrahedra | 450,000 | 187,077 | passed |
| Legacy dense FEM RAM estimate | 12 GiB default guard | 21.64 GB | not applicable for `poisson_robin` |

`poisson_robin` demag does not use the legacy dense FEM demag guard, so the
dense RAM estimate is recorded for visibility but is not an auto-coarsening
trigger for this example.

## Mesh Counts

| Scope | Nodes | Tetrahedra | Boundary faces |
|---|---:|---:|---:|
| Total shared domain | 30,029 | 187,077 | not recorded in verifier summary |
| Airbox | 27,511 | 149,821 | not recorded in verifier summary |
| Magnetic domain | 9,492 | 37,256 | not recorded in verifier summary |

Node counts are scoped counts. Shared interface nodes can belong to both the
airbox and magnetic-domain scopes, so scoped node counts are not expected to sum
to the global node count.

## Size And Quality

| Scope | Characteristic size p95 | Characteristic size p99 | SICN p5 | Notes |
|---|---:|---:|---:|---|
| Airbox | 143.97 nm | 235.34 nm | 0.367 | `extreme element volume ratio`, `minimum gamma below quality target` warnings |
| Magnetic domain | 43.08 nm | 44.40 nm | 0.497 | `minimum gamma below quality target` warning |

## Preset Adjustment

The detailed timed run with the current preset produced 11,151 nodes and
66,729 tetrahedra in 0:14.38 wall time with 234,340 KB peak RSS. The verifier
run produced 30,029 nodes and 187,077 tetrahedra in 50.82 seconds. This
variation is attributed to Gmsh tetrahedral generation variability; both current
runs are below the declared interactive budget.

The managed runtime smoke was refreshed on 2026-05-31 as
`FULLMAG_ARCH_RELAX_MAX_STEPS=1 just run-arch-waveguide-managed-headless script 8`
outside the sandbox after re-exporting the managed FEM runtime bundle with
OpenMPI/PMIx runtime components and help data. It completed successfully:
the final run mesh had 11,091 nodes, 66,355 tetrahedra, and 14,180 boundary
faces, reached `fem_cpu_native`, executed one relaxation step, and reported
`status=completed`. The earlier `MPI_Init_thread` failure was a managed
runtime packaging issue, not a mesh materialization failure.

The first measured interactive preset produced 140,489 nodes and 883,366
tetrahedra in 3:46.35 wall time with 2,203,920 KB peak RSS. A second preset
that only relaxed the explicit airbox plume still produced 150,355 nodes and
980,599 tetrahedra with `FULLMAG_GMSH_THREADS=8`, because the fine magnetic
interface forced a dense conforming air mesh. The current preset is explicitly
preview-grade: it keeps a local skyrmion-resolution patch, coarsens the global
magnetic body target, and leaves tighter production studies to explicit script
edits.
