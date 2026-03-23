import fullmag as fm


def build() -> fm.Problem:
    geometry = fm.Box(size=(200e-9, 20e-9, 5e-9), name="track")
    material = fm.Material(
        name="Py",
        Ms=800e3,
        A=13e-12,
        alpha=0.01,
        Ku1=0.5e6,
        anisU=(0.0, 0.0, 1.0),
    )
    track = fm.Ferromagnet(
        name="track",
        geometry=geometry,
        material=material,
        m0=fm.init.uniform((1.0, 0.0, 0.0)),
    )

    return fm.Problem(
        name="dw_track",
        magnets=[track],
        energy=[
            fm.Exchange(),
            fm.Demag(),
            fm.InterfacialDMI(D=3e-3),
            fm.Zeeman(B=(0.0, 0.0, 0.1)),
        ],
        dynamics=fm.LLG(),
        outputs=[
            fm.SaveField("m", every=10e-12),
            fm.SaveScalar("E_total", every=10e-12),
        ],
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 1e-9)),
            fem=fm.FEM(order=1, hmax=2e-9),
            hybrid=fm.Hybrid(demag="fft_aux_grid"),
        ),
    )


problem = build()
