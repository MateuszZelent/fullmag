# Spin-Transfer Torque (STT) — Sign Conventions and Parameter Reference

## Overview

Fullmag currently exposes a canonical spin-torque family with an executable public subset.

Executable today:

1. **Slonczewski STT** — for current-perpendicular-to-plane (CPP) geometries (MTJ, nanopillar)
2. **Zhang–Li STT** — for current-in-plane (CIP) geometries (nanowire, domain wall track)
3. **Spin–Orbit Torque** — for damping-like / field-like spin Hall geometries

Semantic-only placeholders today:

4. **InterfaceCppSTT**
5. **DriftDiffusionSpinTorque**

Executable spin torques are added to the LLG equation as explicit direct-RHS
terms after any field-form torque has been converted through the same Gilbert
convention as `H_eff`:

$$
\frac{\partial \mathbf{m}}{\partial t} = -\gamma \mu_0 \, \mathbf{m} \times \mathbf{H}_\mathrm{eff} + \alpha \, \mathbf{m} \times \frac{\partial \mathbf{m}}{\partial t} + \boldsymbol{\tau}_\mathrm{STT}
$$

CPU FDM implementation rule:

- direct spin-torque terms are RHS contributions, not effective-field terms;
- every time-integrator stage must add the configured direct torque to the stage RHS after
  evaluating the field-driven LLG RHS;
- AoS and SoA CPU buffer paths must produce matching stage updates for the same configured
  direct torque terms.

---

## Slonczewski STT (CPP / MTJ)

### Torque expression

$$
\boldsymbol{\tau}_\mathrm{Slonc} = \sigma(J, P, \Lambda) \, \mathbf{m} \times (\mathbf{m} \times \hat{\mathbf{p}}) + \sigma'(J, \varepsilon') \, \mathbf{m} \times \hat{\mathbf{p}}
$$

where:
- First term: **damping-like** (in-plane) torque
- Second term: **field-like** (out-of-plane) torque

### Parameters

| Parameter | IR field | Python field | Unit | Typical range |
|-----------|----------|-------------|------|---------------|
| Current density | `current_density` | `current_density` | A/m² | 10⁹–10¹² |
| Polarization direction | `stt_spin_polarization` | `spin_polarization` | unit vector | (0,0,1) |
| Spin polarization efficiency | `stt_degree` | `degree` | dimensionless | 0 < P ≤ 1, typ. 0.3–0.7 |
| Asymmetry parameter | `stt_lambda` | `lambda_asymmetry` | dimensionless | Λ ≥ 1.0, typ. 1.0–2.0 |
| Field-like coefficient | `stt_epsilon_prime` | `epsilon_prime` | dimensionless | typ. 0–0.1 |

### Sign convention

- **Positive current** flows from the **free layer** to the **fixed (reference) layer** along +z.
- `spin_polarization` $\hat{\mathbf{p}}$ is the **unit vector of the reference layer magnetization**.
- The implemented direct RHS follows the written algebraic sign. For
  $\mathbf{m}\perp\hat{\mathbf{p}}$, positive `current_sign * |J|` drives the
  damping-like basis vector $\mathbf{m}\times(\mathbf{m}\times\hat{\mathbf{p}})$;
  reversing `current_sign` reverses the Slonczewski drive.

### Prefactor

The Slonczewski torque prefactor is:

$$
\sigma_0 = \frac{\hbar |J| \gamma_{\mu0} P}{2 e \mu_0 M_s d} \cdot g(\mathbf{m} \cdot \hat{\mathbf{p}})
$$

where $g(\cos\theta)$ depends on $\Lambda$:

$$
g(\cos\theta) = \frac{1}{\Lambda^2 + 1 + (\Lambda^2 - 1)\cos\theta}
$$

For $\Lambda = 1$, $g = 1/2$ (no angular asymmetry).

The explicit Fullmag direct-RHS form is:

$$
\boldsymbol{\tau}_\mathrm{Slonc}
= \frac{\mathrm{currentSign}\,\sigma_0}{1+\alpha^2}
\left[
(1+\alpha\varepsilon')\,\mathbf{m}\times(\mathbf{m}\times\hat{\mathbf{p}})
+(\varepsilon'-\alpha)\,\mathbf{m}\times\hat{\mathbf{p}}
\right].
$$

This is the direct-RHS equivalent of adding the corresponding Slonczewski field
to `H_eff`; `gamma_mu0` converts the field-scale prefactor to `1/s`.

---

## Zhang–Li STT (CIP)

### Torque expression

$$
\mathbf{v} = (\mathbf{u} \cdot \nabla)\mathbf{m}, \qquad
\mathbf{v}_\perp = -\mathbf{m}\times(\mathbf{m}\times\mathbf{v})
$$

where:

$$
\mathbf{u} = \frac{\mathbf{J} P \mu_B}{e M_s(1+\beta^2)}
$$

and the explicit Gilbert-form RHS contribution is:

$$
\boldsymbol{\tau}_\mathrm{ZL}
= \frac{(1+\alpha\beta)\mathbf{v}_\perp
-(\beta-\alpha)\mathbf{m}\times\mathbf{v}}{1+\alpha^2}.
$$

### Parameters

| Parameter | IR field | Python field | Unit | Typical range |
|-----------|----------|-------------|------|---------------|
| Current density | `current_density` | `current_density` | A/m² | 10⁹–10¹² |
| Spin polarization efficiency | `stt_degree` | `degree` | dimensionless | 0 < P ≤ 1 |
| Non-adiabaticity | `stt_beta` | `beta` | dimensionless | 0 ≤ β ≤ 0.1, typ. 0.01–0.04 |

### Sign convention

- `current_density` is a 3D vector pointing in the direction of **electron drift velocity**.
- For a nanowire along x: `current_density = (Jx, 0, 0)`.
- Positive Jx means electrons flow in +x → domain wall moves in +x (adiabatic torque).

---

## Temperature / Thermal Noise

The stochastic thermal field follows the fluctuation-dissipation theorem:

$$
\langle H_i^\mathrm{th}(t) H_j^\mathrm{th}(t') \rangle = \frac{2 \alpha k_B T}{\gamma \mu_0 M_s V \Delta t} \delta_{ij} \delta_{tt'}
$$

| Parameter | IR field | Python field | Unit |
|-----------|----------|-------------|------|
| Temperature | `temperature` | `temperature` | K |

- `temperature = 0` or `None` → no thermal noise.
- At $T > 0$, the solver uses stochastic LLG (sLLG) integration.
- For linewidth and phase noise studies, use $T = 300$ K (room temperature).
- The thermal field is computed per cell per timestep.

---

## Python API Usage

### Slonczewski STT (for MTJ vortex oscillator)

```python
from fullmag.model.spin_torque import SlonczewskiSTT

problem = Problem(
    ...,
    spin_torques=[
        SlonczewskiSTT(
            current_density=(0, 0, 1e10),    # J = 10¹⁰ A/m², along +z
            spin_polarization=(1, 0, 0),     # reference layer along +x
            degree=0.4,                      # P = 0.4
            lambda_asymmetry=1.0,            # Λ = 1 (symmetric)
            epsilon_prime=0.0,               # no field-like term
        )
    ],
    temperature=300.0,   # room temperature
)
```

Legacy compatibility:

- `spin_torque=SlonczewskiSTT(...)` still works,
- canonical authoring uses `spin_torques=[...]`,
- the current public executable path supports one torque module at a time.

### Zhang–Li STT (for domain wall track)

```python
from fullmag.model.spin_torque import ZhangLiSTT

problem = Problem(
    ...,
    spin_torques=[
        ZhangLiSTT(
            current_density=(5e11, 0, 0),   # J along +x
            degree=0.4,
            beta=0.02,
        )
    ],
)
```

---

## References

1. J. C. Slonczewski, "Current-driven excitation of magnetic multilayers", J. Magn. Magn. Mater. 159, L1 (1996).
2. S. Zhang and Z. Li, "Roles of Nonequilibrium Conduction Electrons on the Magnetization Dynamics of Ferromagnets", Phys. Rev. Lett. 93, 127204 (2004).
3. A. Dussaux et al., "Large microwave generation from current-driven magnetic vortex oscillators in magnetic tunnel junctions", Nat. Commun. 1, 8 (2010).
4. A. Dussaux et al., "Field dependence of spin-transfer-induced vortex dynamics in the nonlinear regime", Phys. Rev. B 86, 014402 (2012).
