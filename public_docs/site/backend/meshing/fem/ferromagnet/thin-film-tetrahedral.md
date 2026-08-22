---
title: Thin-Film Tetrahedral Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-thin-film-tetrahedral)=
# Thin-film tetrahedral mesh

The thin-film tetrahedral route adds thickness-aware size and topology intent while retaining
unstructured tetrahedra. It is appropriate when a strict prism sweep is unavailable or unnecessary,
but the film thickness still requires explicit resolution.

The backend must report:

- resolved thin axis and physical thickness;
- requested and realized element count across thickness;
- minimum altitude and aspect-ratio distribution;
- surface and volume conformity;
- transition to surrounding tetrahedral air;
- actual method and any fallback from a more structured request.

A small nominal `hmax` does not guarantee multiple useful thickness layers. Layer-plane sampling and
through-thickness field convergence must be checked directly, especially for surface anisotropy,
DMI, standing thickness modes, asymmetric drives, and dynamic demagnetization.
