# Archiwalne DE/BV: kontrola magnetycznego seam — 2026-09-30


## Niezależny pomiar fazy 19 archiwalnych modów DE/BV

Narzędzie `scripts/audit_de_bv_periodic_seams.py` korzysta z jawnych
periodic_node_pairs i translacji periodic_boundary_pairs w siatce.
Loader `load_record` wiąże finalny porządek siatki z tożsamością
opublikowanego pola, sprawdza hashe binarnego payloadu i oryginalny
full descriptor residual ≤ 10⁻⁸. Odtwarzanie fizycznego pola z envelope
wykorzystuje tę samą konwencję przestrzenną co eq-fem-dynamic-ansatz.
Porównanie odbywa się na zadeklarowanych parach A→B, nie przez
zgadywanie par na podstawie współrzędnych. Położenia muszą zgadzać
się z translacją w granicach zapisanej tolerancji siatki.

| Zakres | Wynik |
|---|---|
| DE: 9 modów, po 28 par magnetycznych | max defekt względny 3.227404597226726e-16 |
| BV: 10 modów, po 28 par magnetycznych | max defekt względny 3.3852323788985243e-16 |
| Świadomie odwrócony znak fazy | defekt 0.1598…1.68294 |
| Świadomie pominięta faza | defekt 0.07997…0.95885 |
| Regresje narzędzia interpretowanego | 7 PASS |

Warunki: film 40 × 40 × 10 nm, Ms=800000 A/m, A=13 pJ/m,
gamma0=221100 m/(A·s), B0=0.1 T w +x, PBC x/y, demag airbox
z phi=0 na górze/dole, DE k_y i BV k_x, k=2…25 rad/µm.
Python/ProblemIR i częstotliwości nie zostały zmienione. To diagnostyka
historycznych FEM CPU pól, nie nowy solve, FEM GPU ani FDM.

Wnioski: fazowe zszycie magnetycznych pól tych 19 modów jest zgodne
z deklarowaną konwencją na jawnych parach. Ta kontrola nie tłumaczy
całej różnicy względem analityki i nie dowodzi phi/airbox, zbieżności
siatki ani kompletności pasm. Pair-based diagnostic nie jest wykonaniem
nowego root-class-based Rust ani jego testów. Qualification NOT VERIFIED.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-archived-magnetic-pair-seams | `scripts/audit_de_bv_periodic_seams.py` | `magnetic_pair_seams` |
| source-archived-bound-mode-loader | `scripts/compare_de_bv_mode_profiles.py` | `load_record` |

Artefakt: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\archived-magnetic-seams.json`.

Report SHA-256: `1e60392a39517fd72cc33f40ea614c3c21cd940bc592a3fedcfa64f2081ba8d9`.
Comparison SHA-256: `d670e8bf4fcc3387d41266eb835f776bdb1da69fdf3a611f28e97ce86b008f9c`.
Producer SHA-256: `691f586ba7689ed23c82227c46ee0e4aea26b13c4cd58dace4692585c1728116`.
