# FDM bez limitu 256 regionów: pomiary i parytet (2026-11-01)

- Branch: `codex/fdm-unbounded-regions-20261101`; kod CUDA w commicie `ed7e61f65`,
  skrypty w `78586bc89`. Baza porównania: `master` `c416e1b70` (PR #374) z poprawką
  launchera `5f87465ad`, zbudowana w osobnej grupie
  `fullmag-worktree-fdm-unbounded-regions-baseline-2-d08c988e293d5c74`.
- Sprzęt: NVIDIA GeForce RTX 4080 SUPER (sterownik 617.42, `sm_89`), Docker DEV na
  Windows (WSL2). Build `backend-dev` w kontenerze `backend` grupy tego worktree.
- Kontrakt: nota 0104, sekcje `material-regions-fdm-connection-operator` i
  `material-regions-fdm-lane-realization`; projekt w
  `docs/superpowers/specs/2026-11-01-fdm-unbounded-regions-architecture-design.md`.
- Wszystkie liczby to pomiary jednej maszyny; nie są kwalifikacją naukową ani
  wydajnościową innych GPU.
- Pochodzenie pomiarów: mikrobenchmark, czas kroku i pierwszy parytet zmierzono na
  buildzie z `ed7e61f65`/`78586bc89`. Późniejsze commity (`1773c96a2` i poprawki po
  przeglądzie) nie zmieniają żadnego kernela CUDA (`git diff ed7e61f65 HEAD --
  backends/fdm/gpu` jest pusty); zmieniają walidację przy tworzeniu backendu,
  energię napędu po stronie hosta, bramki planera i warunek zwinięcia operatora do
  `uniform`, który nie dotyczy mierzonych przypadków. Parytet z sekcji 2 powtórzono
  na buildzie HEAD (sekcja 2, ostatni akapit).

## 1. Mikrobenchmark reprezentacji współczynników wymiany

Skrypt: `scripts/benchmarks/cuda_exchange_faces_bench.cu` (zdarzenia CUDA, 20
rozgrzewek, mediana z 5 serii po 100–200 uruchomień). Jeden kernel pola wymiany na
zmienną; ziarna 8×8 komórek, 8 materiałów rozłożonych mieszanie (hash), o ile nie
podano inaczej. Uwaga: wariant `uniform` liczy w benchmarku prefaktor z dzieleniem na
komórkę, więc jest nieco wolniejszy niż produkcyjna ścieżka jednorodna. Warianty nie
rozwiązują tego samego problemu fizycznego: LUT 256² czyta współczynnik pary
materiałów z tablicy, a ściany i warianty z harmoniczną liczą średnią harmoniczną
lokalnych `A`, więc wartości `A_ij` się różnią. Tabela porównuje koszt dostępu do
współczynników i arytmetyki, nie wyniki fizyczne.

Czas jednego uruchomienia [µs]:

| Wariant | 1024²×1 fp64 | 1024²×1 fp32 | 256²×64 fp64 | 256²×64 fp32 | 128³ fp64 | 128³ fp32 |
|---|---:|---:|---:|---:|---:|---:|
| uniform | 163.9 | 35.7 | 601.0 | 155.9 | 284.1 | 68.4 |
| uniform + komórkowe Ms | 156.3 | 37.6 | 601.1 | 222.9 | 283.7 | 69.0 |
| LUT 256² (stara ścieżka) | 145.2 | 48.9 | 571.8 | 189.3 | 273.1 | 94.6 |
| **ściany fp64 + Ms (produkcja)** | 149.1 | 50.8 | 571.9 | 369.3 | 271.1 | 177.1 |
| ściany fp32 + Ms | 164.5 | 33.3 | 642.5 | 291.1 | 323.5 | 137.4 |
| A na komórkę, harmoniczna w kernelu | 238.4 | 151.7 | 955.1 | 563.5 | 470.6 | 282.1 |
| id materiału u16 + tablica | 246.8 | 151.7 | 955.0 | 558.8 | 472.0 | 299.2 |

Dodatkowe przebiegi 256²×64: rozkład skupiony 8 materiałów i 1024 materiały dają te
same wnioski (ściany fp64: 554 / 573 µs w fp64; 367 / 367 µs w fp32).

Wnioski:

1. fp64 na tej karcie jest ograniczone obliczeniowo (fp64 1/64). Ściany kosztują tyle
   co ścieżka jednorodna i stara LUT. Warianty z harmoniczną liczoną w kernelu są
   1.6–1.7× wolniejsze przez dzielenia fp64, także dla tablicy materiałów u16.
2. fp32 3D jest ograniczone przepustowością pamięci. Ściany z współczynnikami fp64
   kosztują 2.4× ścieżki jednorodnej (369 vs 156 µs), z współczynnikami fp32 1.9×.
   Stara LUT kosztowała 1.2×.
3. Poziom P (id materiału + tablica) nie daje zysku ani w fp64, ani w fp32 przy
   harmonicznej w kernelu. Zostaje odłożony zgodnie z kryterium ze specyfikacji.
4. Wybór produkcyjny: ściany fp64. Follow-up: przechowywanie ścian w fp32 dla toru
   fp32 (oszczędność ok. 20% kernela wymiany w 3D).

## 2. Parytet CPU vs CUDA (headless)

Skrypty: `scripts/benchmarks/fdm_regions_parity_case.py`,
`scripts/benchmarks/run_fdm_regions_parity.py`. RK4, dt = 10 fs, 2000 kroków, demag
włączony, pole 50 mT wzdłuż z, losowa tekstura początkowa, komórka 2 nm, podgląd
wyłączony. Porównanie: max |Δm| po komórkach i składowych oraz maks. względna różnica
energii z ostatniego wiersza `scalars.csv`.

| Przypadek | Siatka | max abs Δm CUDA fp64 vs CPU | max rel. Δ energii | CPU / CUDA [s] |
|---|---|---:|---:|---:|
| dwa materiały, reguła `explicit` A = 4e-12 J/m | 128×32×1 | 3.4e-8 | 5.3e-11 | 40.0 / 11.0 |
| dwa materiały, `harmonic_mean` × 0.5 | 128×32×1 | 6.1e-8 | 6.6e-11 | 42.4 / 12.0 |
| 1024 ziarna (Ms/A/α ±10%, kilka reguł × 0.3) | 256×256×1 | 3.0e-7 | 3.6e-10 | 286.6 / 54.6 |
| jednorodny (odniesienie) | 128×32×1 | 7.8e-8 | 6.0e-9 | 42.2 / 10.2 |
| jednorodny z 2 regionami bez reguł | 128×32×1 | 7.8e-8 | 6.0e-9 | 37.2 / 9.0 |

- Dwa materiały: Ms 800/1200 kA/m, A 13/20 pJ/m, α 0.02/0.1; przejście domyślne
  `mesh_relative(cells=3)`.
- Ziarna wymagają rozłącznych priorytetów: pierwszy przebieg z równymi priorytetami
  został poprawnie odrzucony przez planer (konflikt nakładających się regionów).
- Przypadek z regionami bez reguł daje **bitowo ten sam** `m_final` co przypadek bez
  regionów, na CPU i na CUDA (operator `uniform`).
- fp32 po 2000 krokach rozjeżdża się z CPU do |Δm| ≈ 2 także w przypadku
  jednorodnym, bo losowa tekstura jest chaotyczna. Dlatego fp32 kwalifikujemy w
  krótkim horyzoncie (sekcja 2a), a nie na tej trajektorii.

Powtórzenie na buildzie `9c56c1a04` (po poprawkach z przeglądu, utwardzony skrypt
parytetu kończy się kodem 0): wszystkie pięć przypadków fp64 daje te same max |Δm|,
różnice energii i hashe `m_final` co powyżej (dwa materiały `630cb7bddf06`, ziarna
`f454815bf28b`, jednorodny `18f2bc6e4437`).

## 2a. Kwalifikacja tolerancyjna CUDA fp32

Decyzja użytkownika („Narrow it + tolerance”): kontrakt bitowy obejmuje tylko fp64,
a fp32 ma kwalifikację tolerancyjną względem referencji fp64. Polecenie:
`run_fdm_regions_parity.py --with-fp32`. Dla każdego przypadku CPU fp64 i CUDA fp32
liczą 10 kroków RK4 (dt = 10 fs) z zapisem `H_ex` i `H_eff`. Porównanie: max |Δm|,
względna różnica każdego składnika energii z ostatniego wiersza `scalars.csv` oraz
max |ΔH| / max |H_ref| po komórkach i składowych. Pola porównujemy w kroku 10, bo
tory zapisują pierwszą próbkę w różnych krokach (CPU w kroku 1, CUDA w kroku 0).
NaN/inf w dowolnej porównywanej wartości kończy skrypt kodem 1.

Tolerancje (domyślne w skrypcie): max |Δm| ≤ 1e-5, energia ≤ 1e-5 na składnik,
pola ≤ 1e-5. To ok. 84 ULP float (ε = 1.19e-7), co najmniej 20× powyżej
zmierzonych maksimów.

| Przypadek | max abs Δm | maks. wzgl. Δ energii (składnik) | wzgl. Δ `H_ex` | wzgl. Δ `H_eff` |
|---|---:|---:|---:|---:|
| dwa materiały, `explicit` | 1.84e-7 | 1.38e-7 (`E_ext`) | 1.65e-7 | 1.60e-7 |
| dwa materiały, `harmonic_mean` × 0.5 | 1.84e-7 | 1.10e-7 (`E_demag`) | 1.65e-7 | 1.58e-7 |
| 1024 ziarna | 2.26e-7 | 5.02e-7 (`E_ext`) | 2.34e-7 | 2.16e-7 |
| jednorodny | 1.89e-7 | 1.93e-7 (`E_ext`) | 1.56e-7 | 1.58e-7 |
| jednorodny z 2 regionami bez reguł | 1.89e-7 | 1.93e-7 (`E_ext`) | 1.56e-7 | 1.58e-7 |

- Błąd `E_ex`, `E_demag` i `E_total` to 7–12e-8, czyli rząd ε float. Większy błąd
  `E_ext` wynika z małego ⟨m_z⟩ losowej tekstury (ok. 4e-3): energia Zeemana jest
  różnicą dużych składników.
- Przypadek z regionami bez reguł daje te same błędy co jednorodny; operator
  `uniform` nie zależy od etykiet regionów.
- Wspólny magazyn `results.zarr/stages/*/fields/<pole>` zapisuje wartości w kolejności
  AoS na CPU i SoA na CUDA, bez etykiety układu. Skrypt czyta więc samoopisujące
  się magazyny torów (`fields/<pole>/step_*.json` na CPU, `fields/<pole>.zarr` z
  osiami `sample/component/cell` na CUDA). Rozjazd układu jest istniejącym
  problemem artefaktów, poza zakresem tego brancha (follow-up).

## 3. Niezmienność względem `master`

Te same przypadki jednorodne w grupie bazowej (`c416e1b70` + `5f87465ad`):

| Przypadek | Tor | `m_final` sha256 branch | `m_final` sha256 master |
|---|---|---|---|
| jednorodny | CPU fp64 | `08df81f1c633` | `08df81f1c633` |
| jednorodny | CUDA fp64 | `18f2bc6e4437` | `18f2bc6e4437` |
| jednorodny z regionami | CPU fp64 | `08df81f1c633` | `08df81f1c633` |
| jednorodny z regionami | CUDA fp64 | `18f2bc6e4437` | `18f2bc6e4437` |
| jednorodny | CUDA fp32 | `d4cdf9ececee` | `7268e110677f` |

fp64 jest bitowo zgodne. W fp32 `master` kierował plany z maską regionów (każdy plan
CUDA ją ma) przez kernel LUT, bo skrót z PR #374 obejmował tylko fp64; teraz przypadek
jednorodny idzie przez laplasjan. Przyjęty kontrakt (decyzja użytkownika, zapisana
w projekcie i w nocie 0104): zgodność bitowa tylko w fp64 na CPU i CUDA, także z
maską regionów; fp32 CUDA nie ma kontraktu bitowego i jest kwalifikowane tolerancją
względem fp64 (sekcja 2a). Kolejności sumowania LUT nie odtwarzamy i nie dodajemy
drugiej gorącej pętli fp32. Po 10 krokach różnica fp32 między branchem a
`master` wynosi 1.19e-7 = 1 ULP float; po 2000 krokach chaotyczna tekstura wzmacnia
ją tak samo jak różnicę CPU–GPU.

## 4. Czas kroku (CUDA)

Skrypty: `scripts/benchmarks/run_fdm_hot_loop_bench.py` (zestaw `gpu_hetero` na
branchu, zestaw `gpu` na `master`), `scripts/benchmarks/fdm_hot_loop_case.py`. Heun
fp64, 3 powtórzenia; czas kroku = (wall długiego przebiegu − mediana wall krótkiego
przebiegu) / różnica kroków, co odejmuje start, planowanie i zapis artefaktów.
Warianty: `uniform` (jeden materiał: Ms 800 kA/m, A 13 pJ/m, α 0.02), `ms`
(`HETERO=1`: prawa połowa jako region z Ms 600 kA/m), `faces` (`HETERO=2`: prawa
połowa z Ms 600 kA/m, A 20 pJ/m i α 0.05, więc operator ścian, komórkowe Ms i
komórkowe tłumienie). Losowa tekstura początkowa, pole 10 mT wzdłuż z. `ex` = sama wymiana,
`full` = wymiana + demag + pole zewnętrzne.

Mediana [ms/krok] (w nawiasie minimum):

| Przypadek | master uniform | branch uniform | branch ms | branch faces | faces vs uniform (mediana) |
|---|---:|---:|---:|---:|---:|
| `ex` 256×256×8 | 0.577 (0.522) | 0.552 (0.506) | 0.577 (0.570) | 0.716 (0.584) | +30% (min +15%) |
| `full` 256×256×8 | 15.981 (15.175) | 16.029 (15.917) | 16.183 (15.709) | 17.074 (15.590) | +7% (min −2%) |
| `full` 256×256×1 | 1.203 (1.196) | 1.111 (1.039) | — | 1.161 (1.009) | +5% (min −3%) |

- Przypadek jednorodny: `m_final` branchu i `master` ma ten sam sha256 we wszystkich
  trzech przypadkach (`661a71e2d996`, `eab033348bef`, `ef01da7e4987`); różnica czasu
  (−8%…+0.3%) mieści się w rozrzucie powtórzeń. Narzut dla modeli bez zmiany
  materiału: brak mierzalnego.
- Komórkowe Ms bez ścian: +0–5% (dodatkowy odczyt `ms_field` w wymianie, demagu i
  energii).
- Pełna heterogeniczność (ściany + Ms + α): w samej wymianie do +30% mediany, w
  realistycznym kroku z demagiem +5–7%, bo FFT demagu dominuje. Rozrzut minimum i
  mediany pokazuje, że pomiar na Windows/WSL2 jest zaszumiony na poziomie ±10%.

## 5. Ograniczenia pomiarów

- Jedna karta konsumencka; na kartach z pełnym fp64 (np. A100/H100) proporcje fp64
  będą inne (ograniczenie pamięcią zamiast obliczeń).
- Parytet to zgodność torów na tym samym planie, nie kwalifikacja fizyczna. Testy
  wyrocznie (pochodna energii, dwie komórki, PBC, reguła zgodna ze skalarem przy
  zmiennym `a_field`) są testami jednostkowymi, lokalnie nie kompilowanymi (zakaz z
  AGENTS.md). Do 2026-11-01 nie uruchamiało ich żadne CI: zadanie `rust-contracts`
  w `.github/workflows/bootstrap.yml` uruchamia dla `fullmag-engine` i
  `fullmag-plan` tylko testy wybrane filtrem nazw. Ten branch dodaje krok „Run FDM
  region exchange operator contracts” z filtrami `exchange_operator::tests`,
  `exchange_face_tests` i testami planera regionów; testy `fullmag-ir` (w tym
  predykat bramki CUDA) CI uruchamia w całości. Testy runnera CUDA
  (`cfg(feature = "cuda")`) i natywne testy kontraktowe C++ nadal nie mają
  przebiegu w CI.
- Kwalifikacja fp32 obejmuje krótki horyzont (10 kroków) na przypadkach parytetu,
  nie długie trajektorie ani inne integratory. Na chaotycznej teksturze nie da się
  jej rozszerzyć na 2000 kroków; do tego potrzebny byłby przypadek niechaotyczny
  (np. relaksacja do stanu równowagi).
