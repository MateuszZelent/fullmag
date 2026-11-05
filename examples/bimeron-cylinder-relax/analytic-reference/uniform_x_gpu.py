"""GPU magnetostatic reference: uniform +X R50/H30 nm cylinder, SI.

A bounded damping-only LLG stage with alpha=0 has identically zero RHS.
It evaluates the existing native CUDA demag operator without relaxing M.
The terminal M must be checked before treating its field as a uniform reference;
relaxation convergence is neither requested nor inferred from this stage.
"""
# %% Explicit model and execution intent
import os
from pathlib import Path
import fullmag as fm

NM = 1e-9
CELL = (2.5 * NM,) * 3
study = fm.study("cylinder_uniform_plus_x_gpu_reference")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.storage(output_dir=str(Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", ".")) / "cylinder-uniform-plus-x-reference-results"), data_format="zarr")
study.universe(mode="manual", size=(600*NM, 600*NM, 65*NM),
               center=(0., 0., 27.5*NM), padding=(0., 0., 0.))
study.cell(*CELL)
study.solver(fix_dt=1e-14, integrator="heun")

# %% Same voxelized cylinder and material as the current experiment
cylinder = study.geometry(
    fm.Cylinder(radius=50*NM, height=30*NM).translate((0., 0., 25*NM)),
    name="uniform_cylinder", object_id="upper-cylinder")
cylinder.Ms = 1.3e6
cylinder.Aex = 10e-12
cylinder.Ku1 = 0.
cylinder.alpha = 0.
cylinder.mesh(cell_size=CELL)
cylinder.m = fm.texture.uniform(1., 0., 0.)
study.fdm(default_cell=CELL, demag=fm.FDMDemag(
    strategy="multilayer_convolution", mode="three_d",
    common_cell_size=CELL, fft_backend="cufft"))
study.demag()

# %% Static reference, not a relaxed equilibrium
stage = study.stages.add_relax(stage_id="static_uniform_field", algorithm="llg_overdamped",
                              solver="heun", dt=1e-14, tolA=1e-12, max_steps=1)
stage.autosave(fm.StageAutosave(
    table=fm.TableAutosave(every_steps=1, quantities=["step", "t", "mx", "my", "mz", "E_total"]),
    fields=[fm.FieldAutosave("m", every_steps=1), fm.FieldAutosave("H_demag", every_steps=1)]))
study.airbox.visualization(show=True, mode="vectors", active_quantity_id="H_demag", wireframe=False)
