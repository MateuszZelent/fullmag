# FDM boundary-corrected staircase mitigation

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-28
- Related ADRs: none yet
- Related specs:
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`

## 1. Problem statement

Standard FDM micromagnetics approximates curved boundaries by a "staircase" of axis-aligned cells.
This introduces two distinct classes of error:

1. **Exchange error.** The Neumann boundary condition $\partial_n \mathbf{m}|_{\partial\Omega} = 0$
   is imposed on the *staircase surface* instead of the *physical boundary*. This creates spurious
   vortices, shifts domain wall equilibria, and makes frequency spectra orientation-dependent.
   García-Cervera et al. [1] showed ~50% errors in boundary mode frequencies surviving even at
   doubled resolution with naïve correction, vs <5% with proper boundary stencils.

2. **Demagnetization error.** Binary cell occupancy generates incorrect surface pole distributions.
   The far-field is approximately right (wrong total volume only), but the near-field around boundary
   cells has $O(\Delta x / R)$ errors where $R$ is curvature radius.

### 1.1 Why simple volume-fraction weighting is insufficient

Approaches like mumax3's `EdgeSmooth` or amumax's `GeomPhi` estimate volumetric fill fractions from
sub-sampling (typically $n^3$ points per cell). This corrects the **geometry** but not the
**differential operator** at the boundary:

- Exchange: weighting by $\varphi_i$ rescales the field magnitude but still imposes Neumann BC on
  the staircase surface. The exchange *stencil* is unchanged — it still connects cell centers at
  grid spacing $\Delta x$, oblivious to where the true boundary intersects the link.
- Demag: volume-weighted $\mathbf{M}_i = \varphi_i M_s \mathbf{m}_i$ corrects the total dipole
  moment but not the *spatial distribution* of surface charges within boundary cells.

This note describes a **3-tier architecture** that goes qualitatively beyond volume weighting,
progressing from cheapest to most accurate:

| Tier | Exchange | Demag | Cost |
|------|----------|-------|------|
| **T0: Volume-weighted** | Face-link-scaled coupling / $\varphi$ normalization | $\varphi$-weighted FFT packing | Geometry computation only |
| **T1: Boundary-corrected** | ECB/García stencil modification using intersection distance $\delta$ | Donahue–McMichael $H_{\text{rough}} + H_{\text{corr}}$ sparse correction | Precomputation of $\delta$ per face + sparse tensor |
| **T2: AMR-enhanced** | T1 + adaptive refinement in boundary strip | T1 + refined FFT or local direct sum at boundary | Runtime multi-level overhead |

The target implementation is **T1** (boundary-corrected), with T0 as a fast fallback and T2 as
future extension.

## 2. Physical model

### 2.1 Governing equations (unchanged)

Exchange field and demag field are defined identically to `0400-fdm-exchange-demag-zeeman.md`. The
correction is purely in the discrete operator, not the continuum model.

### 2.2 Boundary geometry data

For each grid cell $i$, define:

| Quantity | Symbol | Range | Meaning |
|----------|--------|-------|---------|
| Volume fraction | $\varphi_i$ | $[0, 1]$ | Fraction of cell volume occupied by material |
| Face link fraction | $f_{i \to j}$ | $[0, 1]$ | Fraction of shared face area inside material |
| Boundary intersection distance | $\delta_{i \to j}$ | $[0, \Delta x]$ | Distance from cell center $i$ to the boundary along the axis toward $j$ |
| Boundary normal | $\hat{n}_i$ | unit vector | Approximate outward normal of the physical boundary at cell $i$ |

**T0** uses only $\varphi_i$ and $f_{i \to j}$.
**T1** additionally uses $\delta_{i \to j}$ and optionally $\hat{n}_i$.

### 2.3 Computation of boundary data (planning phase)

All sub-cell data is computed from the SDF (signed distance function) during geometry lowering:

1. **Volume fraction** $\varphi_i$: adaptive quadrature over cell volume (e.g. $R^3$ sub-samples).

2. **Face link fraction** $f_{i \to j}$: adaptive quadrature over the shared face (e.g. $R^2$
   sub-samples on the face).

3. **Intersection distance** $\delta_{i \to j}$: find the root of $\text{SDF}(x) = 0$ along the
   line segment from cell center $i$ to cell center $j$. This is a 1D root-finding problem on the
   SDF, solved by bisection or Newton's method. If the boundary does not cross the segment,
   $\delta_{i \to j} = \Delta x$ (full interior) or $\delta_{i \to j} = 0$ (full exterior).

4. **Boundary normal** $\hat{n}_i$: $\hat{n}_i = \nabla\text{SDF}(\mathbf{r}_i) / |\nabla\text{SDF}(\mathbf{r}_i)|$, evaluated at the intersection point.

### 2.4 Stability floor

Division by $\varphi_i$ or by small $\delta$ values diverges. Clamp:

$$
\varphi_i^{\text{eff}} = \max(\varphi_i, \varphi_{\min}), \qquad
\delta_{i \to j}^{\text{eff}} = \max(\delta_{i \to j}, \delta_{\min}).
$$

Defaults: $\varphi_{\min} = 0.05$, $\delta_{\min} = 0.1 \Delta x$.

## 3. Numerical interpretation

### 3.1 T0: Volume-weighted correction (amumax level)

This tier is the amumax/EdgeSmooth approach — included for fast mode and as baseline comparison.

#### Exchange

$$
\mathbf{H}_{\text{ex},i}^{(T0)}
=
\frac{2}{\mu_0 M_{s,i}}
\frac{1}{\max(\varphi_i, \varphi_{\min})}
\sum_{\text{faces}} f_{i \to j} \cdot \frac{A_f}{\Delta x_f^2}
(\mathbf{m}_j - \mathbf{m}_i).
$$

**What it fixes:** Total exchange flux scaled by actual interfacial area.
**What it doesn't fix:** Neumann BC is still on the staircase, not the physical boundary.

#### Demag

Pack $\mathbf{M}_i = \varphi_i M_s \mathbf{m}_i$ into the FFT. No near-field correction.

### 3.2 T1: Boundary-corrected (García-Cervera/ECB + Donahue–McMichael)

This is the target tier. It modifies the **differential operator** at boundary cells.

#### 3.2.1 Exchange: ECB-style boundary stencil

The key insight from García-Cervera et al. [1] and Parker/Cerjan/Hewett [2]: the standard FDM
stencil assumes the function value extends to the next grid point. When a boundary crosses the link,
the Neumann condition $\partial_n \mathbf{m} = 0$ must be imposed at the intersection point, not at
the neighboring grid point.

**Standard stencil** (interior cell):

$$
\frac{\partial^2 m}{\partial x^2}\bigg|_i
\approx
\frac{m_{i+1} - 2m_i + m_{i-1}}{\Delta x^2}.
$$

**Boundary-corrected stencil** (cell $i$ with boundary at distance $\delta$ toward +x):

The Neumann condition $\partial_x m|_{x_i + \delta} = 0$ combined with the interior value $m_i$
gives, by quadratic extrapolation, a ghost value $m_{\text{ghost}} = m_i$. But this is what the
clamped-neighbor Neumann already does! The true improvement comes from the **denominator**:

The second derivative at a point with non-uniform spacing (interior neighbor at $\Delta x$,
boundary at $\delta < \Delta x$) is:

$$
\frac{\partial^2 m}{\partial x^2}\bigg|_i
\approx
\frac{2}{\Delta x + \delta}
\left(
\frac{m_{i-1} - m_i}{\Delta x}
+
\frac{m_{\text{boundary}} - m_i}{\delta}
\right).
$$

With Neumann BC: $m_{\text{boundary}}$ is extrapolated from $m_i$ such that $\partial_n m = 0$ at
the boundary, yielding $m_{\text{boundary}} = m_i$. Therefore:

$$
\frac{\partial^2 m}{\partial x^2}\bigg|_i
\approx
\frac{2}{\Delta x + \delta} \cdot
\frac{m_{i-1} - m_i}{\Delta x}.
$$

Compare with the standard clamped stencil (which effectively uses $\delta = \Delta x$):

$$
\frac{\partial^2 m}{\partial x^2}\bigg|_i^{\text{standard}}
=
\frac{m_{i-1} - m_i}{\Delta x^2}.
$$

The boundary-corrected version has a factor of $\frac{2\Delta x}{\Delta x + \delta}$ relative to
the standard version. For $\delta = \Delta x$ (no boundary), this factor is 1 (correct).
For $\delta \to 0$ (boundary right at cell center), the factor is 2 (stronger coupling to interior
neighbor, matching the halved effective cell size).

**Full 3D exchange field** for a boundary cell:

For each axis $\alpha \in \{x, y, z\}$ and each direction $\pm$, the exchange contribution is:

$$
H_{\text{ex},\alpha}^{(\pm)}
=
\begin{cases}
\frac{2A}{\mu_0 M_s} \cdot \frac{2}{\Delta x_\alpha(\Delta x_\alpha + \delta_\pm)} (m_{j} - m_i)
& \text{if neighbor } j \text{ is interior} \\[6pt]
\frac{2A}{\mu_0 M_s} \cdot \frac{2}{\Delta x_\alpha(\Delta x_\alpha + \delta_\mp)} \cdot 0
& \text{if boundary at } \delta_\pm,\; \partial_n m = 0 \\[6pt]
\text{standard stencil} & \text{if fully interior both sides}
\end{cases}
$$

**What this fixes:** The Laplacian operator is now consistent with the physical boundary location.
García-Cervera [1] showed this eliminates spurious vortices and makes a $100 \times 100$ grid
equivalent to $200 \times 200$ without correction.

**Data needed per cell:** 6 intersection distances $\delta_{i,\pm x}, \delta_{i,\pm y},
\delta_{i,\pm z}$ (f64 or f32), computed from the SDF at planning time.

#### 3.2.2 Demag: $H_{\text{rough}} + H_{\text{corr}}$ (Donahue–McMichael)

Decompose the demag field into:

$$
\mathbf{H}_{\text{demag}} = \mathbf{H}_{\text{rough}} + \mathbf{H}_{\text{corr}}.
$$

- **$\mathbf{H}_{\text{rough}}$**: Standard FFT convolution with $\varphi$-weighted packing (T0
  demag). This is fast ($O(N\log N)$) and gives the correct far-field.

- **$\mathbf{H}_{\text{corr}}$**: Sparse local correction for boundary cells. For each boundary
  target cell $i$ and each source cell $j$ in a local stencil (radius $R$, typically $R=1$):

$$
\Delta N_{\alpha\beta}(i,j)
=
\underbrace{\sum_{a \in \text{sub}(i)} \sum_{b \in \text{sub}(j)}
\frac{w_a}{\Sigma w_a} \frac{w_b}{\Sigma w_b}
N_{\alpha\beta}^{\text{fine}}(\mathbf{r}_a - \mathbf{r}_b)}_{\text{refined near-field}}
-\;
\underbrace{N_{\alpha\beta}^{\text{coarse}}(\mathbf{r}_i - \mathbf{r}_j)}_{\text{what FFT already did}}.
$$

Then at runtime:

$$
H_{\text{corr},\alpha}(i) = -\sum_{j \in \text{stencil}(i)} \sum_\beta
\Delta N_{\alpha\beta}(i,j) \cdot \varphi_j M_s m_{\beta,j}.
$$

**This is the same approach as in the initial plan and in amumax's `demag_boundary.go`.** The
upgrade from T0 is that T1 includes the sparse correction, not just the volume-weighted packing.

### 3.3 T2: AMR-enhanced (future)

García-Cervera/Roma [5] showed adaptive mesh refinement combined with boundary correction. The AMR
refines the grid in a strip around the physical boundary (and around domain walls), giving both
better boundary representation and better resolution of sharp features.

AMR on GPU is architecturally complex and requires multi-level FFT. Deferred.

### 3.4 FEM

FEM naturally handles geometry through unstructured meshes. This note is FDM-only.
Fullmag's FEM path (`0410-fem-exchange-demag-zeeman-mfem-gpu.md`) is the "ultimate" solution for
complex 3D geometries, but the FDM path must also handle curved boundaries well.

## 4. API, IR, and planner impact

### 4.1 Python API surface

```python
sim.grid = fm.Grid(
    nx=128, ny=128, nz=1,
    dx=2e-9, dy=2e-9, dz=2e-9,
    boundary_correction="none",     # "none", "volume", "full"
    boundary_phi_floor=0.05,
    demag_boundary_correction=True, # sparse local demag correction
    demag_boundary_refine=4,        # sub-cell refinement for demag
    demag_boundary_radius=1,        # stencil radius for demag corr
)
```

- `"none"`: binary mask (current behavior)
- `"volume"`: T0 — face-link + $\varphi$ weighting (amumax level)
- `"full"`: T1 — ECB stencil + Donahue $H_{\text{corr}}$ (target)

### 4.2 ProblemIR representation

Lives in `FdmPlanIR` (execution plan, not physics-level IR):

- `boundary_correction_tier: u8` (0, 1, 2)
- `phi_floor: f64`
- `delta_min: f64`
- `demag_boundary_enabled: bool`
- `demag_boundary_refine: u32`
- `demag_boundary_radius: u32`

### 4.3 Context structure changes

```diff
  // Boundary geometry (T0 + T1)
+ bool   has_boundary_correction = false;
+ uint8_t boundary_correction_tier = 0;   // 0=none, 1=volume, 2=full
+ double phi_floor = 0.05;
+ double delta_min_fraction = 0.1;
+ void  *volume_fraction = nullptr;   // f64[N]: φ_i
+ void  *face_link_xp = nullptr;      // f64[N]: face fraction +x
+ void  *face_link_xm = nullptr;
+ void  *face_link_yp = nullptr;
+ void  *face_link_ym = nullptr;
+ void  *face_link_zp = nullptr;
+ void  *face_link_zm = nullptr;
  // T1 only: intersection distances
+ void  *delta_xp = nullptr;          // f64[N]: distance to boundary +x
+ void  *delta_xm = nullptr;
+ void  *delta_yp = nullptr;
+ void  *delta_ym = nullptr;
+ void  *delta_zp = nullptr;
+ void  *delta_zm = nullptr;
  // Sparse demag correction
+ bool     has_demag_boundary_corr = false;
+ uint32_t demag_corr_target_count = 0;
+ uint32_t demag_corr_stencil_size = 0;
+ void    *demag_corr_target_idx = nullptr;
+ void    *demag_corr_source_idx = nullptr;
+ void    *demag_corr_tensor = nullptr;
```

## 5. Validation strategy

### 5.1 T0 validation

- Uniform $\mathbf{m}$ in a disk: $H_{\text{ex}} = 0$.
- Full cells ($\varphi=1$, links=1): bitwise parity with binary kernel.
- Sphere demag convergence vs analytical $-M_s/3$.

### 5.2 T1 validation (critical)

1. **García-Cervera rotation test:** Simulate a permalloy square with a magnetic configuration,
   then rotate the square by 30° on the same grid. Without correction, the equilibrium changes
   significantly. With T1, the equilibrium should be rotation-invariant within a few percent.

2. **Donahue frequency test:** Simulate FMR modes of a disk. Compare mode frequencies with and
   without correction. Reference: Donahue–McMichael showed ~50% frequency shift without
   correction, <5% with correction.

3. **Grid convergence:** Plot exchange/demag energy vs cell count for a cylinder. T1 should
   converge 2-4× faster than T0, which should converge faster than binary.

### 5.3 Regression tests

All existing tests must pass with `boundary_correction="none"` (backward compatibility).

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner (SDF → $\varphi$, $f$, $\delta$, sparse tensor)
- [ ] Capability matrix
- [ ] FDM backend: T0 exchange kernel
- [ ] FDM backend: T1 exchange kernel (ECB stencil)
- [ ] FDM backend: T0 demag ($\varphi$-weighted packing)
- [ ] FDM backend: T1 demag ($H_{\text{corr}}$ sparse)
- [ ] Context structure
- [ ] FEM backend: n/a
- [ ] Tests / benchmarks
- [ ] Documentation

## 7. Known limits and deferred work

- T1 assumes **static geometry** (SDF evaluated once at planning time).
- **DMI** correction follows the same pattern but is deferred.
- **AMR** (T2) is orthogonal and deferred.
- The sparse demag precomputation is $O(N_{\text{shell}} \cdot S \cdot R^6)$ and slow for large
  shells with high refinement — disk caching is desirable.
- CPU reference with boundary correction is deferred until GPU path is validated.

## 8. References

1. C. J. García-Cervera, Z. Gimbutas, and W. E, "Accurate numerical methods for micromagnetics
   simulations with general geometries," *J. Comput. Phys.* 184, 37–52 (2003).
2. S. E. Parker, C. Cerjan, and D. W. Hewett, "Embedded curve boundaries with the ECB algorithm,"
   LLNL Report, OSTI.gov/12217 (1997).
3. M. J. Donahue and D. G. Porter, "Non-uniform thickness micromagnetic model," in *Proc. 11th
   EMMA Workshop* (2001).
4. M. J. Donahue and R. D. McMichael, "Exchange energy representations in computational
   micromagnetics," *Physica B* 233(4), 272–278 (1997).
5. C. J. García-Cervera and A. M. Roma, "Adaptive mesh refinement for micromagnetics simulations,"
   *IEEE Trans. Magn.* 42(6), 1648–1654 (2006).
6. MagTense: R. Bjørk et al., "MagTense: A micromagnetic framework using the analytical
   demagnetization tensor," *J. Magn. Magn. Mater.* 535, 168057 (2022).
