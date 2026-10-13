# Blokada periodycznej triangulacji siatki warstwowej — 2026-09-30

## Stan wykonania

Managed build #179 (`1d5451d2fee5443591a9c7f468569c43`, profil
`fem-cpu-slepc-runtime-v2`) zakończył się `succeeded`, exit 0.
Seria DE/BV k=25e6 rad/m, 3/6/9 warstw, zakończyła wszystkie sześć
wrapperów exit 1 przed eigensolve. Brak nowych częstotliwości.
Wspólny błąd: `FEM periodic mesh certificate v6: periodic v6 pair
'y_faces' face topology/orientation is not a bijection`.

Odczyt live runnera 2026-09-30 18:46 UTC: `worker_alive=true`,
`accepting_jobs=true`, `worker_error=null`, brak aktywnych jobów,
koordynator `waiting_for_disk`, storage_free_bytes=1861853184.
Host C: potwierdził około 1.86 GB, poniżej progu admission 8 GiB.
Wcześniejsze zwolnienie miejsca umożliwiło build #179; obecny pomiar
nie potwierdza ponad 10 GB. Niczego nie usunięto.

## Reprodukcja bez kompilacji

Rzeczywisty Gmsh, bieżący Python na branchu
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`ef268a6d01c7fbfa82e9c5395eb4a87447293b96`.
Box 40×40×10 nm, hmax=10 nm, airbox 40×40×410 nm,
air hmax=50 nm, grading=1.3, tet4/tri3, pary x_faces/y_faces.
Wywołanie `certify_extracted_periodic_mesh` po realizacji odrzuca x_faces.

| Warstwy | Trójkąty źródłowe x / y | Bez identycznej pary x / y |
|---|---:|---:|
| 3 | 152 / 152 | 152 / 152 |
| 6 | 176 / 176 | 176 / 176 |
| 9 | 200 / 200 | 200 / 200 |

Węzły pasują po translacji. Prostokątne panele na przeciwległych ścianach
mają przeciwne przekątne triangulacji. Sama zgodność węzłów nie zapewnia
bijekcji trójkątów ani zgodnego dyskretnego śladu FEM. Nie jest to błąd
progu residualu solvera: eigensolve jeszcze się nie rozpoczął.

Owner: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`,
`_generate_coincident_ring_airbox_mesh`: GEO extrusion z `numElements=[1]`
i `heights=[1.0]`; ponowne `setPeriodic` po generate(3) daje mapę węzłów,
ale nie naprawia przekątnych. Zgodnie z [manualem Gmsh](https://gmsh.info/doc/texinfo/)
`setPeriodic` po meshing zakłada, że siatki już sobie odpowiadają.

## Hipotezy sprawdzone bez zmiany plików

1. Zgodne kierunki przeciwległych krzywych źródłowych: nie usuwa błędu.
2. Geometryczne slab volumes bez wymuszania extrusion Layers: siatka 3-warstwowa
   przechodzi Python certificate, ale żądane 6 warstw daje 7 płaszczyzn
   magnetycznych. Hipoteza nie spełnia całego kontraktu; nie wdrożono jej.

Nie zmieniono produkcyjnego meshera, walidatora ani bramki naukowej.
Python certificate nie zastępuje Rust v6 ani rzeczywistego runtime.

## Następne kroki i kryteria akceptacji

1. Zbudować zgodną triangulację obu par ścian razem z tetrahedralnym wnętrzem.
   Nie wystarczy podmienić facet_nodes: każdy facet musi być rzeczywistą ścianą
   sąsiedniej komórki. Zachować dokładne warstwy i rozdział magnetic/air.
2. Rozszerzyć real-Gmsh regression o bijekcję trójkątów, normals, incidence,
   zbieżność obu osi i pełny certyfikat dla 3/6/9 warstw, Box i antidot/ring.
3. Ponowić materializację publicznego przykładu i Rust v6 certificate.
4. Dopiero po tych bramkach ponowić DE/BV/Γ na przypiętym runtime, sprawdzić
   residual, provenance i zbieżność oraz zaktualizować wykresy.
5. Sprawdzić storage przed następnym managed buildem. Nie uruchamiać
   równoległego ciężkiego buildu ani nie usuwać danych bez upoważnienia.

S04 pozostaje otwarte. Build, zgodność siatki, wyniki solvera, analityka,
COMSOL i pełna kwalifikacja S00–S12 są oddzielnymi bramkami.
