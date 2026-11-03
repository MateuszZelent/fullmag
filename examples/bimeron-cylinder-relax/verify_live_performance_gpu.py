"""Small active GPU dynamics fixture for live performance UI qualification.

Uses the same geometry and materials as verify_bb_gpu.py, with fixed-step Heun
dynamics over a long physical interval so the browser can observe a real active
solver. This is a transport fixture, not a convergence/performance reference,
and does not change the canonical bimeron relaxation. Stop after the proof;
no artificial delay is inserted into the solver.
"""
import os
from pathlib import Path
import fullmag as fm

probe_device = os.environ.get("FULLMAG_BB_PROBE_DEVICE", "gpu")
study = fm.study("verify_live_performance_" + probe_device)
study.engine("fdm")
study.device(probe_device, precision="double")
study.mode("strict")
study.storage(output_dir=str(Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", str(Path(__file__).resolve().parent))) / ("live-performance-qualification-" + probe_device)), data_format="zarr")
cell = (2.5e-9,)*3
study.cell(*cell)
study.solver(fix_dt=1e-14, integrator="heun")
study.universe(mode="manual", size=(20e-9,20e-9,20e-9), center=(0,0,7.5e-9), padding=(0,0,0))
film = study.geometry(fm.Box(size=(20e-9,20e-9,5e-9)), name="film", object_id="film")
upper = study.geometry(fm.Cylinder(radius=5e-9,height=10e-9).translate((0,0,12.5e-9)), name="upper", object_id="upper")
for obj in (film,upper):
    obj.mesh(cell_size=cell)
    obj.Aex=15e-12
    obj.alpha=1.0
film.Ms=580000.0
film.Ku1=663920.0
film.anisU=(1.0,0.0,0.0)
film.m=fm.texture.bimeron(radius=5e-9,wall_width=3e-9,vorticity=-1,helicity_rad=0.0,background_sign=1,plane="xy")
upper.Ms=1000000.0
upper.Aex=10e-12
upper.Ku1=0.0
upper.m=fm.texture.uniform(-1.0,0.0,0.0)
study.terms.add(fm.RotatedInterfacialDMI(D=0.004,object_ids=[film.object_id]))
study.fdm(default_cell=cell,demag=fm.FDMDemag(strategy="multilayer_convolution",mode="three_d",common_cell_size=cell,fft_backend="cufft" if probe_device=="gpu" else "rustfft"))
study.demag()
transport=study.stages.add_run(stage_id="live_transport",until=1e-8)
transport.autosave(fm.StageAutosave(table=fm.TableAutosave(every_steps=1000,quantities=["step","E_total","max_torque_T"]),fields=[fm.FieldAutosave("m",every_steps=1000)]))
