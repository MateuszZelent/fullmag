# Archiwalne DE/BV: phi i rekonstrukcja demag — 2026-09-30


## Archiwalne phi i H_demag: zgodność pól DE/BV

Narzędzie `scripts/audit_de_bv_potential_fields.py` bada full_physical_phasor
phi w SI A oraz elementowe H_demag w SI A/m. Wymaga pełnego pola
na tej samej końcowej siatce, właściwego układu f64 real/imag, poprawnych
hashy i zgodnych operator_input_signature/phase_constraint. Część
rekonstrukcyjna eq-fem-full-bloch-demag jest sprawdzana niezależnie
przez rozwiązanie lokalnego 3 × 3 układu na każdym tetraedrze P1.
Nie rozwiązuje to ponownie Poissona; gradient wykorzystuje zapisane phi.

| Zakres | Wynik |
|---|---|
| DE: 9 modów, pełne phi na 1980 węzłach | max defekt fazy 2.2887833992611187e-16 |
| BV: 10 modów, pełne phi na 1980 węzłach | max defekt fazy 2.2887833992611187e-16 |
| Każdy mod: 1195 jawnych par periodycznych | Wszystkie objęte pomiarem |
| Zewnętrzne płaszczyzny z: po 10 węzłów/mod | phi dokładnie zerowe |
| H_demag vs niezależny gradient phi, objętościowa norma L2 | max względny defekt 1.6741805960076105e-15 |
| H_demag vs gradient, maksimum względne | max defekt 2.026141543011879e-14 |
| Interpretowane regresje gradientu | 6 PASS |

Warunki filmu/materialu są identyczne z wcześniejszą kontrolą 19 modów:
40 × 40 × 10 nm, Ms=800000 A/m, A=13 pJ/m, gamma0=221100 m/(A·s),
B0=0.1 T w +x, PBC x/y, padding airboxu 2 µm z obu stron,
DE k_y/BV k_x, k=2…25 rad/µm. Publiczny Python/ProblemIR pozostaje
bez zmian. To historyczne FEM CPU dane; brak dowodu FEM GPU lub FDM.

Kontrola potwierdza spójność fazy pełnego phi i opublikowanej rekonstrukcji
H_demag. Nie dowodzi niezależnego rozwiązania równania Poissona,
interfejsowego weak flux, zbieżności airboxu/siatki, zgodności z COMSOL
ani wykonania nowego Rust. Phi=0 na geometrycznych zewnętrznych
płaszczyznach jest kontrolą danych tego benchmarku, nie uniwersalnym
identyfikatorem Dirichlet dla dowolnego modelu. Nie zwiększa liczby
częstotliwości; qualification NOT VERIFIED.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-archived-potential-gradient | `scripts/audit_de_bv_potential_fields.py` | `gradient_diagnostics` |
| source-archived-potential-inspection | `scripts/audit_de_bv_potential_fields.py` | `inspect` |

Artefakt: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\archived-potential-diagnostics.json`.

Report SHA-256: `9ff55aaf635f53c5d9603332435f7340cc55c470b0e9685be6ed5ce49ed0e497`.
Comparison SHA-256: `d670e8bf4fcc3387d41266eb835f776bdb1da69fdf3a611f28e97ce86b008f9c`.
Producer SHA-256: `c7167ef7194ad2f85300ddc4ba0e8a1308729de42426e3ac54646c7694e388cc`.
