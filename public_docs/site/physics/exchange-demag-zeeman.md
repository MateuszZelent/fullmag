---
title: Exchange, demagnetization and Zeeman terms
status: planned
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0400-fdm-exchange-demag-zeeman.md
---

# Exchange, demagnetization and Zeeman terms

This is the first coupled physics slice for the public Physics Reference. It establishes the
shared energy and effective-field vocabulary before additional interactions are published.

## Exchange

Exchange energy depends on exchange stiffness and spatial gradients of magnetization. FDM uses a
structured-grid stencil interpretation. FEM uses a weak-form realization over the element mesh.
Interface and boundary policies are part of the physical contract.

For an isotropic material, the continuum exchange energy has the form:

$$
E_ex = integral over Omega of A times |grad(m)|^2 dV
$$

Here A is exchange stiffness in J/m and m is normalized magnetization. The effective field must
use the same sign and normalization convention as the project-wide LLG contract.

Canonical internal sources include the exchange reference note, the FEM exchange note and the
exchange boundary-condition policy. Their public synthesis must retain the same signs, units and
limits.

## Demagnetization

Demagnetization is nonlocal. FDM uses a convolution or kernel family with explicit open-boundary,
multilayer and periodic-image policy. FEM uses a shared magnetic and air domain with a selected
Poisson, BEM or related strategy. These are different numerical realizations of one physical
term; residuals, boundary assumptions and qualification evidence must not be conflated.

The demagnetizing contribution is represented through a nonlocal field H_d:

$$
E_d = -mu_0 / 2 times integral over Omega of M dot H_d dV
$$

This equation does not select a numerical strategy. Open boundaries, airbox truncation, BEM or
Poisson realization, periodic images and solver residual policy remain explicit backend contracts.

## Zeeman and prescribed fields

The Zeeman term couples magnetization to a prescribed field. The public contract preserves field
units, spatial scope, time dependence, regional masks and stage-time semantics. A regional or
antenna field is not equivalent to a uniform field with a renderer-side mask.

For a prescribed applied field H_ext, the Zeeman contribution is:

$$
E_Z = -mu_0 times integral over Omega of M dot H_ext dV
$$

Spatial masks, time dependence and stage-time evaluation are physical inputs and must survive
lowering into both FDM and FEM.

## API and ProblemIR impact

The public model must expose exchange stiffness, demagnetization strategy and boundary policy,
prescribed field value or source, spatial scope, time dependence and observables. ProblemIR must
retain requested interaction terms and the planner must report the resolved FDM or FEM capability
without changing their units or signs.

## Validation strategy

The following are planned validation fixtures, not completed evidence:

The first public examples and tests cover:

1. uniform magnetization with a uniform applied field;
2. exchange-only nonuniform relaxation;
3. demagnetization with an analytical or standard-problem-bounded reference;
4. the same physical intent through available FDM and FEM lanes, with separate capability status
   and runtime evidence.

## Known limits and deferred work

This first public page does not qualify every demagnetization strategy, every periodic-image
policy, GPU precision or full time-domain coupling. Each claim remains planned until an
implementation link, test result, runtime identity and stated tolerance are attached.
