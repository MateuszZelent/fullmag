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
`study.device("cpu" | "gpu", precision="double")`. The rest of the study stays the same.

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
## Control Room crosswalk

Use the authoring path stated in this guide, normally `Model Explorer -> Objects` followed by the relevant Geometry, Material, Physics, Mesh, or Stage panel. Any parameter shown in Python but not shown in that path is `TODO: frontend support`; do not describe it as configurable in the UI. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

The runnable Python example and exact argument contract are authoritative. If this guide is conceptual or does not contain a runnable example, it explicitly defers to the linked `{doc}``/python-api/index` page rather than duplicating an unverified signature.

## Physics, limitations, and bibliography

Use the linked physics or numerical-methods page for governing equations and assumptions. This onboarding page does not add a new physical model. Bibliography: see the linked terminal API or physics page; no additional source is claimed here.
## Source-code index

- No new implementation symbol is introduced by this guide. The exact Python source symbol is owned by the linked terminal API page and the runnable example.

