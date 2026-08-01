"""Managed FEM smoke for native shared-domain mesh persistence and reuse."""

from pathlib import Path
import json
import os

import fullmag as fm


artifact_path = Path(
    os.environ.get(
        "FULLMAG_MESH_ARTIFACT",
        ".fullmag/reports/fem-mesh-persistence-smoke/domain.fullmag-mesh",
    )
)
interchange_source = os.environ.get("FULLMAG_MESH_INTERCHANGE_SOURCE")

study = fm.study("fem_mesh_persistence_smoke")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(48e-9, 40e-9, 24e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=16e-9)

body = study.geometry(fm.Box(32e-9, 24e-9, 8e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
body.mesh(maximum_element_size=8e-9, order=1)

mesh_result = (
    study.mesh.import_(Path(interchange_source))
    if interchange_source
    else study.mesh.save_or_load(artifact_path)
)
print(
    "FULLMAG_MESH_PERSISTENCE_RESULT="
    + json.dumps(
        {
            "action": mesh_result.action,
            "authoring_fingerprint": mesh_result.authoring_fingerprint,
            "topology_fingerprint": mesh_result.topology_fingerprint,
        },
        sort_keys=True,
    )
)

study.demag(enabled=False)
study.b_ext(0.0, 0.0, 0.01)
study.solver(dt=1e-14)
study.relax(algorithm="llg_overdamped", max_steps=1, tolA=1e-30, dt=1e-14)
