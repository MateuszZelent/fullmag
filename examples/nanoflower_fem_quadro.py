"""Canonical Fullmag script generated from the model builder.

Source: nanoflower_fem.py
Entrypoint: flat_workspace
"""

from pathlib import Path

import fullmag as fm

SCRIPT_DIR = Path(__file__).resolve().parent
RELAXED_STATE_ZARR = SCRIPT_DIR / "nanoflower_relaxed_m.zarr.zip"
RELAXED_STATE_H5 = SCRIPT_DIR / "nanoflower_relaxed_m.h5"
USE_SAVED_RELAXED_STATE = RELAXED_STATE_ZARR.exists()

study = fm.study("nanoflower_fem")

# Engine
study.engine("fem")
study.device("cpu", precision="double")
study.universe(mode="auto", size=(0.8e-06, 0.8e-06, 3e-07), center=(0, 0, 0), padding=(0, 0, 0))
study.universe.mesh(minimum_element_size=20e-09, maximum_element_size=0.9e-07)
study.interactive(True)

# Geometry & Material — 2×2 kwadratowa siatka nanoflowerów
# Parametry siatki
nanoflower_approx_size = 330e-9  # Faktyczny rozmiar STL bounding box (m)
spacing = 50e-9                   # Przerwa między nanoflowerami (m)
pitch = nanoflower_approx_size + spacing  # Step siatki (nanoflower + przerwa)

# Definiuj 4 pozycje w siatce 2×2 (znormalizowane względem centrum)
positions_2x2 = [
    (-pitch / 2, -pitch / 2),  # Lewy-dolny
    (+pitch / 2, -pitch / 2),  # Prawy-dolny
    (-pitch / 2, +pitch / 2),  # Lewy-górny
    (+pitch / 2, +pitch / 2),  # Prawy-górny
]

# Materiały: wspólne parametry
common_Ms = 752000
common_Aex = 1.55e-11
common_alpha = 0.1

# Bazowa geometria
base_geometry = fm.ImportedGeometry(source="nanoflower.stl", scale=1e-09)

# Stwórz 4 nanoflowery w siatce z losową magnetyzacją
for idx, (dx, dy) in enumerate(positions_2x2):
    # Utwórz translatowaną geometrię
    translated_geom = base_geometry.translate((dx, dy, 0.0))
    
    # Nazwij geometrię wg pozycji w siatce
    body_name = f"nanoflower_{idx}"
    body = study.geometry(translated_geom, name=body_name)
    
    # Ustaw wspólne materiały
    body.Ms = common_Ms
    body.Aex = common_Aex
    body.alpha = common_alpha
    
    # Magnetyzacja: losowa z różnym seedem dla każdej kopii (dla nietrywialnego warunku początkowego)
    body.m = fm.texture.random(seed=10 + idx)

    # Mesh — wymagany explicit maximum_element_size dla każdego obiektu magnetycznego
    body.mesh(maximum_element_size=19e-09, order=1, algorithm_2d=1, algorithm_3d=1, size_factor=1,
              size_from_curvature=1, smoothing_steps=1, optimize_iterations=1,
              narrow_regions=1, compute_quality=True, per_element_quality=True)

# Mesh
study.objects.mesh.defaults(algorithm_2d=6, algorithm_3d=1, size_factor=1, size_from_curvature=0, smoothing_steps=1, optimize_iterations=1, narrow_regions=0, compute_quality=False, per_element_quality=False)
study.build_domain_mesh()

# Use Poisson-Robin demag on the managed FEM GPU runtime.
study.demag(realization="poisson_robin")
study.b_ext(0.0001, theta=0, phi=0)  # 0.1 T along +z
# ── Solver ──────────────────────────────────────────────────
# study.solver(dt=1e-15, g=2.115)
study.solver(max_error=1e-6, integrator="rk45", g=2.115)

# ── Outputs ─────────────────────────────────────────────────
# study.save("m", every=1e-13)
# study.save("H_demag", every=1e-13)
# study.tableautosave(1e-13)

# ── Run ─────────────────────────────────────────────────────
# Dla siatki 4 nanoflowerów: relaksuj wszystkie jednocześnie
# (Wspólny stan magnetyzacji dla symulacji interaktywnej)
if not USE_SAVED_RELAXED_STATE:
    relax_result = study.relax(
        tol=1e-6,                       # torque tolerance (max_dm_dt)
        max_steps=200_000,              # limit kroków
        # Native FEM GPU currently supports LLG-based relaxation paths.
        algorithm="projected_gradient_bb", 
    )
    # Wynik relaksacji
    if hasattr(relax_result, "save_state"):
        relax_result.save_state(RELAXED_STATE_ZARR, format="zarr")
        relax_result.save_state(RELAXED_STATE_H5, format="h5")

# ── Eigenmode analysis ──────────────────────────────────────
# study.save("spectrum")
# study.save("mode", indices=[0, 1, 2])
study.eigenmodes(
    count=20,
    target="lowest",
    include_demag=True,
    equilibrium_source="relax",
)

# # study.run(1e-9)
