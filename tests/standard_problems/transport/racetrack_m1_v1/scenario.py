"""Public solved-current skyrmion racetrack workload ``racetrack_m1_v1``.

This is the canonical positive-current member of the frozen workload.  It
authors charge, direct SHE, steady spin accumulation and transport torque; it
does not contain prescribed SOT/STT or an Oersted term.
"""

from __future__ import annotations

import fullmag as fm


TRACK_LENGTH = 512.0e-9
TRACK_WIDTH = 128.0e-9
HM_THICKNESS = 3.0e-9
FM_THICKNESS = 1.0e-9
CELL = (2.0e-9, 2.0e-9, 1.0e-9)
CURRENT_DENSITY = 1.0e12
OUTPUT_PERIOD = 5.0e-12
DEFAULT_UNTIL = 2.0e-9


def _surface(object_id: str, face: str, normal: tuple[float, float, float]) -> fm.SurfaceRef:
    return fm.SurfaceRef(object_id, face, normal)


def build() -> fm.Problem:
    fm_geometry = fm.Box(
        size=(TRACK_LENGTH, TRACK_WIDTH, FM_THICKNESS),
        name="fm_base",
    ).translate((TRACK_LENGTH / 2.0, TRACK_WIDTH / 2.0, HM_THICKNESS + FM_THICKNESS / 2.0))
    fm_geometry = fm.Translate(fm_geometry.geometry, fm_geometry.offset, name="fm")
    hm_geometry = fm.Box(
        size=(TRACK_LENGTH, TRACK_WIDTH, HM_THICKNESS),
        name="hm_base",
    ).translate((TRACK_LENGTH / 2.0, TRACK_WIDTH / 2.0, HM_THICKNESS / 2.0))
    hm_geometry = fm.Translate(hm_geometry.geometry, hm_geometry.offset, name="hm")

    material = fm.Material(
        name="fm_material",
        Ms=5.8e5,
        A=1.5e-11,
        alpha=0.3,
        Ku1=8.0e5,
        anisU=(0.0, 0.0, 1.0),
    )
    seed = (
        fm.texture.neel_skyrmion(
            radius=30.0e-9,
            wall_width=5.0e-9,
            chirality=1,
            core_polarity=1,
        )
        .with_mapping(space="world", projection="object_local")
        .translate(TRACK_LENGTH / 2.0, TRACK_WIDTH / 2.0, HM_THICKNESS + FM_THICKNESS / 2.0)
    )
    magnet = fm.Ferromagnet(
        name="fm",
        geometry=fm_geometry,
        material=material,
        m0=seed,
    )

    hm = fm.RegionRef("hm")
    ferromagnet = fm.RegionRef("fm")
    charge_outer = [
        _surface("hm", "y-", (0.0, -1.0, 0.0)),
        _surface("hm", "y+", (0.0, 1.0, 0.0)),
        _surface("hm", "z-", (0.0, 0.0, -1.0)),
        _surface("fm", "y-", (0.0, -1.0, 0.0)),
        _surface("fm", "y+", (0.0, 1.0, 0.0)),
        _surface("fm", "z+", (0.0, 0.0, 1.0)),
    ]
    spin_outer = [
        _surface(object_id, face, normal)
        for object_id, face, normal in (
            ("hm", "x-", (-1.0, 0.0, 0.0)),
            ("hm", "x+", (1.0, 0.0, 0.0)),
            ("hm", "y-", (0.0, -1.0, 0.0)),
            ("hm", "y+", (0.0, 1.0, 0.0)),
            ("hm", "z-", (0.0, 0.0, -1.0)),
            ("fm", "x-", (-1.0, 0.0, 0.0)),
            ("fm", "x+", (1.0, 0.0, 0.0)),
            ("fm", "y-", (0.0, -1.0, 0.0)),
            ("fm", "y+", (0.0, 1.0, 0.0)),
            ("fm", "z+", (0.0, 0.0, 1.0)),
        )
    ]
    charge = fm.CurrentTransport(
        name="charge",
        model="ohmic_poisson",
        coupling="one_way",
        domain=[hm, ferromagnet],
        materials=[
            fm.ChargeTransportMaterialAssignment(hm, fm.ChargeTransportMaterial(5.0e6)),
            fm.ChargeTransportMaterialAssignment(
                ferromagnet, fm.ChargeTransportMaterial(1.0e6)
            ),
        ],
        boundaries=[
            fm.NormalCurrentElectrode(
                "terminal_x_minus",
                [
                    _surface("hm", "x-", (-1.0, 0.0, 0.0)),
                    _surface("fm", "x-", (-1.0, 0.0, 0.0)),
                ],
                outward_current_density_Apm2=-CURRENT_DENSITY,
            ),
            fm.NormalCurrentElectrode(
                "terminal_x_plus",
                [
                    _surface("hm", "x+", (1.0, 0.0, 0.0)),
                    _surface("fm", "x+", (1.0, 0.0, 0.0)),
                ],
                outward_current_density_Apm2=CURRENT_DENSITY,
            ),
            fm.ChargeInsulating("insulating_outer", charge_outer),
        ],
        gauge=fm.ChargePotentialGauge("zero_mean"),
        solver=fm.ChargeSolverPolicy(
            engine="cg",
            relative_tolerance=1.0e-10,
            absolute_tolerance=0.0,
            max_iterations=10_000,
        ),
    )
    spin = fm.SpinDriftDiffusion(
        id="spin",
        current_source_id=charge.name,
        domain=[hm, ferromagnet],
        materials=[
            fm.SpinTransportMaterialAssignment(
                hm,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=5.0e6,
                    polarization_p=0.0,
                    theta_sh=0.2,
                    lambda_sf_m=1.5e-9,
                ),
            ),
            fm.SpinTransportMaterialAssignment(
                ferromagnet,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=1.0e6,
                    polarization_p=0.4,
                    theta_sh=0.0,
                    lambda_sf_m=5.0e-9,
                    lambda_j_m=1.0e-9,
                    lambda_phi_m=1.0e-9,
                ),
            ),
        ],
        interfaces=[
            fm.MixingConductanceSpinInterface(
                id="hm_fm",
                normal_to_ferromagnet=(0.0, 0.0, 1.0),
                normal_side=hm,
                ferromagnet_side=ferromagnet,
                normal_surface=_surface("hm", "z+", (0.0, 0.0, 1.0)),
                ferromagnet_surface=_surface("fm", "z-", (0.0, 0.0, -1.0)),
                g_up_Spm2=2.5e14,
                g_down_Spm2=2.5e14,
                g_r_Spm2=5.0e14,
                g_i_Spm2=5.0e13,
            )
        ],
        boundaries=[fm.SpinInsulating("spin_insulating_outer", spin_outer)],
        solver=fm.SpinSolverPolicy(
            engine="native_m1_v1",
            relative_tolerance=1.0e-8,
            absolute_tolerance=0.0,
            max_iterations=500,
        ),
        requested_execution=fm.TransportExecution(
            discretization="fdm",
            device="gpu",
            precision="double",
            execution_mode="strict",
        ),
    )

    return fm.Problem(
        name="racetrack_m1_v1_positive_drive",
        magnets=[magnet],
        auxiliary_geometries=[hm_geometry],
        energy=[
            fm.Exchange(),
            fm.Demag(),
            fm.InterfacialDMI(3.0e-3, interface_normal=(0.0, 0.0, 1.0)),
        ],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(gamma=221_100.0, integrator="rk4", fixed_timestep=1.0e-13),
            outputs=[
                fm.SaveField("m", every=OUTPUT_PERIOD),
                fm.SaveField("V_electric", every=OUTPUT_PERIOD),
                fm.SaveField("J_charge", every=OUTPUT_PERIOD),
                fm.SaveField("spin_potential", every=OUTPUT_PERIOD),
                fm.SaveField("spin_current_tensor", every=OUTPUT_PERIOD),
                fm.SaveField("torque_stt", every=OUTPUT_PERIOD),
            ],
        ),
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=CELL)),
        runtime=fm.RuntimeSelection(
            backend_target="fdm",
            device_target="gpu",
            gpu_count=1,
            device_index=0,
            execution_mode="strict",
            execution_precision="double",
        ),
        current_modules=[charge],
        spin_transports=[spin],
        spin_torques=[
            fm.DriftDiffusionSpinTorque("transport_torque", spin.id, ferromagnet)
        ],
    )
