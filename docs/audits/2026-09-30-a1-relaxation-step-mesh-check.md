# A1 — krok relaksacji a rzeczywista siatka warstwowa

## Wynik

Krok 5 fs pozostaje ponizej limitu wymiany estymowanego przez biezacy
planner dla nowej kanonicznej siatki A1. Nie zmieniono kroku, budzetu ani
parametrow fizycznych. Nie jest to wynik wykonania relaksacji ani dowod
osiagniecia rownowagi, stabilnosci nieliniowej lub pelnego widma.

| Wielkosc | Wynik |
|---|---|
| Magnetyczne Tet4 | 27558 |
| Najkrotsza krawedz magnetycznego tetraedru | 3.3333333333333326 nm |
| A | 13 pJ/m |
| Ms | 800000 A/m |
| gamma0 | 221100 m/(A s) |
| Wspolczynnik bezpieczenstwa planera | 0.1 |
| Estymata szybkosci wymiany | 5.146414345451643e11 1/s |
| Limit dt wedlug planera | 1.943100444067026e-13 s (194.31 fs) |
| Zadany dt | 5e-15 s (5 fs) |
| Stosunek limit/dt | 38.86200888134052 |
| Budzet max_steps * dt | 5e-9 s |

## Metoda i zakres dowodu

Ponownie wygenerowano siatke wedlug publicznego workflow A1: komorka
200 x 200 x 10 nm, otwor r=50 nm, powietrze po 2 um, film hmax=5 nm,
3 warstwy, P1 Tet4, metoda single_geometry_geo_ring. Uwzgledniono tylko
komorki magnetyczne (marker 1), bez tetraedrow powietrza (marker 0).
Dla kazdego Tet4 policzono szesc odleglosci miedzy wezlami, zgodnie z
estimate_fem_exchange_stiffness w crates/fullmag-plan/src/fem.rs.
Odtworzono omega = 2*gamma0*A/(mu0*Ms*h_min^2), dt_limit = 0.1/omega.
Nie zastapiono ani nie obnizono progu wykonawcy; porownano z nim konfiguracje.
Estymata z najkrotszej krawedzi nie jest niezaleznym scislym ograniczeniem
spektralnym dla dowolnej siatki/sliverow. Wlasciwy solver, torque completion,
jakosc siatki oraz zbieznosc czasowa pozostaja osobnymi bramkami.

Qualification JSON: planner_formula_replay_NOT_runtime_validation.
Dowod: a1_mesh_exchange_timestep_replay.json w katalogu wizualizacji watku.
SHA256 dowodu: ca67683285db53ae3165de461814231521f3d640122e2fc326480354e641cec2

## Tozsamosc odczytanych zrodel

- `crates/fullmag-plan/src/fem.rs`: `3cf828e8ccba9762a539b20dbb554c88efca53d4a33eef62ca96f2b8b42ce729`
- `tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py`: `7579715096e32ec4f1bfcf1399fd7a49df59823906b13c2ec60122f0a9a4a151`
- `tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py`: `16e28458cd01fdbc9b11fce6c526479944dc72fdbd47115828a5ed6dbdc77f19`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`: `fc2c2d68c28713d5442d4132abcb34e4fbb8068be4c8daafd6242d6570da0549`


#178 nadal running; kontener solvera i nowe czestotliwosci jeszcze nie istnieja.
Podczas obserwacji managed run_root #178 jeszcze nie powstal: uruchomiony
koordynator jest na przygotowaniu joba, a nie na potwierdzonej kompilacji.
7452 pliki kapsuly, 305309190 bajtow. Nie restartowano joba ani obserwatorow.
Wczesniejszy CPU/log #177 nie identyfikuje dokladnego etapu #178; odczytane
deskryptory dotyczyly takze skanowania historycznego execution/node_modules.
Nie uznano tego za dowod awarii ani pozwolenie na sprzatanie danych.
