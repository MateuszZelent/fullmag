# FEM Zhang-Li Compatibility Note

## Solver marker

`FEM-TD-PHY-STT-001` is fixed by the native FEM source revision that assigns
P1 tetrahedron gradients from rows of the inverse edge matrix. The versioned
fixture `fem_td_zhang_li_skew_tet_affine_v1` identifies the corrected geometry
contract and records a managed CPU/CUDA runtime log when run.

## Scientific compatibility boundary

CPU Zhang-Li trajectories produced before this marker on non-orthogonal
tetrahedra are not scientifically comparable with corrected results. They used
columns instead of rows of the inverse edge matrix, so both the direction and
amplitude of `(u dot grad)m` can differ. Re-run those studies from their input;
do not combine their observables, fitted parameters, or trajectories with
post-fix data.

This note does not promote any STT capability to `validated`. The named
skew-tetra fixture now evidences public requested/resolved CPU/GPU provenance,
a fixed-step public Heun trajectory of exactly ten steps, and frozen
three-level fixed-final-time `dt` and mesh convergence studies. That evidence
qualifies only this named skew-tetra Zhang-Li workload. Other geometries,
solvers, boundary conditions, and interaction combinations remain unqualified.
