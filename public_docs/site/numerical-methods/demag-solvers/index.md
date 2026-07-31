---
title: Demag Solvers
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-demag-solvers-root)=
# Demagnetization solver realizations

Demagnetization is one physical interaction with several numerical realizations. The canonical
energy, effective field and observable definitions live under
{doc}`../../physics/interactions/demagnetization/index`. This family documents how the solver
discretizes and solves that same interaction; it does not create four competing demagnetization
models.

| Realization | Solver family | Main numerical object | Boundary/domain policy |
|---|---|---|---|
| FDM convolution | FDM | cell-averaged Newell tensor and FFT convolution | open-boundary zero padding; periodic modes are separate |
| FEM Poisson airbox | FEM | scalar-potential Poisson system on magnetic body plus air | Dirichlet or Robin outer closure |
| FEM/BEM Fredkin–Koehler | FEM | interior FEM potential plus dense boundary operator | open boundary represented by surface integral |
| Periodic demag | FDM/FEM | periodic image/reduced-potential operator | explicit periodic axes and zero-mode/gauge policy |

The CPU and GPU sections on each terminal page are realization sections of one solver page. They
are separate wherever memory ownership, precision, sparse/FFT libraries, boundary treatment,
failure semantics or qualification evidence differ.

```{toctree}
:maxdepth: 1

fdm-convolution
fem-poisson-airbox
fem-bem
periodic-demag
```
