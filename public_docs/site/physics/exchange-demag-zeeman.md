---
title: Exchange, demagnetization and Zeeman terms
status: draft
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

Canonical internal sources include the exchange reference note, the FEM exchange note and the
exchange boundary-condition policy. Their public synthesis must retain the same signs, units and
limits.

## Demagnetization

Demagnetization is nonlocal. FDM uses a convolution or kernel family with explicit open-boundary,
multilayer and periodic-image policy. FEM uses a shared magnetic and air domain with a selected
Poisson, BEM or related strategy. These are different numerical realizations of one physical
term; residuals, boundary assumptions and qualification evidence must not be conflated.

## Zeeman and prescribed fields

The Zeeman term couples magnetization to a prescribed field. The public contract preserves field
units, spatial scope, time dependence, regional masks and stage-time semantics. A regional or
antenna field is not equivalent to a uniform field with a renderer-side mask.

## First validation slice

The first public examples and tests cover:

1. uniform magnetization with a uniform applied field;
2. exchange-only nonuniform relaxation;
3. demagnetization with an analytical or standard-problem-bounded reference;
4. the same physical intent through available FDM and FEM lanes, with separate capability status
   and runtime evidence.
