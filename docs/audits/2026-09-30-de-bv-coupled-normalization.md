# Audyt DE/BV: skala sprzężonych pól — 2026-09-30


## Archiwalny Poisson DE/BV: niespójna normalizacja pary — 2026-09-30

Niezależne narzędzie `scripts/audit_de_bv_poisson_weak.py` składa słabą
postać eq-fem-full-bloch-weak na pełnych tetraedrach P1: całkę gradientów
phi oraz źródło Ms razy średnia węzłowej magnetyzacji w elementach filmu.
Stosuje sprzężone zespolone ograniczenie Floqueta C^H i usuwa klasy
Dirichleta na zewnętrznych płaszczyznach z tego benchmarku. Residual to
norma różnicy obu wolnych wektorów słabych podzielona przez sumę ich norm.
Ms jest w A/m, phi w A, m jest bezwymiarowe; norma względna jest bezwymiarowa.
Warunki: film 40 × 40 × 10 nm, Ms=800000 A/m, A=13 pJ/m,
gamma0=221100 m/(A·s), B0=0.1 T w +x, airbox 2 µm na stronę,
PBC x/y, DE k_y i BV k_x, k=2…25 rad/µm. Python/ProblemIR bez zmian.

13 z 19 par daje residual około 3e-15…1.4e-14. Pozostałe 6:
BV k=7,15,20,22,25 i DE k=7 rad/µm daje 0.089…0.1664.
Diagnostyczne dopasowanie dodatniej skali źródła 1.195…1.399 redukuje
ich defekt do około 3e-15…9e-15. Dopasowania nie zastosowano do danych,
nie zmieniono kryterium 1e-8 ani częstotliwości. To diagnostyka błędu,
nie sposób akceptowania modów.

Przyczyna w aktualnym źródle: deduplicate_slepc_modes_by_overlap kopiował
cały SLEPcModalAcceptedMode, po czym nadpisywał tylko mode_vector
normalizowaną kopią z deduplikatora. Potencjał i certyfikaty pozostawały
w pierwotnej skali. Oba wywołania, dense i sparse/shared-domain, używają
tej funkcji. Zamierzona poprawka zachowuje całą oryginalną parę q/phi;
normalizowane kopie służą wyłącznie porównaniu overlap. Rust może następnie
normalizować oba pola tą samą skalą. Kinematyka i eigenvalues bez zmian.

To potwierdzony błąd publikacji w bieżącym kodzie i silne wyjaśnienie
niespójności historycznych pól. Historyczna biblioteka nie ma pełnego
powiązania z obecnym źródłem, więc pochodzenie tych 6 artefaktów wymaga
nowego uruchomienia. Błąd sam nie wyjaśnia różnicy częstotliwości wobec
analityki n=0. Wcześniejsze pomiary seam oraz H=-grad(phi) nadal są prawdziwe,
ale nie dowodzą zgodności phi ze źródłem m. Te 6 par nie kwalifikuje się
jako spójne sprzężone pola. Nie zastępuje to pełnego residualu magnetycznego,
zbieżności siatki/airboxu, kontroli Gamma, COMSOL ani parytetu GPU.
Poprawka C++: WIP, managed runtime NOT VERIFIED; brak nowego solve.

| Source ID | Źródło | Symbol |
|---|---|---|
| source-archived-poisson-weak | `scripts/audit_de_bv_poisson_weak.py` | `weak_poisson_residual` |
| source-archived-poisson-inspection | `scripts/audit_de_bv_poisson_weak.py` | `inspect` |
| source-coupled-mode-window-dedup | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | `std::vector<SLEPcModalAcceptedMode> deduplicate_slepc_modes_by_overlap` |

| Przypadek | Residual Poissona | Skala źródła (diagnostyka) | Defekt po dopasowaniu |
|---|---:|---:|---:|
| de-smoke-bv-k7 | 0.160194137 | 1.38150278 | 4.408e-15 |
| de-smoke-bv-k15 | 0.158311156 | 1.37617501 | 3.671e-15 |
| de-smoke-bv-k20 | 0.0889926912 | 1.19537207 | 3.417e-15 |
| de-smoke-bv-k22 | 0.165564627 | 1.39683032 | 3.515e-15 |
| de-smoke-bv-k25 | 0.158003378 | 1.37530644 | 3.279e-15 |
| de-smoke-k7 | 0.166366837 | 1.3991368 | 8.816e-15 |

Artefakt: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\archived-poisson-weak-scale-diagnostic.json`.
SHA-256: `c6780ba1cd4b32b42ed18c3075420685f10c1aee8c48593685a7393952017c44`.

## Kolejne bramki

1. Zweryfikować poprawkę na aktualnej bibliotece przez zatwierdzony managed profil bez kompilacji unit tests; obecny runtime-only nie jest w allow-list.
2. Ponownie policzyć BV k=7 i DE k=7, związać runtime i źródło, sprawdzić pełny residual oraz niezależne równanie Poissona z obu opublikowanych pól.
3. Rozszerzyć ponowny pomiar na pozostałe cztery niespójne pary; historycznych plików nie nadpisywać ani przeskalowywać.
4. Wyjaśnienie różnicy częstotliwości: osobne bramki Gamma, zbieżności siatki i airboxu, liczby warstw/modów oraz zakresu przybliżenia analityki n=0. Nie przypisywać tej różnicy normalizacji bez dowodu.
5. Dług technologiczny: sparse shared-domain nadal używa metryki identity w deduplikacji; potrzebny backendowy consistent mass inner-product bez materializacji gęstego operatora. Poprawka skali tego nie naprawia.

Interpretowane regresje słabej postaci: 10 PASS, w tym jednostronna
normalizacja oraz jawna macierz C^H z Dirichletem. To nie wykonanie C++.
