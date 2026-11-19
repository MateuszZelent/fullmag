"""Single-grid FDM CPP STT with a sinusoid gated in physical time."""

# %% Setup
import fullmag as fm

size = (8e-9, 4e-9, 1e-9)
turn_on = 10e-12
study = fm.study("fdm_stt_time_expression")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("extended")
study.universe(mode="manual", size=size)
study.cell(2e-9, 2e-9, 1e-9)

# %% Film and spin torque
film = study.geometry(fm.Box(size=size), name="film")
film.Ms = 5e5
film.Aex = 15e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.disable_demag()
study.spin_torque(
    fm.SlonczewskiSTT(
        current_density=(0, 0, -2.6e10),
        spin_polarization=(0, 1, 0),
        free_layer_thickness_m=size[2],
        id="stt",
        target=fm.RegionRef("film"),
        stack_normal=(0, 0, -1),
        time_expression=fm.TimeExpression(
            "heaviside(t-on) * sin(2*pi*f*(t-on))",
            constants={"f": 4e9, "on": turn_on},
            event_times_s=(turn_on,),
        ),
    )
)

# %% Time evolution and observations
study.solver(integrator="rk45", dt=1e-12)
study.stages.tableautosave(5e-12, quantities=("t", "mx", "my", "mz"))
study.stages.add_run(1e-9)
