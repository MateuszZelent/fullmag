---
title: Thin-Film Tetrahedral API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-thin-film-tetrahedral)=
# Thin-Film Tetrahedral API

Request a thickness-aware tetrahedral object through the thin-film helper with tetrahedral topology
or through `mesh_strategy="thin_film_tetrahedral"` in an advanced recipe.

This mode keeps tetrahedral elements. `layers` acts as a thickness-resolution request only where the
realized route supports it; inspect the report rather than assuming exact node planes.
