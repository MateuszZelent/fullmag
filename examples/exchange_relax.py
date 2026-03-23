import fullmag as fm


def build() -> fm.Problem:
    geom = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")
    mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    body = fm.Ferromagnet(
        name="strip",
        geometry=geom,
        material=mat,
        m0=fm.init.uniform((1.0, 0.2, 0.0)),
    )
    return fm.Problem(
        name="exchange_relax",
        magnets=[body],
        energy=[fm.Exchange()],
        dynamics=fm.LLG(integrator="heun", fixed_timestep=1e-13),
        outputs=[
            fm.SaveField("m", every=1e-12),
            fm.SaveField("H_ex", every=1e-12),
            fm.SaveScalar("E_ex", every=1e-12),
        ],
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 2e-9)),
            fem=fm.FEM(order=1, hmax=2e-9),
        ),
    )


problem = build()
