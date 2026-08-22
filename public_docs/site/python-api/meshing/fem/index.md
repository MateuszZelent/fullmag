---
title: FEM Meshing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-root)=
# FEM meshing

FEM authoring is split into study defaults, magnetic-object meshes, airbox mesh, and the
materialization/report lifecycle.

```{toctree}
:maxdepth: 3

study-defaults
ferromagnet/index
airbox/index
build-and-reports
```

## Complete stage-first example

```python
# %% FEM shared-domain mesh with separate body and airbox controls
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_meshing")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1.2e-6, 600 * nm, 550 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.mesh.thin_film(
    minimum_element_size=3 * nm,
    maximum_element_size=5 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

`study.build_domain_mesh()` materializes the current geometry and mesh-policy revisions. A later
edit invalidates that realization and requires another build.
