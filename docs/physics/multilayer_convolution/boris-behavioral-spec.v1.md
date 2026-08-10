# BORIS multilayer convolution behavioral specification

This file is a clean-room behavioral record of the local BORIS snapshot identified by
`boris-reference-manifest.v1.json`. It records observable responsibilities and invariants only;
it intentionally contains no BORIS source code, private type layout, or copied implementation.
The snapshot is traceability material, not a Fullmag numerical oracle or qualification receipt.

(boris-rect-collection)=
## BORIS rectangle collection

The demagnetization owner keeps one convolution rectangle per participating mesh and derives a
common scratch envelope from their extents and origins. The rectangle collection is computational
state; it is not a physical magnetic body.

(boris-common-n)=
## BORIS common convolution counts

The default common counts are resolved from the participating rectangle collection. The two-
dimensional policy forces one cell along Z when that mode is selected; the resolved counts are
distinct from each mesh's native cell size.

(boris-header-force-mode)=
## BORIS force-mode vocabulary

The public force-mode comments distinguish no forced 2-D convolution, treating every mesh as a
2-D mesh, and layering each mesh along Z. These are three BORIS policy values and must not be
collapsed into Fullmag's `two_d_stack` mode.

(boris-set-n-common)=
## BORIS explicit common counts

An explicit common-count setter replaces the automatically resolved transform counts. The choice
changes computational scratch layout and is separate from native mesh geometry.

(boris-convolution-rect)=
## BORIS convolution rectangle

The adjusted convolution rectangle is returned to the multilayer scratch modules after accounting
for the participating mesh extents. It is used for transform alignment, not for material support.

(boris-mconv-init)=
## BORIS multilayer initialization

Multilayer initialization creates one scratch/transform module per participating layer, records the
common convolution dimensions, and prepares the source-to-destination pair organization.

(boris-mconv-update)=
## BORIS multilayer update

An update transforms each source layer, accumulates ordered source-to-destination tensor products
in destination spectra, and performs one inverse transform per destination layer before the field
is returned to the participating meshes.

(boris-2d-mode)=
## BORIS 2-D multilayer mode

The 2-D mode switch is an explicit policy decision. It changes the permitted Z representation and
does not mean that a native multi-cell-Z layer can be silently collapsed without a transfer rule.

(boris-multilayer-toggle)=
## BORIS multilayer versus supermesh

The multilayer toggle selects independent layer convolution modules instead of a single supermesh
convolution. The two choices have different mesh ownership and transfer semantics.

(boris-kernel-catalog)=
## BORIS kernel catalog

The kernel catalog distinguishes self, shifted, and full-complex families for the supported 2-D and
3-D arrangements. A catalog entry represents a source-to-destination tensor class, not only a
scalar separation.

(boris-kernel-reuse)=
## BORIS kernel reuse

Before constructing a tensor, the catalog checks whether an equivalent source/destination cell
pair and relative shift already exists. Reuse is conditional on the complete kernel identity.

(boris-kernel-storage)=
## BORIS kernel storage metadata

Kernel metadata records the real/complex representation, shift class, source and destination cell
sizes, and transform dimensions. Storage representation is therefore part of the kernel identity.

(boris-kernel-multiply)=
## BORIS 2-D ordered multiplication

The 2-D multiplication path consumes all ordered source inputs for a destination and applies the
corresponding tensor components in spectral space. Self and cross contributions have distinct
accumulation behavior.

(boris-kernel-multiply-3d)=
## BORIS 3-D ordered multiplication

The 3-D multiplication path follows the same ordered source-to-destination accumulation contract
with the full three-dimensional tensor component set.

(boris-irregular-thickness)=
## BORIS irregular source and destination thickness

The irregular tensor family keeps source and destination Z thickness as separate inputs while
requiring a compatible common XY discretization. Unequal thickness is not represented by replacing
both values with one average.

(boris-weighted-transfer)=
## BORIS weighted mesh transfer

Mesh transfer uses explicit weights when moving magnetization into the common convolution grid and
returning the field. Transfer is part of the multilayer operator contract and affects field and
energy interpretation.

(boris-cuda-update)=
## BORIS CUDA multilayer update

The CUDA update mirrors the host decomposition: source transforms, ordered pair accumulation,
destination inverse transforms, and transfers are separate execution phases with device buffers.

(boris-cuda-init)=
## BORIS CUDA multilayer initialization

CUDA initialization prepares per-layer scratch data, transform dimensions, and device kernel state
for the multilayer update. It is a separate execution realization of the same behavioral stages,
not evidence that Fullmag's CUDA lane is qualified.
