"""Imported STL nanoflower executed on the FDM backend.

Flat scripting API — inspired by mumax3.
    fullmag examples/nanoflower_fdm.py
"""

import fullmag as fm

# ── Engine ──────────────────────────────────────────────────
fm.name("nanoflower_fdm")
fm.engine("fdm")
fm.device("cuda:0", precision="single")
fm.cell(5e-9, 5e-9, 5e-9)

# ── Geometry & Material ─────────────────────────────────────
flower = fm.geometry(
    fm.ImportedGeometry(
        source="nanoflower.stl",
        units="nm",
        name="nanoflower",
    ),
    name="nanoflower",
)
flower.Ms = 752e3       # saturation magnetisation [A/m]
flower.Aex = 15.5e-12   # exchange stiffness [J/m]
flower.alpha = 0.1      # Gilbert damping
flower.m = fm.random(seed=7)

# ── External field ──────────────────────────────────────────
# Cartesian:  fm.b_ext(0, 0, 0.1)          # 0.1 T along z
# Spherical:  fm.b_ext(0.1, theta=0, phi=0) # same, via angles (degrees)
fm.b_ext(0.1, theta=0, phi=0)  # 0.1 T along +z

# ── Solver ──────────────────────────────────────────────────
# fm.solver(dt=1e-15, g=2.115)
fm.solver(
    dt=1e-15,            # initial timestep [s] when max_error is enabled
    max_error=1e-6,      # tolerancja adaptywnego kroku (atol)
    integrator="rk23",   # nazwa integratora
    g=2.115,             # g-faktor elektronu (→ gamma = μ₀·g·μ_B/ℏ)
    # LUB
    # gamma=2.211e5,       # gamma bezpośrednio [m/(A·s)]
)

# ── Outputs ─────────────────────────────────────────────────
fm.save("m", every=1e-13)
fm.tableautosave(1e-13)

# ── Run ─────────────────────────────────────────────────────
fm.relax(
    tol=1e-6,                       # torque tolerance (max_dm_dt)
    max_steps=50_000,               # limit kroków
    algorithm="llg_overdamped",     # algorytm relaksacji
    energy_tolerance=None,          # opcjonalnie: tolerancja energetyczna
)
fm.run(1e-9)
