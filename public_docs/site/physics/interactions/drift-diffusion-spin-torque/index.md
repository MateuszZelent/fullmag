---
title: Drift-diffusion spin torque
status: semantic-only
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-drift-diffusion-stt)=
# Drift-diffusion spin torque

:::{admonition} Semantic-only placeholder
:class: warning

`DriftDiffusionSpinTorque` is a **semantic-only placeholder** in the Python DSL. It is
not executable on any backend. This page documents the intended physics for future
implementation.
:::

## Intended physics

Drift-diffusion spin torque models a self-consistent coupling between the spin transport
equation and the LLG equation. Unlike the prescribed-current Slonczewski or Zhang–Li
models, drift-diffusion computes the local spin accumulation $\mathbf{s}(\mathbf{r},t)$
from the continuity equation

```{math}
:label: eq-ddst-spin-diffusion
\frac{\partial\mathbf{s}}{\partial t}
=
-\nabla\cdot\mathbf{J}_s
-\frac{\mathbf{s}}{\tau_{\mathrm{sf}}}
-\frac{\mathbf{s}\times\mathbf{m}}{\tau_{\mathrm{ex}}},
```

and the resulting spin torque on the magnetization is

```{math}
:label: eq-ddst-torque
\boldsymbol{\tau}_{\mathrm{DD}}
=
-\frac{1}{\tau_{\mathrm{ex}}}
(\mathbf{s}\times\mathbf{m}).
```

The spin diffusion length $\lambda_{\mathrm{sf}}$ characterises the decay of spin
accumulation away from interfaces.

## Python API status

The constructor exists and validates parameters:

```python
from fullmag.model.spin_torque import DriftDiffusionSpinTorque

dd = DriftDiffusionSpinTorque(
    current_density=(0, 0, 1e10),
    degree=0.4,
    beta=0.01,
    spin_diffusion_length_m=5e-9,
)
```

Submitting a problem with this torque to any backend will raise a planner error.

## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{s}$ | spin accumulation density | $\mathrm{A\,s\,m^{-3}}$ |
| $\mathbf{J}_s$ | spin current tensor | $\mathrm{A\,m^{-2}}$ |
| $\tau_{\mathrm{sf}}$ | spin-flip relaxation time | $\mathrm{s}$ |
| $\tau_{\mathrm{ex}}$ | exchange time (sd coupling) | $\mathrm{s}$ |
| $\lambda_{\mathrm{sf}}$ | spin diffusion length | $\mathrm{m}$ |

## Scientific bibliography

1. S. Zhang, P. M. Levy, and A. Fert, "Mechanisms of spin-polarized current-driven
   magnetization switching," *Physical Review Letters* **88**, 236601 (2002).
   [doi:10.1103/PhysRevLett.88.236601](https://doi.org/10.1103/PhysRevLett.88.236601).
2. C. Petitjean, D. Luc, and X. Waintal, "Unified drift-diffusion theory for transverse
   spin currents in spin valves, domain walls, and other textured magnets," *Physical
   Review Letters* **109**, 117204 (2012).
   [doi:10.1103/PhysRevLett.109.117204](https://doi.org/10.1103/PhysRevLett.109.117204).

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python placeholder | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class DriftDiffusionSpinTorque` | semantic constructor | Python |
