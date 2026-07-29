---
title: Ferromagnet
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-ferromagnet)=
# Ferromagnet

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `Ferromagnet.name` | `str` | required | $1$ | Non-empty object identity. |
| `Ferromagnet.geometry` | `Geometry` | required | — | Geometry occupied by the magnetic body. |
| `Ferromagnet.material` | `Material` | required | — | Material supplying magnetic coefficients. |
| `Ferromagnet.region` | `Region \| None` | `None` | — | Optional named region; when absent, the geometry name becomes the magnet region. |
| `Ferromagnet.m0` | `InitialMagnetization \| None` | `None` | $1$ | Initial reduced magnetization. |
| `Ferromagnet.mesh` | `PerObjectMeshRecipe \| None` | `None` | — | Optional object-local mesh recipe. |
| `Ferromagnet.object_regions` | tuple | `()` | — | Authored object-local regions lowered into `object_regions`; names and ownership are validated. |
| `Ferromagnet.allocated_region_ids` | tuple of strings | `()` | $1$ | Reserved region identities used by builder and round-trip ownership. |
| `Ferromagnet.material_parameter_fields` | tuple | `()` | — | Object-owned spatial material assignments lowered into `material_parameter_fields`. |
