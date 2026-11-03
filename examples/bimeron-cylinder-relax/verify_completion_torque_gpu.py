# %% Accepted completion transport probe (FDM GPU only)
"""Transport probe for accepted GPU completion, not a physics qualification.

Uses the existing small coupled-film fixture from verify_bb_gpu.py. The torque
case deliberately uses a permissive threshold to exercise the completion
protocol; the budget case stops before relaxing the fixture. Neither changes
the user's bimeron parameters or stopping criteria.
"""
import os
from pathlib import Path
import fullmag as fm

probe_device = "gpu"
study = fm.study("verify_completion_torque_gpu")
study.engine("fdm")
study.device(probe_device, precision="double")
study.mode("strict")
study.storage(output_dir=str(Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", str(Path(__file__).resolve().parent))) / "verify_completion_torque_gpu-results"), data_format="zarr")
cell = (2.5e-9,)*3
study.cell(*cell)
study.solver(dt_initial=1e-14, max_err=1e-6, integrator="rk23")
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
relax=study.stages.add_relax(stage_id="completion_probe",algorithm="projected_gradient_bb",max_steps=10,tolT=1e3)
relax.autosave(fm.StageAutosave(table=fm.TableAutosave(every_steps=1,quantities=["step","E_total","max_torque_T"]),fields=[fm.FieldAutosave(q,every_steps=1) for q in ("m","H_demag","H_eff","H_rotated_dmi")]))
