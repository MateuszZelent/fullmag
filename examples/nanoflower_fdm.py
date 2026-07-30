"""Imported STL nanoflower executed with the study-root scripting API.

Study-root scripting API — compatible with the emerging model builder.
    fullmag examples/nanoflower_fdm.py
"""

import fullmag as fm

study = fm.study("nanoflower")

# ── Engine ──────────────────────────────────────────────────
study.engine("fem")
study.device("cuda:0", precision="double")
study.interactive(True)
study.universe(
    mode="auto",
    size=(400e-9, 400e-9, 20e-9),
    center=(0.0, 0.0, 0.0),
)

# ── Geometry & Material ─────────────────────────────────────
# ── Geometry & Material ─────────────────────────────────────
FLOWER_SPAN_X = 329.98683166503906e-9
FLOWER_GAP_X = 5e-9
FLOWER_PITCH_X = FLOWER_SPAN_X + FLOWER_GAP_X
FLOWER_OFFSET_X = 0.5 * FLOWER_PITCH_X

def add_nanoflower(name: str, offset_x: float, seed: int):
    flower = fm.geometry(
        fm.ImportedGeometry(
            source="/home/kkingstoun/git/fullmag/fullmag/examples/bowl_3_cprt.stl",
            units="nm",
            name=name,
        ).translate((offset_x, 0.0, 0.0)),
        name=name,
    )
    flower.Ms = 752e3       # saturation magnetisation [A/m]
    flower.Aex = 15.5e-12   # exchange stiffness [J/m]
    flower.alpha = 0.1      # Gilbert damping
    flower.m = fm.texture.random(seed=seed)
    flower.mesh(maximum_element_size=20e-9, order=1).build()
    return flower


flower_left = add_nanoflower("nanoflower_left", 0, seed=1)
# flower_right = add_nanoflower("nanoflower_right", FLOWER_OFFSET_X, seed=2)



study.b_ext(0.1, theta=0, phi=0)  # 0.1 T along +z
# ── Solver ──────────────────────────────────────────────────
# study.solver(dt=1e-15, g=2.115)
study.solver(max_error=1e-6, integrator="rk45", g=2.115)

# ── Outputs ─────────────────────────────────────────────────
# study.save("m", every=1e-13)
study.tableautosave(1e-13)

# ── Stages ──────────────────────────────────────────────────
study.wait_for_solve(True)
study.stages.add_relax(
    tolA=1e-6,                       # torque tolerance (max_dm_dt)
    max_steps=100_000,               # limit kroków
    algorithm="llg_overdamped",     # algorytm relaksacji
)
study.stages.add_run(1e-9)
