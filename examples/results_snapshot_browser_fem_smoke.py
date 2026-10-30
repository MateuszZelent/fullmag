"""Small real run for Results folder, autosave and historical/live UI checks.

The default exercises the serial FEM CPU lane. This is
an application workflow fixture, not a numerical qualification benchmark.
"""

import os

import fullmag as fm


backend = os.environ.get("FULLMAG_RESULTS_BACKEND", "fem")
if backend not in {"fdm", "fem"}:
    raise ValueError("FULLMAG_RESULTS_BACKEND must be fdm or fem")

fm.reset()
study = fm.study("results_snapshot_browser_" + backend)
# Managed DEV mounts: results on the user-data bind, private run scratch on state.
study.storage(
    output_dir=os.environ.get("FULLMAG_RESULTS_OUTPUT_DIR", "/user-data/results-browser-" + backend),
    temp_dir=os.environ.get("FULLMAG_RESULTS_TEMP_DIR", "/state/results-browser-scratch"),
    data_format="zarr",
    cleanup="never",
)
study.engine(backend)
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(64e-9, 64e-9, 32e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
if backend == "fdm":
    study.cell(4e-9, 4e-9, 4e-9)
else:
    study.universe.mesh(maximum_element_size=8e-9)

body = study.geometry(fm.Box(size=(32e-9, 32e-9, 8e-9), name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.05
body.m = fm.texture.vortex()
if backend == "fem":
    body.mesh(maximum_element_size=8e-9, order=1)
    study.build_domain_mesh()

study.disable_exchange()
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 0.02)
study.solver(integrator="rk4", dt=1e-12, g=2.0)
study.stages.add_run(stage_id="propagate", until=1e-10).autosave(
    fm.StageAutosave(
        target="results_browser",
        layout="continuous",
        format="zarr",
        table=fm.TableAutosave(
            t_sampl=2e-11,
            quantities=("time", "step", "mx", "my", "mz", "E_total"),
        ),
        # Native FEM autosave currently supports vector snapshots; scalar energy
        # remains covered by the table above. See the Results runtime audit.
        fields=(
            fm.FieldAutosave("m", every=2e-11),
            fm.FieldAutosave("H_eff", every=2e-11),
        ),
    )
)
