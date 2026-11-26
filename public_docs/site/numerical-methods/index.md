---
title: Numerical Methods
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-root)=
# Numerical Methods

This family documents algorithms that operate on an already defined spatial discretization:
time integration, relaxation, demagnetization solves, eigensolvers, frequency-domain response, and
state transfer.

Meshing is intentionally owned by the Backend branch at {doc}`meshing/index`, because geometry
realization, topology, airbox construction, and quality governance form an independent subsystem.

For coupled bidirectional magnon–phonon numerical methods, elastodynamic time integrators,
HPC/CUDA/AVX-512/MPI optimizations, and FullMag's pinned sparse/multigrid library stack
(`cuDSS`, `oneMKL PARDISO`, `MFEM`, `libCEED`, `Hypre`, `PETSc`, `SLEPc`, `MUMPS`, `ParMETIS`),
see {doc}`/physics/interactions/magnetoelastic/numerical-methods-and-libraries`.

```{toctree}
:maxdepth: 2

time-integration/index
relaxation/index
demag-solvers/index
eigensolvers/index
frequency-domain/index
interpolation-and-state-transfer/index
```
