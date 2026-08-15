# FDM: multilayer demagnetizing-field convolution

> Status: canonical physics and numerical specification for the current `master`.
> CPU FP64 has an active kernel catalog and shared workspace for the descriptor
> runtime. This is an executable implementation with local oracle tests, not a
> qualification of the complete module: shifted, heterogeneous, transfer, and
> GPU lanes remain limited to the evidence scope described below.

(problem-statement)=
## Physical problem

For $L$ disjoint ferromagnetic FDM objects, the pair $(d,s)$ denotes the target
and source, respectively. The sole convention is
$\boldsymbol\delta_{d,s}=\mathbf o_d-\mathbf o_s$ and
$\mathbf H_d=-\sum_s\mathsf N_{d\leftarrow s}\mathbf M_s$. It must not depend
and it must not depend on layer order or on the sign of the offset. The method
uses separate native and scratch grids while preserving the magnetostatic
physics. The qualified boundary mode is `open`; PBC is fail-closed.

(governing-equations)=
## Governing equations

The continuous model is used only to define the field:
$\mathbf H(\mathbf r)=-\int\mathcal N(\mathbf r-\mathbf r')\mathbf M(\mathbf r')\,\mathrm dV'$.
The primary FDM contract is the discrete sum in Eq. (3) of the paper, PDF page 2:

```{math}
:label: eq-lepadatu-3-discrete-fdm
\mathbf H'_{k,l}=-\sum_{i=1}^{L}\sum_{\mathbf r_{i,j}\in V_i}
\mathsf N(\mathbf r'_{k,l}-\mathbf r_{i,j},\mathbf h_k,\mathbf h_i)
\mathbf M(\mathbf r_{i,j}),\qquad \mathbf r'_{k,l}\in V_k .
```

```{math}
:label: eq-multilayer-demag-field
\mathbf H_d(\mathbf r_d)=-\sum_{s=1}^{L}\int_{V_s}
\mathcal N_{d\leftarrow s}(\mathbf r_d-\mathbf r_s)\mathbf M_s(\mathbf r_s)\,\mathrm dV_s .
```

```{math}
:label: eq-multilayer-reciprocity
V_d\,\mathsf N_{d\leftarrow s}(\mathbf r)
=V_s\,\mathsf N_{s\leftarrow d}^{\mathsf T}(-\mathbf r).
```

```{math}
:label: eq-multilayer-energy
E_d=-\frac{\mu_0}{2}\sum_{c\in\mathcal A_d}V_c\,
\mathbf M_{d,c}\mathbin\cdot\mathbf H_{d,c}.
```

```{math}
:label: eq-multilayer-transfer-adjoint
\langle P\mathbf M,\mathbf H_c\rangle_{V_{\mathrm{scratch}}}
=\langle\mathbf M,P^*\mathbf H_c\rangle_{V_n}.
```

For a scratch cell $q$, native cell $i$, active mask $a_i\in\{0,1\}$,
and overlap volume $\omega_{qi}$, the CPU FP64 transfer is the
moment-density map

```{math}
:label: eq-multilayer-transfer-moment-density
(P\mathbf M)_q=\frac{1}{V_{\mathrm{scratch},q}}
\sum_i a_i\omega_{qi}\mathbf M_i,
\qquad
(P^*\mathbf H_c)_i=\frac{a_i}{V_{n,i}}
\sum_q\omega_{qi}\mathbf H_{c,q}.
```

The sum is not renormalized by active or covered volume. Therefore a partially
covered scratch cell carries the exact represented magnetic moment, and an
inactive native cell contributes and receives exactly zero. When the scratch
extent covers only part of a native cell, the operator represents exactly that
intersection and its pull remains the volume adjoint of the same map.

The cell represented by a pair kernel has dimensions $\mathbf h^K_l$. In
`three_d`, $\mathbf h^K_l$ is the layer scratch spacing. In `two_d_stack`, it is
$(h_{\mathrm{scratch},x},h_{\mathrm{scratch},y},h_{n,z})$: the transform has one
computational Z sample, while the kernel retains the physical native layer
thickness. Before the forward transform, the stored scratch moment density is
converted to the magnetization density represented by that kernel cell:

```{math}
:label: eq-multilayer-kernel-density
\mathbf M^K_{l,q}=\frac{V_{\mathrm{scratch},l}}{V^K_l}
(P_l\mathbf M_l)_q,
\qquad V^K_l=\prod_{\alpha\in\{x,y,z\}}h^K_{l,\alpha}.
```

The complete oriented contribution is consequently

```{math}
:label: eq-multilayer-composed-push-kernel-pull
\mathbf H^n_{d\leftarrow s}
=P_d^*\left[-\mathsf N_{d\leftarrow s}
(\mathbf h^K_d,\mathbf h^K_s)\mathbf M^K_s\right].
```

For one native cell of volume $V_n$ fully contained in one scratch cell,
$P\mathbf M=(V_n/V_{\mathrm{scratch}})\mathbf M$. In `two_d_stack`,
$V^K=V_n$ when the XY cells coincide, so Eq. {eq}`eq-multilayer-kernel-density`
restores the native magnetization density exactly and $P^*$ returns the direct
cell-average field without a second $V_{\mathrm{scratch}}/V_n$ factor.

The tensor has six independent components,
$N_{xx},N_{yy},N_{zz},N_{xy},N_{xz},N_{yz}$. Reciprocity is always
volume-weighted; direct tensor equality is valid only for equal cell volumes.
Cross-energy reports the oriented $d\leftarrow s$ contributions and the
physically symmetrized sum, not an unweighted $\mathbf M\mathbin\cdot\mathbf H$.

The continuous equation above explains the field, but the implemented FDM
contract is a cell sum. Following Eq. (3) of Lepadatu (2019),
$\mathbf H_{k,l}'=-\sum_{i=1}^{L}\sum_{\mathbf r_{i,j}\in V_i}
\mathsf N(\mathbf r_{k,l}'-\mathbf r_{i,j},\mathbf h_k,\mathbf h_i)
\mathbf M(\mathbf r_{i,j})$. The source and target dimensions are part of the
kernel. The matrix $\mathsf N$ has six independent components:
$\mathsf N=[N_{xx},N_{xy},N_{xz};N_{xy},N_{yy},N_{yz};N_{xz},N_{yz},N_{zz}]$.

```{math}
:label: eq-lepadatu-4-transfer
\mathbf M(\mathbf r')=\sum_{i\in P}w_i\mathbf M(\mathbf r_i).
```

```{math}
:label: eq-lepadatu-5-weights
w_i=\frac{\widetilde d_i\delta_i}{\widetilde d_T},\quad
\widetilde d_T=\sum_{i\in P}\widetilde d_i\delta_i,\quad
\widetilde d_i=\frac{\lvert\mathbf h'+\mathbf h\rvert}{2}-\lvert\mathbf r'-\mathbf r_i\rvert .
```

Equations (4)--(5) of the paper define a weighted-average transfer: for a
scratch point $\mathbf r'$ and input cells $c_i$,
$\mathbf M(\mathbf r')=\sum_i w_i\mathbf M(\mathbf r_i)$,
$w_i=\widetilde d_i\delta_i/\sum_j\widetilde d_j\delta_j$,
$\widetilde d_i=\lvert(\mathbf h'+\mathbf h)/2\rvert-\lvert\mathbf r'-\mathbf r_i\rvert$,
where $\delta_i$ selects overlapping cells. Fullmag uses the overlap geometry
but specializes the discrete weights to Eqs.
{eq}`eq-multilayer-transfer-moment-density`--{eq}`eq-multilayer-kernel-density`
so that partial cells retain moment and the pull remains the volume adjoint.
`VolumeWeightedTransfer` owns $P$ and $P^*$; the active CPU runtime owns the
conversion from scratch volume to the physical source-cell volume represented
by each pair kernel. This composed unequal-thickness contract is checked
against an independent GL8 cell-to-continuum oracle; the source transfer,
kernel, and pull are not used to construct the expected result.

Appendix A of the paper, pages 6--7 of the PDF, defines irregular Newell:

```{math}
:label: eq-lepadatu-a1
N_{xx}(\mathbf s)=L[f;\mathbf h_s,\mathbf h_d](\mathbf s),\qquad
N_{xy}(\mathbf s)=L[g;\mathbf h_s,\mathbf h_d](\mathbf s).
```

```{math}
:label: eq-lepadatu-a2
L[w;\mathbf h_s,\mathbf h_d](\mathbf s)=\frac{1}{\tau}
\sum_{\epsilon_1,\epsilon_2=-1}^{1}(-1)^{|\epsilon_1|+|\epsilon_2|}
\bigl[-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-h_{s,z})
-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z+h_{d,z})
+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z)
+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-\Delta)\bigr].
```

```{math}
:label: eq-lepadatu-a3
R^2=x^2+y^2+z^2,\quad \tau=\pi h_xh_yh_{d,z},\quad\Delta=h_{s,z}-h_{d,z},
\qquad f=\frac{(2x^2-y^2-z^2)R}{6}
+\frac{y(z^2-x^2)}{4}\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)
+\frac{z(y^2-x^2)}{4}\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right)
-xyz\arctan\!\frac{yz}{xR}.
```

```{math}
:label: eq-lepadatu-a4
g=-\frac{xyR}{3}-\frac{z^3}{6}\arctan\!\frac{xy}{zR}
-\frac{zy^2}{2}\arctan\!\frac{xz}{yR}
-\frac{zx^2}{2}\arctan\!\frac{yz}{xR}
+\frac{y(3z^2-y^2)}{12}\ln\!\left(1+\frac{2x(x+R)}{y^2+z^2}\right)
+\frac{x(3z^2-x^2)}{12}\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)
+\frac{xyz}{2}\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right),
\qquad\mathbf h_s=(h_x,h_y,h_{s,z}),\quad\mathbf h_d=(h_x,h_y,h_{d,z}).
```

These are the literal Appendix A forms from pages 6--7 of the local PDF; axis
permutations provide the remaining tensor components following Newell et al.
(1993).

(symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf H$ | magnetostatic field in the continuous model | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_d$ | target demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H'_{k,l}$ | discrete field at target cell $(k,l)$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{d,c}$ | demagnetizing field at active target cell $c$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_c$ | field on the convolution grid | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H^n_{d\leftarrow s}$ | native destination field contributed by source layer $s$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M_s$ | source magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M$ | cell magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M_{d,c}$ | magnetization of active target cell $c$ | $\mathrm{A\,m^{-1}}$ |
| $\mathsf N_{d\leftarrow s}$ | discrete demagnetizing tensor | $1$ |
| $\mathsf N$ | pair-cell demagnetizing tensor from Eq. (3) | $1$ |
| $\mathcal N$ | continuous magnetostatic kernel | $\mathrm{m^{-3}}$ |
| $\mathcal N_{d\leftarrow s}$ | continuous kernel directed from source $s$ to target $d$ | $\mathrm{m^{-3}}$ |
| $\mathbf r_d$ | target-cell center | $\mathrm m$ |
| $\mathbf r_s$ | source-cell center | $\mathrm m$ |
| $\mathbf r$ | displacement vector in reciprocity | $\mathrm m$ |
| $\mathbf r'_{k,l}$ | target-cell position in Eq. (3) | $\mathrm m$ |
| $\mathbf r_{i,j}$ | source-cell position in Eq. (3) | $\mathrm m$ |
| $V_i$ | volume of source domain $i$ | $\mathrm{m^3}$ |
| $V_d$ | target-cell volume | $\mathrm{m^3}$ |
| $V_s$ | source-cell volume | $\mathrm{m^3}$ |
| $V_c$ | active-cell volume | $\mathrm{m^3}$ |
| $V_n$ | native-grid cell volume | $\mathrm{m^3}$ |
| $V_{n,i}$ | native-grid cell-$i$ volume | $\mathrm{m^3}$ |
| $V_{\mathrm{scratch}}$ | scratch-cell volume in the transfer inner product | $\mathrm{m^3}$ |
| $V_{\mathrm{scratch},q}$ | scratch-cell-$q$ volume | $\mathrm{m^3}$ |
| $V_{\mathrm{scratch},l}$ | layer-$l$ scratch-cell volume | $\mathrm{m^3}$ |
| $V^K_l$ | physical source-cell volume represented by layer-$l$ pair kernels | $\mathrm{m^3}$ |
| $\mathrm dV'$ | source volume element | $\mathrm{m^3}$ |
| $\mathrm dV_s$ | volume element in source $s$ | $\mathrm{m^3}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $E_d$ | target demagnetizing energy | $\mathrm J$ |
| $\mathbf h_k$ | target-cell size in Eq. (3) | $\mathrm m$ |
| $\mathbf h_i$ | source-cell size in Eq. (3) | $\mathrm m$ |
| $\mathbf h_s$ | source-cell size in Appendix A | $\mathrm m$ |
| $\mathbf h_d$ | target-cell size in Appendix A | $\mathrm m$ |
| $\mathbf h'$ | transfer-cell size | $\mathrm m$ |
| $\mathbf h$ | input transfer-grid cell size | $\mathrm m$ |
| $\mathbf h^K_l$ | physical cell dimensions represented by layer-$l$ pair kernels | $\mathrm m$ |
| $h_x$ | cell size along x in Appendix A | $\mathrm m$ |
| $h_y$ | cell size along y in Appendix A | $\mathrm m$ |
| $h_{s,z}$ | source-cell thickness | $\mathrm m$ |
| $h_{d,z}$ | target-cell thickness | $\mathrm m$ |
| $\mathbf r_i$ | transfer-cell center | $\mathrm m$ |
| $\mathbf r'$ | transfer point | $\mathrm m$ |
| $P$ | native-to-scratch transfer | $1$ |
| $P^*$ | scratch-to-native adjoint transfer | $1$ |
| $\mathbf M^K_{l,q}$ | layer-$l$ kernel-cell magnetization density at scratch cell $q$ | $\mathrm{A\,m^{-1}}$ |
| $\omega_{qi}$ | overlap volume of scratch cell $q$ and native cell $i$ | $\mathrm{m^3}$ |
| $a_i$ | active-mask value for native cell $i$ | $1$ |
| $q$ | scratch-cell index | $1$ |
| $\mathcal A_d$ | active target cells | $1$ |
| $w_i$ | transfer weight | $1$ |
| $\delta_i$ | cell-overlap indicator | $1$ |
| $\widetilde d_i$ | weighted transfer distance | $\mathrm m$ |
| $\widetilde d_T$ | sum of weighted distances | $\mathrm m$ |
| $L$ | Newell eight-corner operator | $1$ |
| $f$ | diagonal Newell basis function | $\mathrm{m^3}$ |
| $g$ | off-diagonal Newell basis function | $\mathrm{m^3}$ |
| $\mathbf s=(x,y,z)$ | Appendix A argument vector | $\mathrm m$ |
| $x$ | x coordinate in Appendix A | $\mathrm m$ |
| $y$ | y coordinate in Appendix A | $\mathrm m$ |
| $z$ | z coordinate in Appendix A | $\mathrm m$ |
| $R$ | $\sqrt{x^2+y^2+z^2}$ | $\mathrm m$ |
| $\tau$ | stencil normalization | $\mathrm{m^3}$ |
| $\Delta$ | source/target thickness difference | $\mathrm m$ |
| $\epsilon_1,\epsilon_2$ | stencil indices | $1$ |
| $\epsilon_1$ | x/y corner index | $1$ |
| $\epsilon_2$ | x/y corner index | $1$ |
| $N_{xx}$ | diagonal xx component | $1$ |
| $N_{xy}$ | off-diagonal xy component | $1$ |
| $N_{dd}$ | target diagonal component in Table I | $1$ |
| $N_{xz}$ | off-diagonal xz component in Table I | $1$ |
| $N_{yz}$ | off-diagonal yz component in Table I | $1$ |
| $w$ | Newell basis function in Appendix A | $\mathrm{m^3}$ |
| $k,l,i,j,V_i$ | target/source cell indices and source domain in Eq. (3) | $1$ |

(assumptions-and-validity)=
## Assumptions and validity limits

Each layer has a `native_grid`, `scratch_grid`, origin, and $h_z$.
`common_transform_layout` describes only the FFT shape, strides, padding, and
transform convention, not a physical grid. For each linear axis,
$n_{\mathrm{linear}}=n_{\mathrm{source}}+n_{\mathrm{destination}}-1$; `fft_shape`
must not be smaller. The descriptor contains the source insertion offset,
lag-zero, negative-lag map, destination crop window, R2C along X of length
$N_x/2+1$, x-fastest indexing, inverse normalization, and padding zeroing.

`two_d_stack` has one working Z cell per layer. The current planner does not
perform an automatic moment-preserving average through a multi-cell Z layer:
a layer with more than one native Z cell must use `three_d`, otherwise the plan
is rejected. Appendix A for unequal thicknesses requires common $h_x,h_y$ for
the pair; other XY geometries require transfer to a common scratch XY grid or
rejection. Reuse of $+\Delta z/-\Delta z$ is legal only for `two_d_stack`, a pure
Z shift, and an oriented pair with equal $h$; the descriptor test explicitly
rejects reuse for unequal heights.

Lepadatu Table I distinguishes 2D-self, 3D-self, 2D-zShift, 3D-zShift, and
2D/3D-full: self uses real kernels and reduced storage; 2D-zShift has real
diagonal and $xy$ components and imaginary $xz,yz$ components in reduced
storage; 3D-zShift and full are complex, with full requiring full storage. The
table is a representation target; current Fullmag has no runtime evidence for
this reduction yet. Appendix A, Eqs. (A1)--(A4), defines irregular Newell for
$\mathbf h_s=(h_x,h_y,h_{s,z})$ and $\mathbf h_d=(h_x,h_y,h_{d,z})$, hence
with a Z difference only. The checked pair builder in
`crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel_pair`
uses this contract and has an independent GL8 comparison and inverse-FFT test
in
`crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs`. This is executable
mathematical evidence, not production qualification: the active CPU runner
uses this path for unequal 2D thicknesses, while complete per-layer
transfer/crop, CUDA, and fresh runtime artifacts remain open gates.

The exact pair FFT layout has source insertion offset $a_s$, lag-zero
$z_{d,s}$, and target crop $C_d$. A coefficient at lag $q$ is stored at
$K[(q+z_{d,s})\bmod F]$, magnetization is stored at
$M[(i+a_s)\bmod F]$, and the target result is read from $H[C_d(l)]$. The
forward transform is not normalized; the inverse multiplies by
$1/\prod_\alpha F_\alpha$ exactly once.
These are required descriptor formulas; descriptor tests cover wrap-around,
nonzero crops, and rejection of an incompatible linear extent.

(supercell-and-test-examples)=
## Computational supercell and test examples

The supercell is not a “larger material mesh”. It is only a rectangular FFT
workspace to which each layer contributes its own native grid through
`identity` or `push_pull`. The minimal descriptor test builds a pair with shapes
`[3,2,1]` and `[5,4,1]`. The linear extent is then
$[3+5-1,\,2+4-1,\,1+1-1]=[7,5,1]$; the test uses FFT padding `[16,8,1]`,
source insertion offset `[1,0,0]`, and a target crop beginning at `[1,1,0]`.
`CommonTransformLayout::is_physical_mesh()` returns `false`. This proves
indexing and layout isolation, not magnetic-field correctness.

The matrix below maps the real tests in the current tree. All listed tests were
run on this revision before the documentation update.

| Case | Test and data | Result | What it proves / does not prove |
|---|---|---|---|
| Supercell layout | `crates/fullmag-fdm-demag/tests/descriptors.rs::common_layout_is_computational_and_preserves_linear_extent`; `[3,2,1]`, `[5,4,1]`, extent `[7,5,1]` | `ok` | offset, lag-zero, crop, padding, and `physical_mesh=false`; no field proof |
| Unequal $h_z$, 2-D | `irregular_shifted_kernel.rs::unequal_2d_layer_thickness_matches_cubature_for_both_signed_z_offsets`; $h_s=[0.7,0.9,0.6]$, $h_d=[0.7,0.9,1.4]$, offset $[0.35,-0.27,3.2]$ | `ok`, GL8 for XY lags `[1,-1,0]` and `[-1,1,0]` at positive $z$ | six pair-kernel components; no composed `push_pull` or CUDA proof |
| Orientation $+z/-z$ | `irregular_shifted_kernel.rs::unequal_2d_pair_keeps_xy_parity_for_positive_and_negative_z_offsets`; offsets $z=+2.3$ and $z=-2.3$ | `ok`, parity of all six components | independent sign/orientation evidence; does not replace cubature for every $z$ or runtime proof |
| Unequal $h_z$ after FFT | `irregular_shifted_kernel.rs::fft_pair_inverse_matches_independent_cubature_for_unequal_2d_pair` | `ok` | inverse FFT and normalization preserve the tensor; no complete LLG-step proof |
| Unequal 3-D cells | `irregular_shifted_kernel.rs::unequal_3d_cell_pair_matches_cubature_and_volume_weighted_reciprocity` | `ok` | cubature and $V_dN_{d\leftarrow s}=V_sN_{s\leftarrow d}^{T}$; no production 3-D qualification |
| Rejected unequal XY | `irregular_shifted_kernel.rs::three_d_unequal_inplane_spacing_fails_closed_in_translational_kernel_builder` | `ok`, `UnsupportedGeometry` error | no silent interpretation of one translational kernel; does not preclude planner `push_pull` |
| Reuse and workspace | `crates/fullmag-engine/src/multilayer.rs`: `regular_stack_materializes_five_unique_kernels_for_nine_ordered_pairs`, `irregular_stack_does_not_reuse_oriented_kernel_entries`, `runtime_telemetry_counts_actual_fft_pairs_and_cold_to_warm_workspace` | `ok` | full-key reuse catalog and workspace reuse; no CUDA residency proof |
| Transfer moment/adjoint | `crates/fullmag-fdm-demag/src/transfer.rs`: `volume_weighted_transfer_preserves_2d_moment_through_z_average`, `volume_weighted_transfer_is_adjoint_with_active_mask`; `crates/fullmag-engine/tests/multilayer_unequal_transfer.rs` | `ok` | full-scratch-volume moment density, exact volume adjoint, active-mask zeroing, and composed unequal-thickness CPU fields against independent GL8; no CUDA or production proof |

The kernel-module test recipe is intentionally explicit:

```bash
cargo test -p fullmag-fdm-demag --test descriptors --test irregular_shifted_kernel --test shifted_newell_oracle
cargo test -p fullmag-engine --test multilayer_unequal_transfer
cargo test -p fullmag-engine multilayer --lib
cargo test -p fullmag-plan multilayer --lib
cargo test -p fullmag-runner multilayer --lib
```

The reference result for this update is respectively `19`, `7`, `7`, `3`,
`16`, `38`, and `24` completed tests, while the transfer filter reports `4/4`;
the workspace benchmark remains `ignored` as a manual microbenchmark. These
are CPU/Rust contract proofs, not a source-bound production artifact or
CUDA-device proof.

(boris-gap-matrix)=
## BORIS comparison and gap matrix

The matrix below separates physical compatibility from interface compatibility.
The local BORIS reference sources are `external_solvers/BORIS/Boris/SDemag.h`,
`SDemag.cpp`, `SDemag_MConv.cpp`, `SDemag_Demag.cpp`,
`BorisLib/VEC_MeshTransfer.h`, and `Simulation.cpp` (commands
`multiconvolution`, `2dmulticonvolution`, `ncommon`). An absent Fullmag
counterpart is an intentional gap, not an alias under another name.

| BORIS contract | BORIS behavior | Fullmag state | Boundary and required evidence |
|---|---|---|---|
| `multiconvolution=true` | Separate FFT spaces and `Rect_collection` for every mesh/layer; transfer to and from a common scratch grid. | `strategy="multilayer_convolution"`; each layer keeps a native/scratch descriptor, while CPU FP64 builds `kernel_catalog` and `pair_bindings` and uses one workspace per refresh. | This is the BORIS catalog counterpart in a bounded CPU path. Full per-layer insertion/crop, transfer, and energy for all centers/extents and separate CUDA qualification are still required. |
| `multiconvolution=false` | One convolution on a supermesh; every supermesh cell must be empty or belong entirely to one input mesh. | Multi-magnet `strategy="single_grid"` is fail-closed and therefore is not a BORIS supermesh counterpart. | Supermesh implementation/qualification is absent; UI and docs must not present `single_grid` as a substitute. |
| `2dmulticonvolution=0` | Automatic mode: 3D is allowed when geometry requires it. | Closest to `mode="three_d"`/`auto`; translational FFT requires common pitch on sampled axes. | A full 3D cross-layer oracle for XYZ offsets and a runtime report are required. |
| `2dmulticonvolution=1` | Treat every mesh as an independent 2D mesh, even with its own Z discretization. | `two_d_stack` is legal only when every layer has exactly one native Z cell; CPU has a descriptor catalog and workspace for this subset. | This is not full BORIS `=1`: BORIS reduces arbitrary Z discretization, while Fullmag rejects multi-cell Z fail-closed. |
| `2dmulticonvolution=2` | Split every mesh into 2D layers along Z; every layer participates in layered convolution. | No implementation or Python/IR/UI fields. | This is a separate functional gap, not an alias for `two_d_stack`; layer decomposition, transfer, and tests must be defined. |
| `ncommonstatus=false` | BORIS chooses `n_common` from the largest mesh dimensions (for 2D, `n_common.z=1`). | No status flag; omitting `common_cells*` invokes planner-auto policy based on the scratch union and native Z. | Semantics are not one-to-one; provenance must record auto-policy and the resolved grid, and docs must not call it BORIS's largest-mesh default. |
| `ncommon=(nx,ny,nz)` | The user forces a common cell count; `nz=1` is part of BORIS 2D policy. | `common_cells=(nx,ny,nz)` or `common_cells_xy=(nx,ny)`; `nz=1` does not legally reduce a layer with multiple native Z cells. | Validate common scratch, origin, and insertion/crop boundaries; CUDA with transfer remains fail-closed. |
| Common-cell pitch | BORIS computes `h_common = convolution_rect / n_common` and uses the maximum cell for transfer-dimension normalization. | Fullmag treats common-cell size, native-cell size, and transform layout as separate descriptor fields; transfer or rejection is explicit, and different geometry never silently changes the native grid. | A separate pitch/volume and tolerance proof is needed for each cell-size class; equal `n_common` alone does not prove equal cells. |
| Different XY extents/centers | `Rect_collection` expands and aligns rectangles to the maximum common size while attempting to preserve common XY projections. | The planner materializes the XY union and `push_pull`; runtime validates insertion offset, lag-zero, and destination crop, and the catalog binds each kernel to its exact layout. | CPU has a fail-closed contract and layout tests, but full extent/center coverage and GPU require fresh runtime artifacts. |
| Different Z thicknesses | In 2D the XY cell size is common but `h_z` may differ; the kernel has independent `h_src`, `h_dst`. | Checked `compute_shifted_kernel_pair` plus Appendix-A Newell; the active CPU runner handles unequal `h_z` in `two_d_stack`. | GL8, inverse FFT, and focused CPU tests pass; production-qualified runtime/CUDA is absent. |
| M/H transfer | Weighted average to scratch and transfer of the result back; `VEC_MeshTransfer` provides coverage/weighting. | CPU `push_pull` stores moment density over the full scratch cell, converts it to the pair-kernel source volume before FFT, and applies the exact volume adjoint on pull. | Independent GL8 covers the bounded one-cell unequal-thickness composition; broader extents, CUDA, and production artifacts remain separate gates. |
| Full XYZ offset | Pair kernels use target minus source positions; BORIS is not limited to a `z_shift`. | The pair API accepts a full center-to-center offset; the runner converts lower-corner origins to cell centers. | For different 3D pitches, translational FFT is rejected; the direct tensor is the oracle. |
| Kernel reuse and parity | BORIS has a kernel-module catalog, identical-pair reuse, and controlled ±Z symmetries. | CPU runtime has `kernel_catalog` (one tensor per unique `KernelReuseKey`) and `pair_bindings`; the key includes mode, oriented offset, both cell sizes, volumes, transform/padding/crop, representation, precision, scheme, and boundary. Telemetry reports hits/misses, pair and FFT counts, and cold/warm memory. | The catalog/workspace implementation is complete for the CPU descriptor path, but does not yet qualify every BORIS family (reduced/full, X/Y/XYZ shift) or CUDA. Any fingerprint change must invalidate reuse. |
| Storage/symmetry | BORIS distinguishes real/reduced and full-complex storage; 2D zShift has specific real/imag components. | `TensorDemagKernel` stores six full complex components; the reduced-storage fast path is not runtime-qualified. | Reduction, sign reconstruction, and memory tests are needed separately for CPU/CUDA. |
| CPU/GPU | BORIS has FFTW CPU and CUDA realizations of the same method. | CPU FP64 is the reference; CUDA has ABI guards and authoring/IR support, but no fresh managed parity. FP32 is also not qualified. | Do not claim executable GPU support without a device artifact, parity, and FFT telemetry. |
| PBC images | `demag_pbc_images` and `Set_PBC` apply the same number of PBC images to all meshes in the supermesh and multilayer convolution. | Fullmag supports only `open` boundaries; the planner rejects PBC for multilayer and the UI has no silent fallback. | PBC is a complete functional gap: explicit Python/IR fields, kernel images, energy, provenance, and separate CPU/CUDA qualification are required. |
| Empty cells and energy | BORIS tracks `non_empty_cells` and `total_nonempty_volume`, normalizes energy by non-empty volume, and supports masks and mesh exclusion. | Fullmag preserves an active mask on each native layer, computes volume-weighted energy, and publishes target-only Airbox `H_demag`; solver masks and visual full-domain fields are separate. | Maintain separate mask, volume, and energy evidence for each transfer class; source tests do not replace a fresh runtime artifact. |
| Antiferromagnetic and atomistic meshes | BORIS tracks `antiferromagnetic_meshes_present`, separate modules, and forced transfer for atomistic meshes. | The public Fullmag multilayer contract covers named ferromagnetic FDM objects; it has no AFM, atomistic-mesh, or transfer-to-common-scratch semantics. | This is an explicit product-scope gap, not an allowed fallback. It would require a separate material model, mask, transfer, energy, and qualification. |
| Reconfiguration and invalidation | BORIS `UpdateConfiguration_MConv_Demag` destroys and recreates modules after mesh, `n_common`, mode, or PBC changes. | Fullmag resolves a new plan per topology fingerprint; CPU runtime keeps fingerprint invalidation for the catalog/workspace and rejects incompatible geometry. | End-to-end session evidence for dynamic reconfiguration and post-replan parity is still missing; the fingerprint alone is not that evidence. |
| Mesh/UI/observation | BORIS operates on input meshes and transfers; the supermesh is not a physical layer. | Explorer/Inspector exposes native layers; `CommonTransformLayout` has `physical_mesh=false`; Airbox `H_demag` is target-only. | Scratch must not be rendered as ferromagnetic geometry; a fresh viewport/WebGL matrix is required after integration. |

Conclusion: current Fullmag implements and tests part of the BORIS-style
multilayer convolution mathematics, and CPU already has an active per-layer
reuse catalog and shared workspace. It does not provide the complete BORIS
set: supermesh, full `2dmulticonvolution=1/2` semantics, PBC images, all
reduced/full representations, dynamic reconfiguration with session evidence,
and qualified CUDA are missing. These are implementation requirements, not
optional enhancements.

| Table I class | Condition | $N_{dd}$: x/y/z | $N_{xy}$: x/y/z | $N_{xz}$: x/y/z | $N_{yz}$: x/y/z | DFT/storage |
|---|---|---|---|---|---|---|
| 2D-self | one Z cell | even/even/n.a. | odd/odd/n.a. | zero | zero | real/reduced |
| 3D-self | $\mathbf h_i=\mathbf h_j$ | even/even/even | odd/odd/even | odd/even/odd | even/odd/odd | real/reduced |
| 2D-zShift | $h_{x,y,i}=h_{x,y,j}$ | even/even/n.a. | odd/odd/n.a. | odd/even/n.a. | even/odd/n.a. | dd,xy real; xz,yz imaginary; reduced |
| 3D-zShift | $\mathbf h_i=\mathbf h_j$ | even/even/even | odd/odd/even | odd/even/odd | even/odd/odd | complex/reduced |
| 2D-full | $h_{x,y,i}=h_{x,y,j}$ | none/none/n.a. | none/none/n.a. | none/none/n.a. | none/none/n.a. | complex/full |
| 3D-full | $\mathbf h_i=\mathbf h_j$ | none/none/none | none/none/none | none/none/none | none/none/none | complex/full |

(python-api)=
## Public Python API

The canonical physics-first authoring contract uses the same mesh facades as
FEM while retaining FDM-specific Cartesian cell semantics:

| Parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR | Qualification |
|---|---|---|---|---|---|---|---|---|
| `body.mesh.cell_size` | `Sequence[float] | None` | `None` | $\\mathrm m$ | exactly three finite positive values; mutually exclusive with FEM element-size and Gmsh controls | exact Cartesian native-cell size $(h_x,h_y,h_z)$ for one magnetic object | FDM CPU/GPU authoring; runtime lane gated | `backend_policy.discretization_hints.fdm.per_magnet.<object>.cell` | implemented and Python-tested |
| `study.objects.mesh.defaults.cell_size` | `Sequence[float] | None` | `None` | $\\mathrm m$ | exactly three finite positive values; an object value overrides it | default native-cell size for FDM objects | FDM CPU/GPU authoring; runtime lane gated | `backend_policy.discretization_hints.fdm.default_cell` | implemented and Python-tested |
| `study.universe.mesh.cell_size` | `Sequence[float] | None` | `None` | $\\mathrm m$ | exactly three finite positive values; each common-domain extent must be an integer multiple; required for unequal native grids | cell size of the non-physical common convolution domain | FDM multilayer CPU/GPU authoring; runtime lane gated | `backend_policy.discretization_hints.fdm.demag.common_cell_size` | implemented; planner, API, and CPU reference tested |
| `study.universe.mesh.minimum_element_size` | `float | None` | `None` | $\\mathrm m$ | finite positive and no greater than the maximum; mutually exclusive with `cell_size` | lower element-size target for the FEM airbox mesh | FEM CPU/GPU | `problem_meta.runtime_metadata.study_universe.airbox_hmin` | existing FEM contract; unchanged |
| `study.universe.mesh.maximum_element_size` | `float | None` | `None` | $\\mathrm m$ | finite positive and no smaller than the minimum; mutually exclusive with `cell_size` | upper element-size target for the FEM airbox mesh | FEM CPU/GPU | `problem_meta.runtime_metadata.study_universe.airbox_hmax` | existing FEM contract; unchanged |
| `study.demag.enabled` | `bool` | `True` | $1$ | boolean | physical demagnetization request; planner selects the realization | FDM and FEM CPU/GPU subject to lane qualification | `terms.demag.enabled` plus planner-selected realization | implemented; automatic strategy selection tested |

The approved heterogeneous-grid example is:

```python
# %% Imports and study
import fullmag as fm

nm = 1e-9
study = fm.study("heterogeneous_fdm_layers")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% Geometry and material
bottom = study.geometry(
    fm.Box(size=(100 * nm, 50 * nm, 10 * nm)),
    name="layer_bottom",
)
top = study.geometry(
    fm.Box(size=(100 * nm, 50 * nm, 10 * nm)).translate((0, 0, 20 * nm)),
    name="layer_top",
)
permalloy = fm.Material(Ms=800e3, A=13e-12)
bottom.material(permalloy)
top.material(permalloy)

# %% Native meshes and common computational domain
bottom.mesh(cell_size=(2 * nm, 2 * nm, 10 * nm))
top.mesh(cell_size=(5 * nm, 5 * nm, 10 * nm))
study.universe.mesh(cell_size=(2 * nm, 2 * nm, 2.5 * nm))

# %% Physics and stage
study.demag()
study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    max_steps=10,
    dt=1e-13,
)
```

The corresponding FEM mesh controls remain unchanged:

```python
study.engine("fem")
study.universe.mesh(
    minimum_element_size=1 * nm,
    maximum_element_size=5 * nm,
)
```

The FDM block above passes executable lowering and round-trip tests. CPU FP64 also has a scoped
heterogeneous transfer execution test; this does not qualify CUDA. The classes in
the following table document the current compatibility representation. They
remain migration adapters but are not canonical tutorial syntax.

| Parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR | Qualification |
|---|---|---|---|---|---|---|---|
| FDM.cell | Sequence[float] or None | None | $\mathrm m$ | exclusive with default_cell; three positive values when present | legacy/default native cell size | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.cell | implemented authoring |
| FDM.default_cell | Sequence[float] or None | None | $\mathrm m$ | three positive values when present; needed when per_magnet is incomplete and for the current common-scratch policy | default native cell size | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.default_cell | implemented authoring |
| FDM.per_magnet | dict[str, FDMGrid] or None | None | $1$ | non-empty names and FDMGrid values | per-object native grid overrides | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.per_magnet | implemented authoring |
| FDM.demag | FDMDemag or None | None | $1$ | no explicit type check in FDM.__init__; a valid FDMDemag is required during lowering | demagnetization policy wrapper | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.demag | implemented authoring |
| FDM.boundary_correction | str or None | None | $1$ | Python accepts none, volume, full; multilayer accepts exactly None or none and rejects volume/full before layer construction | sub-cell boundary-correction tier | FDM single-grid authoring; multilayer neutral intent only | backend_policy.discretization_hints.fdm.boundary_correction | authoring implemented; multilayer containment source-tested only |
| FDM.boundary_phi_floor | float or None | None | $1$ | Python requires $0<\phi_{\min}<1$; multilayer requires None and rejects every explicit value, including direct-IR 0.0 | minimum volume fraction for boundary correction | FDM single-grid authoring; unsupported for multilayer | backend_policy.discretization_hints.fdm.boundary_phi_floor | authoring implemented; multilayer containment source-tested only |
| FDM.boundary_delta_min | float or None | None | $\mathrm m$ | Python requires $\delta_{\min}\geq0$; multilayer requires None and rejects every explicit value, including 0.0 | minimum intersection distance for T1 stability | FDM single-grid authoring; unsupported for multilayer | backend_policy.discretization_hints.fdm.boundary_delta_min | authoring implemented; multilayer containment source-tested only |
| FDMGrid.cell | Sequence[float] | required | $\mathrm m$ | three positive values | native cell size | FDM CPU/GPU | backend_policy.discretization_hints.fdm.per_magnet.*.cell | implemented authoring |
| FDMDemag.strategy | Literal[str] | auto | $1$ | auto, single_grid, multilayer_convolution | requested demag realization | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.strategy | implemented; multilayer runtime gated |
| FDMDemag.mode | Literal[str] | auto | $1$ | auto, two_d_stack, three_d | requested multilayer mode | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.mode | implemented; runtime not qualified |
| FDMDemag.common_cells | tuple[int, int, int] or None | None | $1$ | three positive ints | explicit 3D working cell count | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.common_cells | implemented; runtime not qualified |
| FDMDemag.common_cells_xy | tuple[int, int] or None | None | $1$ | two positive ints | explicit 2D working XY count | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.common_cells_xy | implemented; runtime not qualified |
| FDMDemag.explain | bool | True | $1$ | raw script builder requires bool; constructor does not type-check it | planner explanation request | FDM CPU/GPU authoring | not serialized by FDMDemag.to_ir | implemented authoring |
| FDMDemag.allow_single_grid_fallback | bool or None | None | $1$ | every non-None value raises ValueError | removed compatibility input; silent fallback is forbidden | unsupported | not serialized |

The parameters `FDM.boundary_correction`, `FDM.boundary_phi_floor`, and
`FDM.boundary_delta_min` are publicly lowered into FDM hints. Because
`FdmMultilayerPlanIR` has no fields that preserve this intent, the planner
accepts exactly `boundary_correction` equal to `None` or `none` with both tuning
parameters equal to `None` before constructing layers. It rejects `volume`/`full`
and every explicit `boundary_phi_floor` or `boundary_delta_min`, including
`0.0`. The same rule applies to explicit `strategy=multilayer_convolution` for
a single layer. This is planner-containment evidence only; it is not runtime or
device execution proof.

```python
# %% Imports
import fullmag as fm

# %% Discretization intent
grid = fm.FDMGrid(cell=(3.90625e-9, 3.90625e-9, 3.0e-9))
demag = fm.FDMDemag(strategy="multilayer_convolution", mode="two_d_stack", common_cells_xy=(128, 32))

# %% Lowering check
assert grid.to_ir()["cell"][2] == 3.0e-9
assert demag.to_ir()["strategy"] == "multilayer_convolution"
```

The public stage builder registers per-object/common mesh intent, an independent
`study.demag(enabled=True)` term, outputs, a solver, and stages. `to_ir()` alone
proves authoring only. Multilayer relaxation is currently legal only for
`llg_overdamped`; direct PG-BB/NCG minimizers remain fail-closed.

(problem-ir)=
## ProblemIR and normalization

`FDMGrid.to_ir` lowers `cell` to an SI list. `FDMDemag.to_ir` lowers `strategy`,
`mode`, `common_cells`, and `common_cells_xy` into
`backend_policy.discretization_hints.fdm.demag`. The planner materializes
`FdmMultilayerPlanIR`, `FdmLayerPlanIR`, and `FdmMultilayerSummaryIR` with the
requested and selected strategies, eligibility, and kernel estimate.
`FDM.to_ir` also preserves the three public boundary parameters in FDM hints,
but the multilayer planner does not materialize them in
`FdmMultilayerPlanIR`: it admits only the neutral combination and rejects the
others before constructing `FdmLayerPlanIR`.

(round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the intent expressed by `strategy`, `mode`, and the common
grid. Resolved execution is a planner decision recorded separately in
`planner_summary` and runtime provenance. Validation errors reject illegal
counts, overlapping layers, incompatible $h_x,h_y$ without a possible transfer
to common scratch, PBC, and missing transfer. Different XY extents/centers are
preserved as native geometries and materialized through a union computational
scratch and `push_pull`; they are not automatically rejected or rendered as a
single physical supermesh. Unsupported combinations must not silently fall back
to `single_grid` or another precision. Explicit `multilayer_convolution` with a
single layer receives the same boundary validation: `None`/`none` without
tunings passes, while `volume`/`full` and every explicit `phi_floor`/`delta_min`
end planning with an error.

(discrete-realization)=
## Backend realizations

| Solver | Device | Status | Evidence status |
|---|---|---|---|
| FDM | CPU | reference_executable | exact 2D Newell; fresh full oracles for L=1/L=2 identity, a separate CPU `push_pull` equal plus small unequal-transfer case, and target-only Airbox convergence; the general 3D/heterogeneous production path remains gated |
| FDM | GPU | implemented; executable contract partial; runtime-verified no; physically-validated no; production-qualified no | CUDA exists, but the current managed gate is `not_qualified`; the assisted heterogeneous operator must fail closed or be unified with the CPU descriptor path |
| FEM | CPU | not-applicable | this note covers FDM FFT/Newell, not FEM magnetostatics |
| FEM | GPU | not-applicable | this note covers FDM FFT/Newell, not FEM magnetostatics |

CPU FP64 is the reference execution lane, not an independent oracle for kernel
mathematics. In 2D lanes (`n_z=1`), production `newell.rs` computes the volume
integral through a stable 64-corner sum for every lag; in general 3D, distant
pairs may still use the explicitly bounded point-dipole asymptotic branch. The
independent verifier has its own Newell/GL8 implementation and canonicalizes lag
signs through tensor parity, so it does not compare unstable, separately
computed negative lags. Full field and energy coverage has been run for the
verified L=1/L=2 identity cases. A small heterogeneous `push_pull` case checks
both layer orientations and all magnetization axes against an independent GL8
cell-to-continuum oracle, plus volume reciprocity and the cross-energy
derivative. Every destination spectrum is zeroed, sources are accumulated,
then inverse FFT and the volume-adjoint pull return the field to the native
grid.
Runtime keeps a catalog of unique tensors and ordered pair bindings; FFT
workspace, scratch lines, and convolution buffers are allocated once and reused
between refreshes. Telemetry distinguishes cold/warm bytes, hits/misses, FFT and
pair counts, and fingerprint invalidation, but `residency=host` is not proof of
CUDA device residency.
`VolumeWeightedTransfer::push_m_into` stores the exact active moment divided by
the full scratch-cell volume; `pull_h_adjoint_into` implements $P^*$. The CPU
refresh multiplies the pushed density by
$V_{\mathrm{scratch}}/V^K$ before the FFT so that an unequal-thickness 2D pair
kernel receives the magnetization density of its physical source cell. If any
native cell is clipped by the scratch extent, only the same geometric
intersection participates in both push and pull.

(implementation-mapping)=
## Implementation mapping

`compute_newell_kernels` and `compute_newell_kernels_shifted` build the exact 2D
corner tensor and the explicitly bounded shifted 3D tensor;
`accumulate_tensor_convolution` performs the spectral multiplication; and
`negate_field` applies the conventional field sign. Active multilayer transfers
are `VolumeWeightedTransfer::push_m_into` and
`VolumeWeightedTransfer::pull_h_adjoint_into`; the kernel-density conversion is
owned by `compute_demag_fields_checked`, and the planner is
`plan_fdm_multilayer`. Before constructing layers, the planner checks that
`boundary_correction` is omitted or equal to `none` and that both tunings are
omitted; non-neutral intent stops planning because `FdmMultilayerPlanIR` cannot
preserve it. `build_kernel_catalog` deduplicates kernels by the full
`KernelReuseKey`, `pair_bindings` preserve the $d\leftarrow s$ orientation, and
`compute_demag_fields_checked` runs forward/pair/inverse with one shared
workspace and length guards. This is not a proof of mathematical completeness:
the direct high-precision/cubature oracle must remain owned by a separate test
component independent of the production builder.

(validation)=
## Validation plan

Small asymmetric cases compare independent GL8 cubature for all six components.
A separate parity test covers both signs of the Z offset and the orientation of
the XY/XZ/YZ components. `descriptors.rs` checks the linear extent, crop,
padding, source offset, negative-lag mapping, identity-mask behavior, transfer
contract, and reuse boundaries. `irregular_shifted_kernel.rs` checks unequal
$h_z$, full XYZ offsets, XY parity, inverse FFT, volume reciprocity, and
fail-closed behavior for unequal XY. `shifted_newell_oracle.rs` keeps cubature
separate from the production builder and also checks the asymptotic signed
far-field branch.

Transfer has dedicated source tests: `volume_weighted_transfer_preserves_2d_moment_through_z_average`
checks full-scratch-volume density and its volume-weighted moment, while
`volume_weighted_transfer_is_adjoint_with_active_mask` checks the volume-adjoint
identity and zeroing of inactive cells.
`crates/fullmag-engine/tests/multilayer_unequal_transfer.rs` independently
integrates rectangular source and destination cells with GL8 cubature. It
checks both unequal-thickness orientations, all three magnetization axes,
volume-weighted reciprocity, the cross-energy derivative, partial scratch-cell
moment preservation, and inactive-cell zeroing. This is scoped executable CPU
evidence, not a managed production or CUDA artifact.

The Python scenarios in
`tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/` are real
authoring and lowering fixtures. `scenario_l3_identity_3d_small.py` has
$L=3$, `mode="three_d"`, `common_cells=(8,4,2)`, and `identity` transfer;
`scenario_unequal_small.py` uses $3\,\mathrm{nm}$ and $6\,\mathrm{nm}$ layers
with `common_cells=(16,8,2)`; `scenario_l3_heterogeneous_small.py` uses native
Z counts $1/2/1$ and requires composed `push_pull`. `test_runtime.py` confirms
the exact ProblemIR for these scenarios and the target-only Airbox distinction.
These fixtures alone do not prove fields, energies, or runtime qualification.

The `sp4-derived-multilayer` scenarios cover $L=1$, bilayer, three-layer,
equal and unequal thicknesses, and `identity`/`push_pull`; they are not the
canonical µMAG Standard Problem 4. CPU target-only Airbox convergence has a
separate fresh result for `160×40×18` and `160×40×24` meshes with
`115200/115200` common centers; this does not replace device qualification or
the complete visualization matrix. A paper-reproduction lane must separately
reproduce the published geometry: a Ni80Fe20 trilayer of
$640\times320\,\mathrm{nm^2}$, thicknesses $20/10/20\,\mathrm{nm}$, and a
$1\,\mathrm{nm}$ gap under a $20\,\mathrm{kA\,m^{-1}}$ field at $5^\circ$,
followed by Co skyrmion disks of diameter $512\,\mathrm{nm}$, thickness
$1\,\mathrm{nm}$, and spacer $3\,\mathrm{nm}$. This lane provides traceability,
not a replacement for the oracle or SP4 qualification. The Airbox is a
target-only observation carrier: the first promotion publishes $H_{demag}$;
$H_{eff}$ outside the magnetic domain has a versioned unavailable reason. CPU
FP64, CUDA FP64, and CUDA FP32 require separate runtime, device, and tolerance
artifacts.

The planner tests `multilayer_planner_accepts_exactly_neutral_boundary_intent`
and `multilayer_planner_rejects_every_non_neutral_boundary_intent` cover neutral
`None`/`none`, `volume`/`full`, explicit zero and positive tunings, and explicit
single-layer `multilayer_convolution`. They are source-level fail-closed
contracts, not runtime or device proof.

(limitations)=
## Limitations

Not production-promoted: supermesh, PBC, full `2dmulticonvolution=1/2`
semantics, general XY offsets (authoring/planning has a union-scratch plus
`push_pull` path, but no complete transfer/insertion/crop proof), the full
3D/heterogeneous production path, reduced/full storage classes, dynamic session
reconfiguration, device-resident parity, CUDA/D-07, and FP32. CPU target-only
Airbox convergence is qualified only for the two-mesh scope described above. A
source test, build, or screenshot is not evidence of physical or production
qualification.

(scientific-bibliography)=
## Scientific bibliography

1. S. Lepadatu, Efficient computation of demagnetizing fields for magnetic
   multilayers using multilayered convolution, Journal of Applied Physics
   **126**, 103903 (2019),
   [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
2. A. J. Newell, W. Williams, and D. J. Dunlop, A generalization of the
   demagnetizing tensor for nonuniform magnetization, Journal of Geophysical
   Research: Solid Earth **98**, 9551--9555 (1993),
   [doi:10.1029/93JE01171](https://doi.org/10.1029/93JE01171).
3. A. Aharoni, Demagnetizing factors for rectangular ferromagnetic prisms,
   Journal of Applied Physics **83**, 3432 (1998),
   [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).

The only BORIS snapshot used for traceability is the manifest
`multilayer_convolution/boris-reference-manifest.v1.json`. It is not a source of
qualification, a numerical oracle, or a license to copy code.

(source-code-index)=
## Source-code index

The `Immutable link` column points to a source snapshot or deliberately records
the absence of a fresh runtime artifact. Naming a symbol alone does not raise
the qualification status.

| Claim | Path | Symbol | Responsibility | Lane | Tests | Evidence status | Immutable link |
|---|---|---|---|---|---|---|---|
| Canonical per-object mesh authoring | packages/fullmag-py/src/fullmag/world.py | class GeometryMeshHandle | validates and lowers `body.mesh(cell_size=...)` | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py | executable authoring and round-trip contract | current master source snapshot |
| Canonical common-domain authoring | packages/fullmag-py/src/fullmag/world.py | class StudyUniverseHandle | validates and lowers `study.universe.mesh(cell_size=...)` | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py | executable authoring, planner, and API contract | current master source snapshot |
| Requested common-cell provenance | crates/fullmag-ir/src/mesh_hints.rs | validate_requested_common_cell_size | validates the plan field that preserves authored cell size separately from resolved counts | FDM plan/provenance | crates/fullmag-plan/src/tests.rs::fdm_common_cell_size_resolves_heterogeneous_native_grids_without_rounding | executable requested/resolved contract | current master source snapshot |
| Multilayer layout resource | crates/fullmag-api/src/router_v2/handlers/data/domain.rs | fdm_multilayer_layout_resource | publishes requested common cell size and resolved FFT layout | HTTP v2 control plane | crates/fullmag-api/src/router_v2/tests.rs::fdm_multilayer_layout_exposes_common_and_native_layer_metadata | executable API resource contract | current master source snapshot |
| Python FDM wrapper | packages/fullmag-py/src/fullmag/model/discretization.py | class FDM | lowers the full public FDM wrapper | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py::test_two_object_two_d_policy_preserves_requested_auto_in_ir | executable authoring contract only | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Python demag intent | packages/fullmag-py/src/fullmag/model/discretization.py | class FDMDemag | validates and lowers requested demag policy | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py::test_auto_mode_preserves_common_cells_for_planner_resolution | executable authoring contract only | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Continuous kernel definition (theory only) | crates/fullmag-fdm-demag/src/newell.rs | newell_f | anchors the continuous Newell primitive; no discrete runtime ownership claim | theory/oracle boundary | crates/fullmag-fdm-demag/src/newell.rs::tests::nxy_absolute_values_match_reference | theoretical-only | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Appendix A g primitive (theory only) | crates/fullmag-fdm-demag/src/newell.rs | newell_g | anchors the off-diagonal Newell primitive; no unequal-cell production owner | theory/oracle boundary | crates/fullmag-fdm-demag/src/newell.rs::tests::nxy_absolute_values_match_reference | theoretical-only | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| CPU production Newell tensor | crates/fullmag-fdm-demag/src/newell.rs | compute_newell_kernels | exact 64-corner 2D lane with bounded 3D asymptotic branch | FDM CPU reference | crates/fullmag-fdm-demag/src/newell.rs::tests::two_d_corner_kernel_matches_independent_reference_at_near_and_far_lags | runtime-verified CPU FP64; not production-qualified | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Volume-weighted reciprocity oracle | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs | unequal_cell_cubature_obeys_nontrivial_volume_weighted_reciprocity | independent unequal-volume oracle; not production proof | FDM numerical oracle | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs::unequal_cell_cubature_obeys_nontrivial_volume_weighted_reciprocity | oracle-only | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Shifted tensor | crates/fullmag-fdm-demag/src/shifted_kernel.rs | compute_shifted_kernel | builds current shifted tensor spectrum | FDM CPU oracle input | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs::shifted_kernel_matches_independent_cubature_for_both_z_lag_directions | code/test only; not production-qualified | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Tensor product | crates/fullmag-fdm-demag/src/multiply.rs | accumulate_tensor_convolution | accumulates source into destination spectrum | FDM CPU oracle input | crates/fullmag-fdm-demag/src/multiply.rs::tests::diagonal_kernel_scales_components_independently | code/test only; not production-qualified | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Field sign | crates/fullmag-fdm-demag/src/multiply.rs | negate_field | applies the single demagnetizing minus sign to the accumulated destination spectrum before inverse FFT | FDM CPU oracle input | sign-convention source contract; independent end-to-end fixture still required | code/test only | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| CPU multilayer energy | crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs | observe_multilayer | reports current CPU demag energy | FDM CPU, current owner | crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::multilayer_reference_run_executes_two_layers | code/test only; no independent energy oracle | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| CUDA demag energy blocks | backends/fdm/gpu/cuda/runtime/reductions_fp64.cu | demag_energy_blocks_kernel | reduces FP64 demag-energy blocks | FDM CUDA FP64, current owner | planned managed CUDA energy parity | planned; no fresh managed device run | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| CUDA demag energy reduction | backends/fdm/gpu/cuda/runtime/reductions_fp64.cu | reduce_demag_energy_fp64 | launches and reduces FP64 demag energy | FDM CUDA FP64, current owner | planned managed CUDA energy parity | planned; no fresh managed device run | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Irregular Newell A1--A4 | crates/fullmag-fdm-demag/src/shifted_kernel.rs | compute_shifted_kernel_pair | current unequal-cell pair-kernel owner; `newell.rs::newell_g` remains the publication-formula anchor | FDM CPU kernel plus theory/oracle boundary | crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs | implemented and oracle-tested in scoped CPU cases; not production-qualified | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Transfer contract metadata | crates/fullmag-fdm-demag/src/descriptors.rs | volume_weighted_moment_preserving | declares full-scratch-volume moment density, exact volume adjoint, and active-mask preservation | FDM backend-neutral descriptor | crates/fullmag-fdm-demag/tests/descriptors.rs::transfer_contract_is_explicitly_volume_weighted_and_mask_preserving | executable descriptor contract; not production-qualified | current source snapshot |
| Push transfer | crates/fullmag-fdm-demag/src/transfer.rs | VolumeWeightedTransfer::push_m_into | stores active native moment as density over the full scratch cell | FDM CPU transfer | crates/fullmag-fdm-demag/src/transfer.rs::volume_weighted_transfer_preserves_2d_moment_through_z_average | volume moment and partial-scratch contract; not production-qualified | current source snapshot |
| Pull transfer | crates/fullmag-fdm-demag/src/transfer.rs | VolumeWeightedTransfer::pull_h_adjoint_into | applies the exact full-scratch/native-volume adjoint and inactive-mask zeroing | FDM CPU transfer | crates/fullmag-fdm-demag/src/transfer.rs::volume_weighted_transfer_is_adjoint_with_active_mask | volume-adjoint contract; not production-qualified | current source snapshot |
| Unequal transfer composition | crates/fullmag-engine/tests/multilayer_unequal_transfer.rs | unequal_two_d_push_pull_matches_direct_oracle_for_both_orientations_and_axes | independently checks push→kernel→pull for unequal layer thicknesses | FDM CPU FP64 | cargo test `multilayer_unequal_transfer` | scoped GL8 field, reciprocity, energy-derivative, partial-cell, and mask evidence; no CUDA or production artifact | current source snapshot |
| Planner | crates/fullmag-plan/src/fdm.rs | plan_fdm_multilayer | resolves public multilayer FDM plan | FDM planner | crates/fullmag-plan/src/tests.rs::multilayer_planner_resolves_common_grid_modes_without_overriding_explicit_mode | executable planner contract only | [master@762ca086b](https://github.com/MateuszZelent/fullmag/commit/762ca086b6085c842e28fab1c4a37a788f710fcf) |
| Planner | crates/fullmag-plan/src/fdm.rs | plan_fdm_multilayer | resolves public multilayer FDM plan and rejects non-neutral boundary intent before layer construction | FDM planner | crates/fullmag-plan/src/tests.rs::multilayer_planner_accepts_exactly_neutral_boundary_intent; crates/fullmag-plan/src/tests.rs::multilayer_planner_rejects_every_non_neutral_boundary_intent | executable fail-closed planner contract only; no runtime/device proof | [3fcf40d6d](https://github.com/MateuszZelent/fullmag/commit/3fcf40d6d8e2c2f106031ae99481539832014349) |
| CPU catalog and workspace | crates/fullmag-engine/src/multilayer.rs | build_kernel_catalog | deduplicates kernels and binds ordered layer pairs to one descriptor | FDM CPU FP64 | crates/fullmag-engine/src/multilayer.rs::runtime_telemetry_counts_actual_fft_pairs_and_cold_to_warm_workspace | runtime-verified CPU, not production-qualified | [dd25252ecd](https://github.com/MateuszZelent/fullmag/commit/dd25252ecd184fe60835e518ae0e466ed2fd2544) |
| CPU checked refresh | crates/fullmag-engine/src/multilayer.rs | compute_demag_fields_checked | validates native/scratch geometry and executes catalog/workspace refresh | FDM CPU FP64 | crates/fullmag-engine/src/multilayer.rs::identity_path_rejects_native_scratch_cell_count_mismatch_without_panicking | fail-closed contract; no managed production artifact | [dd25252ecd](https://github.com/MateuszZelent/fullmag/commit/dd25252ecd184fe60835e518ae0e466ed2fd2544) |
| Supercell descriptor test | crates/fullmag-fdm-demag/tests/descriptors.rs | common_layout_is_computational_and_preserves_linear_extent | proves `[3,2,1]` + `[5,4,1]` gives linear extent `[7,5,1]`, crop and `physical_mesh=false` | FDM descriptor | cargo test `descriptors` | executable contract; not field proof | current master source snapshot |
| Unequal-Z pair test | crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs | unequal_2d_layer_thickness_matches_cubature_for_both_signed_z_offsets | compares six pair components with independent GL8 cubature for asymmetric XY lags at a fixed Z offset | FDM CPU kernel | cargo test `irregular_shifted_kernel` | scoped physical oracle; not composed transfer/CUDA proof | current master source snapshot |
| Signed-Z orientation test | crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs | unequal_2d_pair_keeps_xy_parity_for_positive_and_negative_z_offsets | checks component parity for positive and negative Z offsets | FDM CPU kernel | cargo test `irregular_shifted_kernel` | scoped orientation contract; not a continuum/runtime qualification | current master source snapshot |
| Unequal-Z inverse FFT test | crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs | fft_pair_inverse_matches_independent_cubature_for_unequal_2d_pair | verifies inverse normalization and lag extraction after FFT | FDM CPU convolution | cargo test `irregular_shifted_kernel` | scoped physical oracle; not production-qualified | current master source snapshot |
| CPU catalog reuse | crates/fullmag-engine/src/multilayer.rs | regular_stack_materializes_five_unique_kernels_for_nine_ordered_pairs | demonstrates reuse is keyed by full descriptor and ordered pairs remain distinct | FDM CPU runtime | cargo test `fullmag-engine multilayer` | runtime contract; no device residency proof | current master source snapshot |
| Planner XY transfer | crates/fullmag-plan/src/tests.rs | multilayer_planner_materializes_xy_offset_in_common_scratch_transfer | proves distinct XY geometry is represented by explicit common scratch and transfer | FDM planner | cargo test `fullmag-plan multilayer` | executable planner contract | current master source snapshot |
| Stage-first L=3 fixture | tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/test_runtime.py | test_l3_identity_three_d_scenario_preserves_common_identity_grid | checks `mode=three_d`, `common_cells=(8,4,2)` and per-magnet native cells in ProblemIR | Python authoring | pytest multilayer fixture tests | authoring/lowering only; not field proof | current master source snapshot |
| Python fail-closed validation | packages/fullmag-py/tests/test_fdm_multilayer_contract.py | test_demag_rejects_incompatible_common_grid_combinations | rejects contradictory `common_cells`, `common_cells_xy` and mode combinations | Python authoring | pytest FDM contract tests | executable API contract | current master source snapshot |
| Transfer moment test | crates/fullmag-fdm-demag/src/transfer.rs | volume_weighted_transfer_preserves_2d_moment_through_z_average | verifies Z averaging preserves the volume-weighted moment | FDM CPU transfer | cargo test `fullmag-fdm-demag` | scoped transfer contract | current master source snapshot |
| Transfer adjoint test | crates/fullmag-fdm-demag/src/transfer.rs | volume_weighted_transfer_is_adjoint_with_active_mask | verifies volume adjointness and inactive-mask zeroing | FDM CPU transfer | cargo test `fullmag-fdm-demag` | scoped transfer contract | current master source snapshot |
