---
title: FDM Meshing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-root)=
# FDM meshing

FDM authoring defines cell-centred Cartesian grids. There is no Gmsh build step and no FEM airbox
mesh.

```{toctree}
:maxdepth: 2

grids
multilayer-convolution
boundary-corrections
```

## Complete stage-first example

```python
# %% FDM grid authoring
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_meshing")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 1 * nm))

film = study.geometry(fm.Box(200 * nm, 80 * nm, 1 * nm), name="film")
film.mesh(cell_size=(2 * nm, 2 * nm, 1 * nm))
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## Typed form

The lower-level constructor is:

```text
fm.FDM(
    cell=None,
    default_cell=None,
    per_magnet=None,
    demag=None,
    boundary_correction=None,
    boundary_phi_floor=None,
    boundary_delta_min=None,
)
```

At least one default or per-magnet cell specification is required. `cell` is the compatibility alias
for `default_cell`; supplying both is rejected.
