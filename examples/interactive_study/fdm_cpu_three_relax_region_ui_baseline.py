"""S46 baseline: a region with no independent texture assignment before Relax B.

The browser profile adds the B-local regional reset through the Inspector.
Disabling B must leave C inheriting A without that reset. The independent-reset
comparison uses fdm_cpu_three_relax_region_reset.py, whose +Z assignment is a
separate script event and must still feed C when B is disabled.
"""

import fullmag as fm

study = fm.study("P22 three Relax stages")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(8e-9, 4e-9, 2e-9), center=(0, 0, 0), padding=(0, 0, 0))
study.cell(2e-9, 2e-9, 2e-9)
body = study.geometry(fm.Box(8e-9, 4e-9, 2e-9), name="film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.uniform(1, 0, 0)
left = body.add_region("left half", fm.Box(4e-9, 4e-9, 2e-9).translate((-2e-9, 0, 0)), region_id="left-half")
study.demag(enabled=False)
study.b_ext(0, 0.1, 0)
study.solver(dt=1e-13, g=2.115)
study.stages.add_relax(stage_id="relax-a", algorithm="llg_overdamped", max_steps=10, dt=1e-13, tolA=1e-4)
study.stages.add_relax(stage_id="relax-b", algorithm="projected_gradient_bb", max_steps=1, tolA=1e-4)
study.stages.add_relax(stage_id="relax-c", algorithm="nonlinear_cg", max_steps=1, tolA=1e-4)
