---
title: Choosing a Solver
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-choosing-a-solver)=
# Choosing a Solver

FullMag has one physical problem contract and several execution realizations. You select the
numerical backend with `study.engine("fdm")` or `study.engine("fem")`, and the device with
`study.device("cpu" | "gpu", precision="double")`. Geometry, material state, interactions, and
stage intent use the same authoring model, but discretization, meshing, demagnetization realization,
and lane-specific solver policy are not interchangeable and must be configured for the selected
backend.

## Finite difference (FDM)

FDM represents the domain on a regular cell grid and computes demagnetization through a
cell-averaged Newell tensor with FFT convolution.

Choose FDM when:

- the geometry is well represented by a regular grid (cuboids, thin films, multilayer stacks),
- you need open-boundary demagnetization with fast FFT convolution,
- you want the grid-to-cell physical meaning of an FDM magnet (native `cell_size` resolution).

The canonical FDM pages are {doc}`../../numerical-methods/demag-solvers/fdm-convolution` and
{doc}`../../python-api/discretization/fdm`.

## Finite element (FEM)

FEM discretizes the domain with an unstructured tetrahedral or prismatic mesh that conforms to the
geometry, and solves demagnetization with a Poisson airbox or a boundary-element method.

Choose FEM when:

- the geometry is curved, conformal, or imported from CAD and needs boundary-conforming elements,
- you need a magnetic body plus an airbox for scalar-potential demagnetization,
- you work with standard problems, eigenmode/spectral studies, or problems that benefit from
  MFEM/hypre/libCEED solvers.

The canonical FEM pages are
{doc}`../../numerical-methods/demag-solvers/fem-poisson-airbox` and
{doc}`../../python-api/discretization/fem`.

## CPU versus GPU

Both FDM and FEM expose CPU and GPU execution lanes. The device choice is request metadata; the
runtime records the resolved device and precision in the result.

- The local CPU runtime is the common validation path and is covered by the repository smoke and
  qualification scripts.
- FDM CUDA and FEM GPU use managed CUDA runtimes through the repository recipes. Executed GPU
  evidence requires a recorded device identity in the result; presence of GPU source or a
  successful host build is not device-parity proof.

## Support and qualification matrix

Each terminal page documents its own four-lane matrix for FDM CPU, FDM GPU, FEM CPU, and FEM GPU,
including unsupported and unqualified states. Use those matrices as the authoritative support
status instead of this summary:

See {doc}`../../numerical-methods/demag-solvers/fdm-convolution`,
{doc}`../../numerical-methods/demag-solvers/fem-poisson-airbox`, and
{doc}`../../physics/interactions/demagnetization/index` for the terminal matrices.

Do not infer a solver is production-ready from its name or from source presence. Requested intent
and resolved execution are kept separate, and the planner rejects unsupported engine/device/
interaction combinations instead of silently substituting them.
