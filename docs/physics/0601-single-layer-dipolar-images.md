# Stable FDM demagnetizing images for a single magnetic layer

- Status: numerical correction under validation
- Last updated: 2026-11-23
- Physical boundary contract: [Periodic boundary conditions](0600-periodic-boundary-conditions.md)

(single-layer-dipolar-problem-statement)=
## 1. Problem statement

A magnetic cell layer can be periodic along one in-plane axis while
the transverse direction and thickness remain open. The requested
finite replica count applies to dipolar coupling and is distinct
from the local exchange wrapping. The Gruszecki Fig. 4b control
has a 500 × 800 × 1 mesh, 20 nm cubic cells and 32 images of the
10 µm period on each side.

(single-layer-dipolar-governing-equations)=
## 2. Physical model

For a grid lag r, normalize the Newell tensor N by the destination
cell volume and sum the requested source images. With p a periodic
axis, L_p = N_p h_p, and I the image count, the discrete tensor is
```{math}
:label: eq-single-layer-images
N^{P}_{ij}(\mathbf{r}) = \sum_{n=-I}^{I} N_{ij}(\mathbf{r}+nL_p\hat{\mathbf{e}}_p), \qquad \mathbf{H}_d = -N^{P} * \mathbf{M}.
```

Use Cartesian cell pitches h in metres,
magnetization and field in A/m, and dimensionless tensor entries.
In a self interaction N_ij(r) = N_ij(−r). Diagonal components are
even in each coordinate, and N_xy is odd in both x and y. The two
in-plane-to-normal components vanish for a symmetric single layer.

(single-layer-dipolar-assumptions-and-validity)=
### Validity and numerical stability

The finite cell-volume Newell calculation uses differences of
functions scaling as r³. The physical residue scales as r⁻³.
At distant images, the binary64 subtraction loses the residue by
many orders of magnitude. For the Fig. 4b case the diagonal pair at
lag (16000, 0, 0) gave −3.2141e−4 for N_xx when replaying the old
arithmetic and −3.8856e−14 from independent cell-volume quadrature.
The folded diagonal tail error in sampled lags reached 1.438e−3
for the 500-cell period versus 7.986e−6 for the 100-cell control.

Evaluate near lags with the existing equal-cell Newell primitive
stencil. For distance at least 40 times the largest cell pitch,
use the same point-dipole limit as the existing centred XY FDM
builder.

```{math}
:label: eq-single-layer-distant-tensor
N_{ij}(\mathbf{r}) \simeq \frac{V}{4\pi |\mathbf{r}|^3}\left(\delta_{ij}-\frac{3r_i r_j}{|\mathbf{r}|^2}\right).
```

The finite cell
size corrections decrease as O(h²/r²) relative to the tensor
scale. All requested images still participate. Validate the
threshold by cell-volume quadrature over representative aspect
ratios and keep finite replica truncation distinct from the
pair-approximation error. At the cutoff, independent tensor
quadrature over 19 in-plane directions gives relative Frobenius
errors up to 1.71e−7 for cubic cells and 6.24e−4 for the tested
anisotropic cells, including pitches in a 20:1 ratio. At the
self-conjugate Nyquist lag, use
the average of the equivalent nearest signed representatives.


(single-layer-dipolar-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $N^{P}_{ij}$ | Periodically folded demagnetizing tensor component | $1$ |
| $N_{ij}$ | Open equal-cell demagnetizing tensor component | $1$ |
| $\mathbf{r}$ | Displacement between cell centers | $\mathrm{m}$ |
| $n$ | Signed image index | $1$ |
| $I$ | Number of replicas per side | $1$ |
| $p$ | Periodic Cartesian axis index | $1$ |
| $L_p$ | Physical period along the periodic axis | $\mathrm{m}$ |
| $\hat{\mathbf{e}}_p$ | Unit vector along the periodic axis | $1$ |
| $\mathbf{H}_d$ | Demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{M}$ | Cell magnetization | $\mathrm{A\,m^{-1}}$ |
| $V$ | Volume of one cell | $\mathrm{m^3}$ |
| $\delta_{ij}$ | Kronecker delta | $1$ |
| $i,j$ | Cartesian tensor component indices | $1$ |
| $r_i,r_j$ | Cartesian displacement components | $\mathrm{m}$ |

(single-layer-dipolar-discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM

Compute on the minimal circular lattice along the periodic axis
and on the doubled zero-padded lattice along the open axis. Fold
images directly into centred lags. Populate the opposite lags by
tensor parity. This removes both the distant subtraction and the
allocation proportional to the number of replicas. The largest
intermediate kernel has the same shape as the requested padded
convolution. Retain the existing one-layer open-Z layout.

(single-layer-dipolar-implementation-mapping)=
#### CPU and CUDA

The CPU reference and native CUDA share the host tensor builder.
CUDA uploads the same physical coefficients before its FFT.
The regression targets binary64. Existing CUDA single-precision
qualification policy still applies.

### 3.2 FEM and hybrid

The changed method realizes the Cartesian FDM quadrature only.
FEM periodic demagnetization follows the linked physical boundary
contract. Hybrid does not add a boundary realization in this change.

(single-layer-dipolar-python-api)=
## 4. API, IR, planner, runtime and artifacts

The object-level example inspects the boundary input independently of a simulation.

```python
# %%
import fullmag as fm

periodicity = fm.FdmPbc((True, False, False), demag="truncated_images", image_counts=(32, 0, 0))

# %%
print(periodicity.to_ir())
```

(single-layer-dipolar-problem-ir)=
### ProblemIR mapping

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend | IR destination |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FdmPbc.axes | tuple[bool, bool, bool] | required | 1 | Three Cartesian flags with one lateral periodic axis for this kernel | Periodic axes | FDM CPU/GPU | backend_policy.pbc.axes |
| FdmPbc.demag | str | open | 1 | truncated_images selects this kernel for a supported mesh | Dipolar boundary policy | FDM CPU/GPU | backend_policy.pbc.demag |
| FdmPbc.image_counts | tuple[int, int, int] or None | None | 1 | Three nonnegative counts for truncated_images or None | Replicas per side by axis | FDM CPU/GPU | backend_policy.pbc.image_counts |

(single-layer-dipolar-round-trip-and-failure-semantics)=
### Round-trip and failure semantics

The requested intent records the axis flags, policy and image counts.
Resolved execution records the effective kernel and replica count. The
canonical boundary policy carries through Python and workspace export.
Malformed counts produce validation errors. Unsupported combinations
follow the planner and geometry checks in the periodic boundary contract.

The Python and workspace authoring intent stays the finite
truncated-images policy. The existing image count, cell sizes, and
boundary conditions lower through the same ProblemIR and planner
representations. The same solver stage lifecycle and capability
matrix apply. The actual package build identity in runtime field
and Zarr provenance distinguishes corrected artifacts from earlier
ones. The field units, resource shape, transport and source-owner
contract follow the existing interfaces.

(single-layer-dipolar-validation)=
## 5. Validation strategy

1. Compare selected legacy and corrected tensor coefficients with
   independent cell-volume quadrature through the far replica range.
2. Test reflection and Nyquist parity, padding and stable self terms
   for X-periodic/Y-open and Y-periodic/X-open one-layer cases.
3. Compare CPU and CUDA on the same physical inputs and rerun the
   500 × 800 × 1 saturated YIG control with the full image count.
4. Verify perpendicular saturation through the tested propagation
   window before using the result for the published Fig. 4b beam.
   Save stage status, settings, runtime build, field metrics, and data
   checksums beside the numerical comparison.

## 6. Completeness checklist

- [x] Physical boundary intent, SI units and numerical approximation
- [x] Python, IR, planner and UI contract mapping
- [x] FDM CPU/CUDA realization and FEM limits
- [x] Reproducibility and verification design
- [x] Kernel regression in the CPU engine
- [ ] Cross-backend validation of the corrected full-grid result
- [x] Full-grid 3.2 ns CUDA replay with corrected build
- [ ] Published 24 ns beam comparison

(single-layer-dipolar-limitations)=
## 7. Deferred work

Qualify this realization in the larger Fig. 5 and 6 domains after
the Fig. 4b regression is verified. Multi-layer and general 3D
truncated-image realizations require a separate geometry audit.

(single-layer-dipolar-scientific-bibliography)=
## 8. References

- [Periodic boundary conditions](0600-periodic-boundary-conditions.md)
- [Gruszecki et al., Scientific Reports 6, 22367](https://doi.org/10.1038/srep22367)

(0601-single-layer-dipolar-images-source-code-index)=
## Source-code index

| Repository path | Symbol | Role |
| --- | --- | --- |
| crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs | compute_single_layer_mixed_newell_kernels | Fold the requested finite replica range into the mixed-boundary tensor. |
| crates/fullmag-fdm-demag/src/newell.rs | point_dipole_pair_tensor | Evaluate the distant equal-cell tensor with its point-dipole limit. |
| crates/fullmag-engine/src/fdm/cpu/fft.rs | one_layer_periodic_images_preserve_demag_tensor_at_long_lags | Check the distant diagonal and off-diagonal tensor terms. |
| packages/fullmag-py/src/fullmag/model/problem.py | class FdmPbc | Normalize axes and author the finite truncated image count. |
| crates/fullmag-ir/src/execution.rs | resolve_periodic_images | Resolve explicit/default replica counts for the solver. |
