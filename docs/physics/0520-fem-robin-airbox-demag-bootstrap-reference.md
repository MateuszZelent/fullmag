# Bootstrap executable FEM demagnetization via Robin-truncated scalar potential solve

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-24
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/output-naming-policy-v0.md`
  - `docs/specs/session-run-api-v1.md`
- Related physics notes:
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`

## 1. Problem statement

This note freezes the **first executable FEM demagnetization path** used by the bootstrap CPU
reference engine.

The long-term FEM demagnetization direction for Fullmag remains:

- MFEM + libCEED + hypre,
- mesh-based magnetostatic potential solve,
- higher-fidelity open-boundary realizations behind the same operator seam.

However, before the MFEM/GPU path is production-ready, Fullmag still needs a scientifically honest
reference implementation that:

- is executable today,
- uses the same scalar-potential physics as the future FEM backend,
- exposes `H_demag` and `E_demag` in the same public contract,
- supports session streaming and control-room observables,
- stays explicit about its approximations.

The current bootstrap answer is:

> **solve the scalar-potential magnetostatic problem on the supplied `MeshIR`, using a Robin
> boundary term as the first open-boundary surrogate.**

This is not the final FEM demag backend. It is the first honest reference seam.

## 2. Physical model

Let

$$
\mathbf{M}(\mathbf{x},t)=M_s(\mathbf{x})\,\mathbf{m}(\mathbf{x},t),
\qquad
\|\mathbf{m}\|=1.
$$

The demagnetizing field is written as

$$
\mathbf{H}_{\mathrm{d}}=-\nabla u,
$$

where the scalar potential satisfies the magnetostatic equation

$$
\Delta u = \nabla\cdot\mathbf{M}
\quad \text{in the computational domain } D.
$$

The exact full-space problem lives on $\mathbb{R}^3$.
The bootstrap executable FEM path replaces that by a **truncated-domain** weak form:

$$
\int_D \nabla u\,\cdot\,\nabla v\,dV

+ \beta \int_{\partial D} u\,v\,dS

= \int_{\Omega_m} \mathbf{M}\cdot\nabla v\,dV
\qquad \forall v \in H^1(D),
$$

where:

- $\Omega_m$ is the magnetic region,
- $D$ is the supplied computational mesh domain,
- $\beta > 0$ is a Robin parameter approximating far-field decay.

The corresponding bootstrap demag energy is evaluated as

$$
E_{\mathrm{d}}^{\mathrm{boot}}
= \frac{\mu_0}{2}
\left(
\int_D |\nabla u|^2\,dV
+
\beta\int_{\partial D} u^2\,dS
\right)
= \frac{\mu_0}{2}\,u^\top b,
$$

where $b$ is the assembled right-hand side.

## 3. Discrete interpretation

### 3.1 Spaces

The current executable reference path assumes first-order tetrahedral FEM:

$$
V_h \subset [H^1(\Omega_m)]^3,
\qquad
W_h \subset H^1(D).
$$

The magnetization is represented by nodal vectors, and the potential by a scalar nodal field on
the same `MeshIR`.

### 3.2 Magnetic vs non-magnetic elements

The bootstrap executable convention is:

- if all element markers are identical, the whole mesh is treated as magnetic,
- if the mesh contains multiple element markers and marker `1` is present, marker `1` is treated as
  the magnetic region and all other markers are treated as support/air-box elements for the
  potential solve.

This is a bootstrap convention, not the final region/material contract.
The future MFEM backend must replace it with an explicit region/material realization layer.

### 3.3 Robin boundary term

The current reference engine uses a Robin boundary mass contribution

$$
A_{\mathrm{demag}} = K + \beta M_{\partial D},
$$

with:

- $K$ assembled from the volumetric Laplacian form,
- $M_{\partial D}$ assembled from boundary triangle mass matrices.

The default bootstrap choice is

$$
\beta \approx \frac{1}{R_{\mathrm{eq}}},
\qquad
R_{\mathrm{eq}} = \left(\frac{3|D|}{4\pi}\right)^{1/3},
$$

where $|D|$ is the total volume of the supplied mesh domain.

This is not meant as the final far-field model.
It is the first executable approximation that keeps the potential seam honest.

### 3.4 Exchange and external field consistency

Once the mesh supports non-magnetic support elements:

- exchange must be assembled only on magnetic elements,
- external field energy must be integrated only on the magnetic region,
- demag potential must still be solved on the full computational domain.

The bootstrap reference engine already follows this split.

## 4. Numerical algorithm

For one LLG RHS evaluation:

1. Assemble the demag RHS

   $$
   b_i = \int_{\Omega_m} \mathbf{M}_h \cdot \nabla \phi_i\,dV
   $$

   using exact elementwise P1 integration via element-average magnetization.

2. Solve the dense bootstrap linear system

   $$
   (K + \beta M_{\partial D})\,u = b.
   $$

3. Recover elementwise demag field

   $$
   \mathbf{H}_{\mathrm{d},e} = -\nabla u_h|_e.
   $$

4. Average elementwise demag fields back to magnetic nodes.

5. Form

   $$
   \mathbf{H}_{\mathrm{eff}}
   =
   \mathbf{H}_{\mathrm{ex}}
   +
   \mathbf{H}_{\mathrm{d}}
   +
   \mathbf{H}_{\mathrm{ext}}.
   $$

6. Advance LLG with Heun in the bootstrap reference runner.

The current executable reference engine uses a dense direct solve.
This is acceptable only for very small meshes and exists solely to define the executable contract.

## 5. SI units and naming

| Quantity | Meaning | Unit | Public name |
|----------|---------|------|-------------|
| $\mathbf{H}_{\mathrm{d}}$ | demagnetizing field | A/m | `H_demag` |
| $E_{\mathrm{d}}$ | demagnetizing energy | J | `E_demag` |
| $\mathbf{H}_{\mathrm{ext}}$ | external field | A/m | `H_ext` |
| $E_{\mathrm{ext}}$ | external-field energy | J | `E_ext` |

The executable FEM runner must use the same naming as FDM and the same API/control-room quantity
contract.

## 6. Public API / IR / runner consequences

### 6.1 Public API

No new public Python term is needed.
`Demag()` remains the user-facing semantic term.

### 6.2 `ProblemIR` / `FemPlanIR`

The current bootstrap path can run with the existing `FemPlanIR`:

- `enable_demag`
- `external_field`
- `mesh`
- `initial_magnetization`
- `material`

The next architectural evolution should make the magnetic-region realization explicit instead of
relying on marker `1`.

### 6.3 Runner / session shell

The FEM callback/session path must emit:

- `E_demag`
- `max_h_demag`
- optional `H_demag` field snapshots

with the same session/event semantics as FDM.

## 7. Validation obligations

Minimum bootstrap validation:

1. `E_demag >= 0` for physically sensible test states.
2. The demag field vanishes only in trivial cases and is otherwise nonzero.
3. For a flat box-like mesh, out-of-plane uniform magnetization has larger demag energy than
   in-plane uniform magnetization.
4. `Exchange + Demag + Zeeman + LLG(heun)` remains stable in the narrow CPU-reference slice.

Comparison against a future MFEM production backend should use physical tolerances, not bitwise
identity.

## 8. Known limitations

- This is **not** the final MFEM/libCEED/hypre implementation.
- The dense linear solve is only for small reference meshes.
- The Robin boundary is only the first open-boundary surrogate.
- The current marker convention is bootstrap-only.
- The control room can stream FEM scalar/session updates now, but mesh-native live visualization is
  still a later step.

## 9. Deferred work

- Replace the dense solve with MFEM/hypre-backed sparse linear solves.
- Replace the bootstrap Robin truncation with better open-boundary strategies.
- Make magnetic/support regions explicit in the lowered FEM plan.
- Add mesh-native FEM live visualization in the control room.
- Validate against trusted FEM micromagnetics references and future MFEM production runs.

