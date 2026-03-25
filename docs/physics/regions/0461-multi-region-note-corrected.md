
# Multi-region, material fields, and interface physics in Fullmag
## Corrected and expanded note

- Status: corrected design note
- Target: Fullmag physics and architecture
- Date: 2026-03-25

---


## 0. What was corrected relative to the original note

The original note had the right instinct, but several claims needed tightening.

The most important corrections are:

1. **A spatial variation of `Ms` is not automatically an artificial demagnetizing-field artifact.**  
   If the model declares \(M = M_s m\), then \(M_s(x)\) genuinely changes the magnetostatic source.
   What becomes artificial is using a constitutive gradient to emulate a sharp interface that should
   have been modeled explicitly.

2. **The harmonic mean is not “just wrong”.**  
   In a shared-grid finite-difference discretization of a single heterogeneous magnetization field,
   a face coefficient based on the harmonic mean is a valid realization of the exchange jump condition.
   The real mistake is to treat that numerical detail as the universal semantics of all interfaces.

3. **One heterogeneous body and multiple coupled bodies must be separated conceptually.**  
   These are different physical models and deserve different solver semantics.

4. **Interfacial exchange / IEC must be explicit.**  
   Surface energies with units `J/m^2` should not be hidden inside volumetric `A(x)` logic.

5. **Fullmag already points in the right direction, but the end-to-end executable planner path is not there yet.**  
   The current repository already contains the right semantic and runtime scaffolding in several
   places, but the public executable baseline is still narrower than the long-term design.

---

## 1. The real problem

The core issue is **not** simply “regions” in the Mumax sense.

The actual problem is that three distinct things are often conflated into one mechanism:

1. **topology / ownership** — which part of space belongs to which domain or body,
2. **constitutive variation** — a true spatial dependence of material coefficients such as `Ms(x)`, `A(x)`, `K(x)`, `α(x)`, `D(x)`,
3. **inter-body coupling** — physics that acts across interfaces or gaps between *different magnetic bodies*.

A solver becomes semantically fragile if all three are encoded by “painting regions on one grid” and then letting low-level cell stencils guess the intended physics.

The design target for Fullmag should therefore be:

> **Sharp interfaces and coupled bodies must be explicit.  
> Continuous material fields must remain possible, but they must not be the only way to express interfaces.**

This gives Fullmag two clean and physically distinct modeling modes:

- **single-body heterogeneous continuum**
- **multi-body coupled system**

These are both valid micromagnetic models, but they are **not the same model** and should not be forced through the same API primitive.

---

## 2. Two modeling modes that Fullmag must distinguish

### 2.1 Single-body heterogeneous continuum

In this mode there is **one reduced magnetization field**
\[
\mathbf m(\mathbf x,t), \qquad \|\mathbf m\|=1,
\]
defined on one magnetic domain \(\Omega\), with physical magnetization
\[
\mathbf M(\mathbf x,t)=M_s(\mathbf x)\,\mathbf m(\mathbf x,t).
\]

Material coefficients may vary smoothly or piecewise:

- \(M_s(\mathbf x)\)
- \(A(\mathbf x)\)
- \(K(\mathbf x)\)
- \(\alpha(\mathbf x)\)
- \(D(\mathbf x)\)
- anisotropy axes \(u(\mathbf x)\)

This mode is the correct one if the user really means:

- a graded alloy,
- a tapering anisotropy profile,
- a true continuous composition gradient,
- an intentionally piecewise-constant ferromagnet represented by one magnetization field.

In this mode, a spatial variation of `Ms` is **not automatically an artifact**.  
It changes the physical magnetization \(\mathbf M\), and therefore it changes the magnetostatic source.

For smooth coefficients,
\[
\nabla \cdot \mathbf M
=
\nabla \cdot (M_s \mathbf m)
=
M_s\,\nabla\cdot\mathbf m + \mathbf m \cdot \nabla M_s .
\]

Therefore:

- a real gradient of `Ms` creates a real magnetostatic contribution,
- a real jump of `Ms` creates a real interface charge associated with the jump of the normal component of \(\mathbf M\).

So if a user encodes a sharp interface by smearing `Ms` over a few cells and then complains that demag changes, the problem is **not** that the magnetostatics is wrong. The problem is that a **continuous constitutive field** is being used to emulate a **sharp interface**.

### 2.2 Multi-body coupled system

In this mode there are multiple reduced magnetization fields
\[
\mathbf m_k(\mathbf x,t), \qquad k=1,\dots,N,
\]
each living on its own body \(\Omega_k\), with
\[
\mathbf M_k = M_{s,k}\mathbf m_k.
\]

The total energy is of the form
\[
E = \sum_k E_k^{\text{self}} + \sum_{k<\ell} E_{k\ell}^{\text{coupling}}.
\]

Typical structure:

- self exchange inside each body,
- self anisotropy inside each body,
- self DMI inside each body,
- global demagnetization from the union of all magnetizations,
- optional explicit inter-body couplings:
  - direct contact exchange,
  - bilinear / biquadratic surface exchange,
  - future chiral or spin-transport couplings.

This mode is the correct one if the user means:

- multiple layers in a stack,
- magnets separated by a spacer,
- touching but conceptually distinct bodies,
- different native grids per body,
- explicit control of what does and does not couple across an interface.

This distinction is the categorical fix for the “region problem”.

---

## 3. Exchange: what is rigorous, what is only a semantic abuse

### 3.1 Continuum exchange in a heterogeneous body

The exchange energy is
\[
E_{\mathrm ex}
=
\int_\Omega A(\mathbf x)\,|\nabla \mathbf m|^2\,dV.
\]

Its variational derivative gives
\[
\mathbf H_{\mathrm ex}
=
\frac{2}{\mu_0 M_s}
\nabla \cdot \big(A \nabla \mathbf m\big).
\]

Across a sharp internal material jump \(\Sigma\) in a **single-body** model, the natural flux continuity condition is
\[
A^-\,\partial_n \mathbf m^- = A^+\,\partial_n \mathbf m^+.
\]

That is the continuum statement that must be preserved.

### 3.2 The harmonic mean needs a narrower statement

A common overstatement is:

> “The harmonic mean is not rigorous; it is just a hack.”

That statement is too strong.

For a **single shared Cartesian grid with cellwise constant `A`**, the face-centered discrete exchange coefficient
\[
A_f = \frac{2A_iA_j}{A_i+A_j}
\]
is a valid discrete realization of the jump condition when the interface is represented at the cell face.

Equivalently, one may derive the same result from a virtual-point / ghost-point construction at the interface.

So the correct statement is:

- the **continuum truth** is flux continuity \(A^- \partial_n m^- = A^+ \partial_n m^+\),
- one correct FDM realization on a shared grid is a **face-based coefficient** that reduces to the harmonic mean for piecewise-constant `A`,
- the exchange field on each side must still be divided by the **local** \(M_{s,i}\) and local cell volume.

What Fullmag should reject is not the harmonic mean *per se*, but the idea that:

- region adjacency alone should define all interface physics,
- inter-body contact, graded media, and surface exchange are all “the same thing”.

### 3.3 The real architectural rule for Fullmag

Inside a single heterogeneous body, exchange should be realized from a **face-based discrete energy**
\[
E_{\mathrm ex,h}
=
\sum_{f=i|j}
A_f\,\frac{S_f}{d_f}\,\|\mathbf m_j-\mathbf m_i\|^2.
\]

Then
\[
\mathbf H_{\mathrm ex,i}
=
\frac{2}{\mu_0 M_{s,i}V_i}
\sum_{f=i|j}
A_f\,\frac{S_f}{d_f}(\mathbf m_j-\mathbf m_i).
\]

This is the correct architectural foundation because it supports:

- non-cubic cells,
- local \(M_s\),
- piecewise materials,
- smooth fields,
- explicit interface-aware coefficients.

### 3.4 Inter-body exchange must be explicit

For **different ferromagnetic bodies**, Fullmag should not infer direct exchange just because two voxelized masks touch.

Instead, it should use one of two explicit routes:

#### Route A — same body, heterogeneous material

Use one magnetization field and internal material assignment / parameter fields.

#### Route B — distinct bodies, explicit coupling

Keep two magnetization fields and declare an explicit coupling object, for example:

- `ContactExchange(body_a, body_b, ...)`
- `SurfaceExchange(body_a.surface("top"), body_b.surface("bottom"), sigma, sigma2)`

This prevents geometry adjacency from silently changing physics.

---

## 4. Surface exchange and RKKY / IEC

If two bodies interact through a surface energy
\[
E_{\mathrm IEC}
=
-\int_\Sigma \sigma_1(\mathbf m_1\cdot \mathbf m_2)\,dA
-\int_\Sigma \sigma_2(\mathbf m_1\cdot \mathbf m_2)^2\,dA,
\]
then the corresponding fields scale like a **surface contribution**, i.e. after discretization they scale with \(1/\Delta\), not \(1/\Delta^2\).

This is fundamentally different from bulk exchange.

Therefore Fullmag should represent IEC as a dedicated interface / surface coupling, not as a special value of `A` painted into cells.

That distinction matters both physically and numerically:

- bulk exchange is volumetric,
- IEC is interfacial,
- the units are different,
- the implementation data structures should therefore be different.

---

## 5. Demagnetization: what is physical and what is artificial

### 5.1 What is always physical

Magnetostatics depends on the physical magnetization \(\mathbf M\), not on the reduced field \(\mathbf m\) alone.

So if the model says
\[
\mathbf M = M_s(\mathbf x)\mathbf m,
\]
then the demag operator must be driven by that \(\mathbf M\).

This implies:

- smooth `Ms(x)` changes the demag source,
- jumps in `Ms` change the demag source,
- changing geometry changes the demag source,
- changing the active magnetic domain changes the demag source.

All of that is physical.

### 5.2 What becomes artificial

It becomes artificial when the user intent is one thing, but the encoded model is another.

Examples:

1. **Intended physics:** two sharp bodies with an abrupt interface.  
   **Encoded model:** one body with a smoothed `Ms(x)` bridge over 2–3 cells.  
   Result: the demag field corresponds to a graded ferromagnet, not to the intended sharp-interface problem.

2. **Intended physics:** two ferromagnets separated by a spacer.  
   **Encoded model:** one grid with `Ms=0` spacer cells and hidden exchange tweaks between selected regions.  
   Result: interface, spacer, and coupling semantics are entangled.

3. **Intended physics:** no exchange between touching bodies.  
   **Encoded model:** one region-painted lattice where neighbor formulas automatically couple touching cells.  
   Result: the numerical representation quietly changes the physics.

The categorical Fullmag solution is therefore not to “remove demag gradients”, but to make the model semantics explicit enough that the correct demag source follows automatically.

---

## 6. DMI, anisotropy, damping, and other coefficients

Different coefficients interact with spatial variation in different ways.

### 6.1 `Ms`

- changes \(\mathbf M\) directly,
- therefore changes demag directly,
- must be treated as magnetostatically sensitive.

### 6.2 `A`

- enters the differential operator,
- must be represented as a face-centered / interface-aware coefficient in FDM,
- should not be implemented as a naive cellwise \(A_i \nabla_h^2 \mathbf m_i\).

### 6.3 `K` and anisotropy axis

- no direct magnetostatic source comes from the coefficient field itself,
- but they modify the equilibrium magnetization and therefore indirectly affect demag.

### 6.4 `\alpha`

- dynamical coefficient only,
- affects time evolution, not static energy or magnetostatic source directly.

### 6.5 `D`

For standard interfacial DMI in thin films, `D` is best understood as belonging to the ferromagnetic body (or the body-side interface condition that it owns), not as a generic inter-body exchange term.

So in Fullmag v1:

- DMI should remain a **body-local chiral energy term**,
- sign and value may differ from body to body,
- explicit cross-body chiral couplings can be deferred to a future dedicated feature.

---

## 7. LLG dynamics for multi-body systems

For multiple coupled bodies,
\[
\frac{d\mathbf m_k}{dt}
=
-\gamma_0\,\mathbf m_k \times \mathbf H_{\mathrm eff,k}
+
\alpha_k\,\mathbf m_k \times \frac{d\mathbf m_k}{dt}.
\]

Each body has its own:

- \(M_{s,k}\),
- \(A_k\),
- \(\alpha_k\),
- anisotropy,
- DMI,
- native grid.

But once demag or explicit inter-body couplings are active, the system is **not separable**.

Therefore Fullmag should enforce:

- one global time step per coupled simulation,
- synchronous RHS evaluation for all bodies,
- adaptive-step error control based on the aggregate error over all bodies.

Per-body asynchronous stepping is not compatible with a tightly coupled magnetostatic solve.

---

## 8. The Fullmag semantic split

The correct semantic split is:

### 8.1 `Geometry`
Pure spatial asset. Analytic or imported. No physics yet.

### 8.2 `Region`
Topological / ownership label. Useful for imported geometry, subdomain marking, and piecewise assignment.  
A region is **not** itself an energy term.

### 8.3 `Ferromagnet`
A magnetic body with:

- geometry,
- material law,
- initial magnetization,
- optional native grid hints.

This should remain the primary owner of a magnetization field.

### 8.4 `MaterialLaw`
Describes the constitutive law inside a ferromagnet:

- uniform,
- piecewise by subregion,
- continuous or sampled parameter fields.

### 8.5 `ParameterField`
A spatial coefficient field with explicit semantics.

Examples:

- `Ms_field`
- `A_field`
- `Ku1_field`
- `anisU_field`
- `alpha_field`
- `D_field`

These should be opt-in and capability-checked.

### 8.6 `Coupling`
Physics between different bodies or interfaces.

Examples:

- `ContactExchange`
- `SurfaceExchange`
- future `ChiralInterfaceCoupling`
- future transport-mediated coupling

Demag is special: it is global and always present whenever `Demag()` is enabled.

---

## 9. Recommended Fullmag policy

### 9.1 What should be first-class

Fullmag should make the following first-class:

1. **one-body heterogeneous media**,
2. **multi-body coupled magnets**,
3. **explicit interface couplings**,
4. **parameter fields with declared semantics**,
5. **per-body native discretization**.

### 9.2 What should not be the primary abstraction

Fullmag should not make the following the primary physics abstraction:

- “region adjacency implies exchange”,
- “touching masks imply inter-body coupling”,
- “all spatial variation is region painting”,
- “smearing coefficients is the default way to model interfaces”.

### 9.3 Validation warnings that should exist

Fullmag should emit strong warnings when:

- a user assigns an `Ms` field and appears to use it to emulate a sharp body boundary,
- a user creates multiple touching ferromagnets but no explicit coupling,
- a user uses a coupling object incompatible with the selected backend,
- a user requests heterogeneous `A(x)` on a backend that only supports naive cellwise exchange.

---

## 10. Proposed public API direction

The current public model already points in the right direction because it is built around multiple `Ferromagnet` objects rather than a global region-painted material table.

The missing step is to make couplings and material fields explicit.

### 10.1 Desired examples

#### A. Single-body graded medium

```python
rod = fm.geometry(fm.Box(1e-6, 100e-9, 20e-9), name="rod")
rod.Ms = 800e3
rod.Aex = 13e-12
rod.alpha = 0.02
rod.m = fm.uniform(1, 0, 0)

# future, explicit constitutive field semantics:
# rod.material_field("Ms", ms_profile, semantics="constitutive")
# rod.material_field("Ku1", ku_profile, semantics="constitutive")
```

#### B. Two bodies with only dipolar coupling

```python
a = fm.geometry(fm.Box(500e-9, 500e-9, 5e-9), name="a")
a.Ms = 800e3
a.Aex = 13e-12

b = fm.geometry(fm.Box(500e-9, 500e-9, 5e-9).translate(0, 0, 20e-9), name="b")
b.Ms = 1000e3
b.Aex = 20e-12

# demag couples them automatically
# no exchange between a and b unless explicitly declared
```

#### C. Two touching bodies with explicit direct contact exchange

```python
# proposed future API
# fm.contact_exchange(a, b, law="continuum_contact")
```

#### D. Two surfaces with bilinear / biquadratic coupling

```python
# proposed future API
# fm.surface_exchange(a, b, sigma=-1e-4, sigma2=0.0)
```

---

## 11. Numerical consequences for Fullmag

### 11.1 Single-body heterogeneous FDM path

Required properties:

- demag computed from \(\mathbf M_i = M_{s,i}\mathbf m_i\),
- exchange from face-based energy,
- heterogeneous `A` through face coefficients,
- local \(M_{s,i}\) in field normalization,
- active-mask / nonmagnetic handling consistent with exchange BC.

### 11.2 Multi-body FDM path

Required properties:

- one native grid per body,
- optional common convolution grid for demag,
- transfer operators between native and convolution grids,
- self + cross demag accumulation,
- body-local self energies,
- explicit coupling operators across bodies,
- synchronous LLG integration.

### 11.3 Important identity

For aligned single-layer cases, the multilayer demag path should reduce exactly to the single-layer exact tensor demag path.  
This is an important consistency requirement and should remain a regression test.

---

## 12. Final design thesis

The correct Fullmag solution to the “region problem” is:

1. keep **regions** as topology and labeling,
2. keep **ferromagnets** as owners of magnetization fields,
3. allow **material laws / parameter fields** inside a ferromagnet,
4. make **inter-body couplings explicit**,
5. compute demag from the physical magnetization \(\mathbf M\), never from \(\mathbf m\) alone,
6. never rely on region painting as the universal carrier of interface physics.

That approach does **not** deny the existence of real coefficient gradients.  
It simply refuses to confuse them with sharp interfaces between bodies.

---

## 13. Practical decision for Fullmag

If the user intends:

- **a true graded medium** → use one body + constitutive fields,
- **a sharp internal jump but one continuum magnetization field** → use one body + piecewise material assignment + interface-aware exchange discretization,
- **distinct touching bodies** → use multiple bodies + explicit contact coupling,
- **separated bodies with spacer-mediated coupling** → use multiple bodies + explicit surface exchange / IEC,
- **only stray-field interaction** → use multiple bodies and declare no exchange coupling.

This is the cleanest possible semantic contract.



---

## 14. Suggested references for the repo note

### Fullmag repository
- `docs/physics/0100-mesh-and-region-discretization.md`
- `docs/physics/0400-fdm-exchange-demag-zeeman.md`
- `docs/physics/0421-fdm-multilayer-convolution-demag.md`
- `docs/physics/0440-fdm-interfacial-dmi.md`
- `packages/fullmag-py/src/fullmag/world.py`
- `packages/fullmag-py/src/fullmag/model/discretization.py`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-engine/src/multilayer.rs`
- `crates/fullmag-fdm-demag/src/transfer.rs`

### External references
- Paul Heistracher et al., *Proposal for a micromagnetic standard problem: Domain wall pinning at phase boundaries*, JMMM 548 (2022) 168875.
- Claas Abert, *Micromagnetics and spintronics: models and numerical methods*, Eur. Phys. J. B 92, 120 (2019).
- OOMMF User Guide, `Oxs_Exchange6Ngbr`, `Oxs_ExchangePtwise`, `Oxs_TwoSurfaceExchange`.
- mumax3 exchange implementation and workshop Q&A on inter-region exchange.
- Lucian Lepadatu, multilayer / multiscale convolution demagnetization papers for variable-resolution layered systems.

