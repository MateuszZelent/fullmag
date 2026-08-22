---
title: Thin-Film Tetrahedral Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-thin-film-tetrahedral)=
# Thin-Film Tetrahedral Mesh

The thin-film tetrahedral route preserves a tetrahedral volume topology while applying
thickness-aware sizing and geometry handling.

It is appropriate when a layered prism route is unavailable or when arbitrary in-plane geometry
must remain tetrahedral. It does not promise exact layer planes or a prescribed number of
through-thickness elements unless the realized report proves them.

Convergence must vary the thickness resolution independently from the in-plane target.
