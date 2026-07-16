# Conformal OCC Degenerate Topology Design

## Problem

The conformal OCC meshing path accepts a partially degenerate mesh by deleting
the degenerate tetrahedra after Gmsh has generated boundary faces and physical
markers. Deleting an isolated tetrahedron changes the volume topology and
creates up to four new exterior faces. Those faces have no Gmsh physical
surface and therefore no boundary marker. `MeshIR` correctly rejects the
result as an incomplete magnetic boundary, magnetic-air interface, or airbox
outer boundary.

The failure is reproducible with
`examples/permalloy_layer_cofeb_rings_relax_300nm.py`. The managed run reports
degenerate-tetra cleanup immediately before groups of unmarked faces belonging
to the removed tetrahedra.

## Decision

Conformal OCC meshes are atomic topology products. If strict validation finds
any degenerate tetrahedron, the whole Gmsh attempt is rejected and the existing
algorithm retry sequence is used. A partially valid conformal mesh must never
be made acceptable by deleting selected tetrahedra.

The generic `_drop_degenerate_tetrahedra` helper remains available for mesh
paths that explicitly filter a volume and rebuild their retained boundary
subset. Only the conformal OCC acceptance loop stops calling it.

## Alternatives Rejected

- Assigning markers to the new faces would certify artificial holes as physical
  boundaries.
- Relaxing the strict volume threshold would pass numerically singular cells to
  MFEM.
- Changing only the example's Gmsh algorithm would hide the pipeline defect and
  leave other thin geometries vulnerable.

## Verification

- A partial-degeneracy regression must fail before the change because cleanup
  is called, then pass after the change with HXT followed by Delaunay.
- The existing test that expects cleanup without retry must be changed to the
  topology-preserving retry contract.
- The focused meshing tests must pass.
- The managed GPU probe must reach runtime selection without incomplete-boundary
  errors or degenerate-tetra cleanup. If the host CUDA driver cannot run the
  bundled runtime, the matching managed CPU recipe must complete the full stage.
