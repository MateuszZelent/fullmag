# STNO/MTJ Vortex Oscillator — Physics & Simulation Overview

## Scope

This document describes the physical models implemented in fullmag for **spin-torque nano-oscillator (STNO)** simulations, with emphasis on the vortex-state MTJ geometry. It covers:

1. Landau–Lifshitz–Gilbert + STT dynamics
2. Oersted field model
3. Thermal fluctuations
4. Observables and their extraction from simulation data

Canonical benchmark note:

- the current reference benchmark is [`examples/stno_vortex_ref_minimal.py`](../../examples/stno_vortex_ref_minimal.py),
- the builder-generated [`examples/stno_vortex_mtj_workflow.py`](../../examples/stno_vortex_mtj_workflow.py) remains a workflow example, not the golden benchmark.

---

## 1. Governing Equation

The time evolution follows the **LLG equation with spin-transfer torque** (implicit form):

$$
\frac{\partial \mathbf{m}}{\partial t} = -\gamma \mu_0 \, \mathbf{m} \times \mathbf{H}_\mathrm{eff}
    + \alpha \, \mathbf{m} \times \frac{\partial \mathbf{m}}{\partial t}
    + \boldsymbol{\tau}_\mathrm{STT}
    + \boldsymbol{\eta}_\mathrm{th}(T)
$$

where $\mathbf{m} = \mathbf{M}/M_s$ is the unit magnetization, $\gamma$ the gyromagnetic ratio, $\alpha$ the Gilbert damping, $\mathbf{H}_\mathrm{eff}$ the effective field, and $\boldsymbol{\eta}_\mathrm{th}$ the stochastic thermal field.

### Effective field contributions

$$
\mathbf{H}_\mathrm{eff} = \mathbf{H}_\mathrm{exch}
    + \mathbf{H}_\mathrm{demag}
    + \mathbf{H}_\mathrm{Zeeman}
    + \mathbf{H}_\mathrm{anis}
    + \mathbf{H}_\mathrm{Oe}
$$

Each term corresponds to an `EnergyTerm` in the Python DSL:
- `Exchange()` → $\mathbf{H}_\mathrm{exch}$
- `Demag()` → $\mathbf{H}_\mathrm{demag}$
- `Zeeman(B=...)` → $\mathbf{H}_\mathrm{Zeeman}$
- `UniaxialAnisotropy(...)` → $\mathbf{H}_\mathrm{anis}$
- `OerstedCylinder(...)` → $\mathbf{H}_\mathrm{Oe}$

---

## 2. Spin-Transfer Torque Models

See [stt_sign_conventions.md](stt_sign_conventions.md) for full parameter reference.

### 2.1 Slonczewski STT (CPP / MTJ)

$$
\boldsymbol{\tau}_\mathrm{Slonc} =
    \sigma(J, P, \Lambda) \, \mathbf{m} \times (\mathbf{m} \times \hat{\mathbf{p}})
    + \sigma'(J, \varepsilon') \, \mathbf{m} \times \hat{\mathbf{p}}
$$

The efficiency function:

$$
\sigma = \frac{\hbar}{2e \mu_0 M_s d} \cdot \frac{J \, P \, \Lambda^2}{(\Lambda^2 + 1) + (\Lambda^2 - 1)(\mathbf{m} \cdot \hat{\mathbf{p}})}
$$

Typical STNO parameters:
- $J \sim 10^{10}$–$10^{11}$ A/m²
- $P \sim 0.3$–$0.7$ (spin-polarization degree)
- $\hat{\mathbf{p}} = (0,0,\pm 1)$ for perpendicular polarizer

**Python DSL:**
```python
problem = Problem(
    ...,
    spin_torques=[
        SlonczewskiSTT(
            current_density=[0, 0, 5e10],
            spin_polarization=[0, 0, 1],
            degree=0.4,
            lambda_asymmetry=1.0,
            epsilon_prime=0.0,
        )
    ],
)
```

Legacy compatibility note:

- `spin_torque=SlonczewskiSTT(...)` still works,
- canonical authoring now uses `spin_torques=[...]`,
- the current public executable path still supports one torque module at a time.

### 2.2 Zhang–Li STT (CIP)

$$
\boldsymbol{\tau}_\mathrm{ZL} =
    -\frac{b_J}{M_s} \mathbf{m} \times (\mathbf{m} \times (\mathbf{J} \cdot \nabla)\mathbf{m})
    - \frac{\beta \, b_J}{M_s} \mathbf{m} \times (\mathbf{J} \cdot \nabla)\mathbf{m}
$$

where $b_J = P \mu_B J / (e M_s)$ and $\beta$ is the non-adiabaticity parameter.

---

## 3. Oersted Field Model

For cylindrical STNO geometry, the current-induced Oersted field is modeled analytically:

$$
\mathbf{H}_\mathrm{Oe}(r) = \frac{I}{2\pi r} \hat{\boldsymbol{\varphi}}
\quad (r > R_\mathrm{cyl})
$$

$$
\mathbf{H}_\mathrm{Oe}(r) = \frac{I r}{2\pi R_\mathrm{cyl}^2} \hat{\boldsymbol{\varphi}}
\quad (r \leq R_\mathrm{cyl})
$$

**Python DSL:**
```python
OerstedCylinder(
    current=5e-3,         # DC current [A]
    radius=50e-9,         # pillar radius [m]
    time_dependence=...,  # optional: Constant, Sinusoidal, Pulse, PiecewiseLinear
)
```

### Time dependence

The current may be modulated with any `TimeDependence` envelope:

| Type | IR `kind` | Parameters |
|------|-----------|------------|
| `Constant()` | `constant` | — |
| `Sinusoidal(frequency_hz, phase_rad, offset)` | `sinusoidal` | frequency, phase, offset |
| `Pulse(t_on, t_off)` | `pulse` | on/off times [s] |
| `PiecewiseLinear(points)` | `piecewise_linear` | `[(t₁, v₁), (t₂, v₂), ...]` |

### Backend support

| Backend | Oersted field | Notes |
|---------|---------------|-------|
| **CUDA FDM** | ✅ | Production executable for the current public STNO slice |
| **CPU FDM** | ✅ | Reference executable for constant / sinusoidal / pulse envelopes |
| **FEM GPU** | semantic-only for the STNO public slice | Do not treat as public end-to-end STNO parity |

---

## 4. Thermal Fluctuations

Brown's thermal noise model adds a stochastic field:

$$
\mathbf{H}_\mathrm{th} = \boldsymbol{\eta}(t) \sqrt{\frac{2 \alpha k_B T}{\gamma \mu_0 M_s V \Delta t}}
$$

where $\boldsymbol{\eta}(t)$ is a Gaussian white noise process (three independent components, zero mean, unit variance).

**Python DSL:**
```python
# Method 1: global temperature
Problem(..., temperature=300.0)

# Method 2: explicit energy term
ThermalNoise(temperature=300.0, seed=42)
```

**Consistency rule:** If both `Problem.temperature` and `ThermalNoise.temperature` are specified, they must agree (validated in `Problem.__post_init__`).

---

## 5. Trust Boundaries

### What the simulation captures well
- Vortex core gyration dynamics (gyrotropic mode, frequency, orbit)
- Relative linewidth trends with current density and field
- Qualitative STT threshold behavior

### What requires caution
- **Absolute linewidth values** depend on mesh resolution, time step, and thermal sampling
- **Oersted field accuracy** assumes uniform current density in the pillar
- **Magnetoresistance** is not computed from micromagnetics — use TMR post-processing models
- **Spin-wave excitation** requires very fine mesh (cell < exchange length)

### Backend limitations

| Feature | CUDA FDM | CPU FDM | FEM GPU |
|---------|----------|---------|---------|
| Slonczewski STT | ✅ | ✅ | ❌ |
| Zhang–Li STT | ✅ | ✅ | ❌ |
| Oersted field | ✅ | ✅ | semantic-only for the current STNO public slice |
| Thermal noise | ✅ | ✅ | ✅ |
| PiecewiseLinear TD | ✅* | ✅* | ✅* |

*PiecewiseLinear for Oersted time dependence is currently rejected by the public FDM planner.

---

## 6. Typical STNO Simulation Workflow

1. Define geometry (cylindrical pillar, typically 100–500 nm diameter, 2–10 nm thick)
2. Set material parameters (Permalloy: $M_s = 800$ kA/m, $A_\mathrm{ex} = 13$ pJ/m, $\alpha = 0.005$–$0.02$)
3. Initialize vortex state (polarity $p = \pm 1$, chirality $c = \pm 1$)
4. Configure STT (Slonczewski model, $J \sim 10^{10}$ A/m²)
5. Add Oersted field (`OerstedCylinder`)
6. Optionally add temperature ($T = 300$ K)
7. Run time evolution (typically 50–200 ns, Δt ~ 0.1–1 ps)
8. Analyze: PSD of ⟨mₓ⟩(t) or ⟨m_y⟩(t), extract peak frequency and linewidth
9. Track vortex core position, compute orbit radius and gyration frequency

See:

- [examples/stno_vortex_ref_minimal.py](../../examples/stno_vortex_ref_minimal.py) for the canonical executable benchmark,
- [examples/stno_vortex_mtj_postprocess.py](../../examples/stno_vortex_mtj_postprocess.py) for real artifact-backed post-processing.
