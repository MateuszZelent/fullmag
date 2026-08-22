---
title: Imported FEM Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-imported-mesh)=
# Imported FEM mesh

An imported mesh bypasses geometry generation, not semantic or numerical validation. The backend
must establish:

- coordinate units, dimension, and world-frame placement;
- supported element and boundary families and polynomial order;
- positive orientation and high-order Jacobians;
- magnetic, air, material, and boundary attributes;
- object/region ownership and magnetic-submesh extraction;
- periodic-pair compatibility where requested;
- consistency with authored geometry and material assignment;
- deterministic asset digest and source provenance.

A nonempty `FEM.mesh` or object `source` string is only an asset reference. Missing markers, unknown
units, incompatible topology, or unsupported element families are hard failures in strict mode.

Imported and generated meshes should produce the same report schema so downstream operators do not
depend on how the asset was obtained.
