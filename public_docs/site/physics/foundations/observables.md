---
title: Observables
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0870-active-observable-and-energy-availability.md
---

(public-docs-physics-foundations-observables)=
# Observables

An observable in FullMag is a named physical quantity that the solver can compute and
export during a simulation. Observables are either **fields** (spatially resolved,
three-component vectors or scalars at every cell/node) or **scalars** (single numbers per
time step, typically integrated quantities).

## Observable categories

### Field observables

Field observables carry spatial resolution and are exported as three-component vector arrays
or scalar arrays on the simulation grid/mesh.

| Observable | Symbol | SI unit | Requires |
|---|---|---:|---|
| `m` | $\mathbf{m}$ | $1$ | always available |
| `H_eff` | $\mathbf{H}_{\mathrm{eff}}$ | $\mathrm{A\,m^{-1}}$ | at least one energy term |
| `H_ex` | $\mathbf{H}_{\mathrm{ex}}$ | $\mathrm{A\,m^{-1}}$ | `Exchange()` |
| `H_demag` | $\mathbf{H}_{\mathrm{d}}$ | $\mathrm{A\,m^{-1}}$ | `Demag()` |
| `H_ext` | $\mathbf{H}_{\mathrm{ext}}$ | $\mathrm{A\,m^{-1}}$ | `Zeeman()` |
| `H_ani` | $\mathbf{H}_{\mathrm{ani}}$ | $\mathrm{A\,m^{-1}}$ | `UniaxialAnisotropy()` or `CubicAnisotropy()` |
| `H_dmi` | $\mathbf{H}_{\mathrm{DMI}}$ | $\mathrm{A\,m^{-1}}$ | `InterfacialDMI()` or `BulkDMI()` |
| `H_oe` | $\mathbf{H}_{\mathrm{oe}}$ | $\mathrm{A\,m^{-1}}$ | `OerstedField()` or `OerstedCylinder()` |
| `H_mel` | $\mathbf{H}_{\mathrm{mel}}$ | $\mathrm{A\,m^{-1}}$ | `Magnetoelastic()` |
| `H_th` | $\mathbf{H}_{\mathrm{th}}$ | $\mathrm{A\,m^{-1}}$ | `ThermalNoise()` |

### Scalar observables

Scalar observables are integrated (global) quantities, typically energies.

| Observable | Symbol | SI unit | Requires |
|---|---|---:|---|
| `E_ex` | $E_{\mathrm{ex}}$ | $\mathrm{J}$ | `Exchange()` |
| `E_demag` | $E_{\mathrm{d}}$ | $\mathrm{J}$ | `Demag()` |
| `E_zeeman` | $E_{\mathrm{Z}}$ | $\mathrm{J}$ | `Zeeman()` |
| `E_ani` | $E_{\mathrm{ani}}$ | $\mathrm{J}$ | anisotropy term |
| `E_dmi` | $E_{\mathrm{DMI}}$ | $\mathrm{J}$ | DMI term |
| `E_mel` | $E_{\mathrm{mel}}$ | $\mathrm{J}$ | `Magnetoelastic()` |
| `E_total` | $E_{\mathrm{tot}}$ | $\mathrm{J}$ | at least one energy term |
| `max_torque` | $\max|\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}|$ | $\mathrm{A\,m^{-1}}$ | at least one field term |
| `dt` | $\Delta t$ | $\mathrm{s}$ | adaptive integrator |

## Requesting observables

Observables are requested through the `outputs` parameter of a study:

```python
import fullmag as fm

study = fm.TimeEvolution(
    dynamics=fm.LLG(),
    outputs=[
        fm.SaveField("m", every=10e-12),         # magnetization every 10 ps
        fm.SaveField("H_eff", every=10e-12),     # effective field every 10 ps
        fm.SaveScalar("E_ex", every=1e-12),      # exchange energy every 1 ps
        fm.SaveScalar("E_total", every=1e-12),   # total energy every 1 ps
    ],
)
```

The planner validates that the requested observables are compatible with the declared energy
terms. Requesting `H_ex` without `Exchange()` in the energy list is a validation error.

## Legality and materialisation

An observable is **legal** if the required interaction is declared and the selected backend
can materialise it. The legality check happens during planning:

1. **Authoring validation**: the Python DSL checks that the observable name is known.
2. **Planner validation**: the planner verifies that the energy term enabling the
   observable is declared and the concrete backend supports it.
3. **Runtime materialisation**: the solver computes the field/scalar and writes it to the
   output channel.

An observable that is declared but unmaterialisable (e.g. a GPU lane that does not implement
the energy reduction) is a planner error, not a silent zero.

## Table autosave

FullMag's table autosave captures scalar observables at every accepted step into a CSV or
structured output. This provides a continuous record of energies, maximum torque, and
timestep evolution without explicit `SaveScalar` declarations.

## Scientific bibliography

1. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
