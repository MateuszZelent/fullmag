# Diagnostyczny wybór najbliższego modu dla pojedynczego wektora k

- Status: FEM CPU `source_visible / unvalidated`
- Data: 2026-10-01
- Zakres: jeden punkt k dla ścieżki DE, BV albo Γ i jeden wybrany mod
- Kwalifikacja: `NOT VERIFIED`; ta nota nie jest dowodem pełnej dyspersji ani
  zgodności z COMSOL-em

Ta nota opisuje jawny tryb diagnostyczny `nearest`. Solver wybiera jeden mod
najbliższy zadanemu celowi częstotliwościowemu dla jednego wektora falowego:

```{math}
:label: eq-de-smoke-nearest-selection
j_* = \mathop{\mathrm{argmin}}_j |f_j-f_{\mathrm{target}}|,
\qquad f_{\mathrm{target}}>0.
```

`f_target` jest podawane w Hz, natomiast produkcyjny kontrakt native przekazuje
równoważny cel kątowy `target_omega_rad_s` w rad/s. Artefakt wynikowy musi
potwierdzić `target_kind=nearest_frequency`,
`spectrum_completeness=selected_only` oraz `window_complete=false`. Wartość
częstotliwości w CSV pochodzi wyłącznie z solvera; analityka w skrypcie
porównawczym jest wyliczana dopiero po odczycie tego wyniku i nie zastępuje
żadnej wartości numerycznej.

## Zakres authoringu i backendu

Tryb jest dostępny dla istniejących pojedynczych próbek `k0`, `k±n` i
`bv-k±n` w przykładzie `fem_de_smoke_numeric.py`. Wymaga dokładnie jednego
wektora k oraz skończonego, dodatniego celu częstotliwości. Domyślny tryb
`frequency_window` pozostaje bez zmian, podobnie jak tolerancja solvera
`rtol=1e-8`. Alias `de-smoke-nearest-k2` zachowuje zgodność wsteczną, a jawny
interfejs używa `--spectral-target nearest` i
`--nearest-target-frequency-ghz`.

Kontroler `nearest-single-k` wykonuje sześć odrębnych, kolejnych uruchomień:

| Przypadek | Pilot | Geometria | Pinned target |
|---|---|---|---:|
| `gamma-t3` | `de-smoke-k0` | Γ/DE | 9 GHz |
| `bv-k0-t3` | `de-smoke-bv-k0` | Γ/BV | 9 GHz |
| `de-kp2-t3` | `de-smoke-k2` | DE, `+2·10^6` rad/m | 10 GHz |
| `de-km2-t3` | `de-smoke-k-2` | DE, `-2·10^6` rad/m | 10 GHz |
| `bv-kp2-t3` | `de-smoke-bv-k2` | BV, `+2·10^6` rad/m | 9 GHz |
| `bv-km2-t3` | `de-smoke-bv-k-2` | BV, `-2·10^6` rad/m | 9 GHz |

Cele są zapisane w konfiguracji kontrolera i przekazywane jako jawny shift
modalny. Są wyłącznie kryterium wyboru najbliższego modu; nie zastępują
częstotliwości zmierzonej przez solver. Kolektor bierze częstotliwość z CSV i
metadata modu, a sześć wyników pozostaje sześcioma rzeczywistymi uruchomieniami
sekwencyjnymi. Brak któregoś punktu lub jednej ze stron `+k`/`-k` kończy
zbieranie błędem.

Ponieważ ten pilot zamawia dokładnie jeden indeks `OutputIR`, bieżący producent
publikuje `raw_mode_index=0` i `mode_0000.json`; kolektor utrzymuje to jawne
wiązanie z istniejącym loaderem artefaktu. Obsługa innego indeksu wymagałaby
osobnej zmiany loadera i kontraktu ścieżki artefaktu.

Wektor falowy ma jednostkę rad/m, częstotliwość Hz, częstość kątowa rad/s, a
residua są bezwymiarowe. Wybór pojedynczego moda nie dowodzi kompletności
okna, ciągłości gałęzi, zbieżności siatki, airboxu ani zgodności modelu
analitycznego z pełną symulacją.

Model publikuje przenikalność próżni jako $\mu_0=4\pi\cdot10^{-7}$ H/m,
zgodnie z `fullmag-engine::MU0`. Wartość przybliżona zapisana dziesiętnie
prowadziłaby do kilku herców różnicy w częstotliwości Γ przy tym samym airboxie,
dlatego metadata i test authoringu używają tej samej konwencji co silnik.

| Realizacja | Stan | Granica dowodu |
|---|---|---|
| FEM CPU | `source_visible / unvalidated` | Authoring, routing i walidacja artefaktów są opisane; brak świeżego managed runtime. |
| FEM GPU | `not-applicable` | Ta ścieżka diagnostyczna nie publikuje dowodu GPU. |
| FDM CPU/GPU | `not-applicable` | Żaden kontrakt FDM nie jest zmieniany. |

## Artefakty i walidacja

Walidator sprawdza metadane authoringu oraz faktyczny
`eigen/diagnostics/solver.v1.json`. Jeżeli native publikuje cel tylko jako
`target_omega_rad_s`, jest on przeliczany na Hz przez $f=\omega/(2\pi)$ i
porównywany z jawnym celem. Brak celu native, rozbieżność celu, wartość
`window_complete=true` albo niezgodny rodzaj celu kończą walidację błędem.

`compare_de_100nm_pilot.py` może narysować punkt oraz krzywą referencyjną dla
porównania poglądowego, lecz raportuje `qualification=NOT VERIFIED` dla
selected-only. Nie jest to jeszcze relacja dyspersji: do tego potrzebny jest
pełny zestaw punktów, identyfikacja gałęzi oraz bramki zbieżności i fazy
Floqueta.

`collect_signed_de_bv_dispersion.py` przyjmuje osobny, jawnie oznaczony raport
`nearest-single-k`. Dla każdego punktu ponownie wiąże request i result z jobem,
modelem i kapsułą źródłową, odczytuje native target z diagnostics, sprawdza
residuum pełnego deskryptora oraz przechodzi przez kontrolę artefaktów siatki,
mesha i pola. Raport wymaga rzeczywistych punktów Γ oraz par `+k`/`-k` dla
obu geometrii, ale nie tworzy brakującego punktu przez odbicie.
Kolektor przyjmuje wyłącznie sześć przypadków w kolejności kontrolera, wiąże
pilot, geometrię i znak `k` z tą listą oraz porównuje oba pola targetu z
`nearest_targets_ghz` przypiętym w `controller-config.json`.

Konfiguracja przypina dokładny SHA256 kontrolera z `source/tree/scripts`
w kapsule joba. Kontroler jest uruchamiany z tej samej kapsuły przez
`python -B`, z jawnym `--repo-root` worktree podczas przygotowania konfiguracji.
Pozwala to zachować dokładne bajty LF kapsuły również na hoście Windows,
którego checkout może używać CRLF. Przed obserwacją joba i uruchomieniem
pilotów hash wykonywanego pliku musi być zgodny z hashem kapsuły; same
równoważne semantycznie końce linii nie są traktowane jako tożsamość bajtów.

`plot_de_bv_dispersion_comparison.py` przed rysowaniem ponownie sprawdza
selected-only receipt, metadata, native target i zgodność `full_residual` z
modelem. Punkty są rysowane z ich rzeczywistymi znakami k; etykieta
`FEM nearest (selected-only)` i raport `window_complete=false` nie sugerują
pełnego okna ani kwalifikacji dyspersji. Stary raport `signed-13` i archiwalne
raporty bez pola selected-only zachowują dotychczasową semantykę. Dla nowych
raportów referencja zachowuje `mu0_t_m_a` z modelu; dla archiwalnych rekordów
bez tego pola używa kanonicznej stałej `MU0`.
W świeżym selected-only raporcie `mu0_t_m_a` i raportowane
`external_induction_t` muszą dodatkowo zgadzać się z metadata tego samego
uruchomienia, zanim zostanie obliczone analityczne `B₀`; mutacja któregoś pola
kończy walidację.

Przygotowane testy interpretowane sprawdzają routing wszystkich rodzajów
pojedynczych próbek, odrzucenie wielopunktowej ścieżki, skończoność celu,
zgodność celu z native diagnostics i jawne oznaczenie selected-only. Testy
natywne, managed runtime oraz porównanie fizyczne pozostają `NOT VERIFIED`.

## Mapa źródeł

| Źródło | Odpowiedzialność |
|---|---|
| `examples/fem_de_smoke_numeric.py` | Mapowanie `target="nearest"` i celu Hz do stage authoringu. |
| `crates/fullmag-engine/src/lib.rs` | `MU0` — kanoniczna stała SI używana do kontroli metadata Γ. |
| `scripts/run_de_100nm_pilot.py` | Jawny wybór `spectral-target`, alias historyczny, request i artefaktowy preflight. |
| `scripts/run_nonzero_k_validation_controller.py` | Sześć kolejnych przypadków `nearest-single-k`, pinned targets dla Γ/±DE/±BV oraz kontrola zgodności wykonywanego i kapsułowanego źródła kontrolera. |
| `scripts/validate_de_smoke_rows.py` | Walidacja wierszy oraz faktycznych pól selected-only native diagnostics. |
| `scripts/compare_de_100nm_pilot.py` | Odczyt native rows, postsolve referencja analityczna i raport `NOT VERIFIED`. |
| `scripts/collect_signed_de_bv_dispersion.py` | Związanie sześciu rzeczywistych nearest Γ/±DE/±BV z kolejnością kontrolera, przypiętym targetem, requestem, modelem, siatką, residualem i receiptami. |
| `scripts/plot_de_bv_dispersion_comparison.py` | Ponowna kontrola selected-only przed wykresem, w tym związanie `mu0_t_m_a` i `external_induction_t` z metadata, oraz etykieta bez deklaracji pełnego okna. |
| `scripts/test_de_smoke_model.py` | Regression authoringu i odrzucenie niepoprawnych celów. |
| `scripts/test_run_de_100nm_pilot.py` | Regression CLI/routingu i metadata/native guard. |
| `scripts/test_validate_de_smoke_rows.py` | Regression artefaktów i targetu native. |
| `scripts/test_compare_de_100nm_pilot.py` | Regression rozpoznania aliasu selected-only. |
| `scripts/test_signed_de_bv_dispersion.py` | Regression agregacji rzeczywistych Γ/±k bez syntetycznego odbicia. |
| `scripts/test_plot_de_bv_dispersion_comparison.py` | Regression receiptu, native targetu, scope i residualu przed rysowaniem. |
| `scripts/test_nonzero_k_validation_controller.py` | Regression zgodności hashy mutable observera i immutable capsule. |

## Ograniczenia

Nie twierdzimy, że tryb nearest został wykonany w managed runnerze, że
native Floquet provider opublikował świeży wynik, ani że jeden punkt potwierdza
analitykę lub COMSOL. Te twierdzenia wymagają osobnych artefaktów runtime i
bramek naukowych.

(problem-statement)=
## Problem statement

Pełna relacja dyspersji wymaga wielu punktów k i identyfikacji ciągłych gałęzi.
Ten przyrost rozwiązuje węższy problem diagnostyczny: jawnie uruchomić solver
dla jednego k i wskazać mod położony najbliżej zadanego celu. Odróżnienie
tego artefaktu od kompletnego okna chroni porównanie przed traktowaniem
pojedynczej częstotliwości jak gotowej dyspersji.

(governing-equations)=
## Governing equations

Native solver zachowuje częstotliwość z wybranego modu i cel authoringu:

```{math}
:label: eq-de-smoke-omega-frequency
f_{\mathrm{target}}=\frac{\omega_{\mathrm{target}}}{2\pi}.
```

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka lub typ |
|---|---|---|
| $j_*$ | indeks modu najbliższego celowi | 1 |
| $f_j$ | częstotliwość j-tego modu | Hz |
| $f_{\mathrm{target}}$ | jawna docelowa częstotliwość | Hz |
| $\omega_{\mathrm{target}}$ | docelowa częstość kątowa native | rad s^-1 |

(assumptions-and-validity)=
## Założenia i ważność

Tryb wymaga jednego wektora k, skończonego dodatniego celu i zachowania
native diagnostics. Domyślny `frequency_window` nie zmienia się. Residual,
demag, warunek brzegowy i faza Floqueta są walidowane istniejącymi
kontraktami; wybranie modu nie usuwa żadnego z tych wymagań.

(python-api)=
## Python API

Przykład jest tylko authoringiem i nie uruchamia solvera:

```python
# %%
import fullmag as fm

# %%
study = fm.study("nearest-single-k")
study.engine("fem")
study.device("cpu", precision="double")

# %%
study.stages.add_eigenmodes(
    count=1, target="nearest", target_frequency=12.5e9,
    k_vector=(0.0, 2.0e6, 0.0), include_demag=True,
)
```

| Python | Typ | Domyślna | Jednostka | Walidacja | Znaczenie | Backend |
|---|---|---|---|---|---|---|
| --spectral-target | str | frequency_window | 1 | frequency_window\|nearest | modal target selection | FEM CPU diagnostic |
| --nearest-target-frequency-ghz | float | 10.0 | GHz | finite and positive | nearest modal target | FEM CPU diagnostic |

Opcje wrappera są mapowane odpowiednio do `EigenTargetIR` oraz
`EigenTargetIR.nearest.frequency_hz`; nie tworzą osobnego ProblemIR.

| Python | ProblemIR |
|---|---|
| --spectral-target | EigenTargetIR |
| --nearest-target-frequency-ghz | EigenTargetIR.nearest.frequency_hz |

(problem-ir)=
## ProblemIR i provenance

Wrapper zapisuje `requested intent` jako `spectral_target`,
`target_frequency_hz` i pojedynczy sampling. `resolved execution` native jest
widoczne w `solver.v1.json` jako `target_kind`, rzeczywisty cel kątowy oraz
`spectrum_completeness`. Nie zmieniamy publicznego ProblemIR ani digestu
modelu; opcje diagnostyczne są mapowane do istniejących pól stage.

(round-trip-and-failure-semantics)=
## Round-trip i failure semantics

`validation errors` odrzucają cel niedodatni, niekońcowy albo żądanie dla
więcej niż jednego k. `unsupported combinations` pozostają błędem wrappera;
nie ma cichego fallbacku do okna. Wartość native nieobecna lub rozbieżna z
requestem kończy preflight błędem. `requested intent` i `resolved execution`
pozostają rozdzielone także dla aliasu `de-smoke-nearest-k2`.

(discrete-realization)=
## Realizacja dyskretna

Wszystkie single-k próbki z `PILOTS` są routingowane przez ten sam przykład
modelu. Native publikuje jeden wiersz CSV i jeden tryb w `spectrum.v3.json`;
walidator porównuje je z `solver.v1.json`. `target_omega_rad_s` jest tylko
reprezentacją tego samego celu w SI, a nie nowym źródłem częstotliwości.

(implementation-mapping)=
## Mapowanie na kod

- `examples/fem_de_smoke_numeric.py::MODAL_TARGET` i
  `study.stages.add_eigenmodes` — authoring trybu nearest.
- `scripts/run_de_100nm_pilot.py::_modal_selection` — bezpieczny routing
  aliasu i jawnej opcji CLI.
- `scripts/validate_de_smoke_rows.py::validate_selected_only_diagnostics` —
  odczyt native diagnostics.
- `scripts/compare_de_100nm_pilot.py::load_comparison_input` — postsolve
  walidacja oraz referencja analityczna.

(validation)=
## Walidacja

Wykonano interpretowane regresje wrappera, modelu, walidatora i porównania.
Nie kompilowano testów natywnych, nie uruchamiano managed runnera i nie ma
świeżego wyniku native dla tej zmiany. Status runtime i kwalifikacji
fizycznej pozostaje `NOT VERIFIED`.

(limitations)=
## Ograniczenia

Selected-only nie jest pełnym oknem ani relacją dyspersji. Referencja n=0
może być rysowana wyłącznie po odczycie częstotliwości native i nie jest
źródłem danych solvera. Zbieżność siatki, airboxu, liczby modów, residuali i
zgodność z COMSOL-em wymagają oddzielnych bramek.

(scientific-bibliography)=
## Bibliografia naukowa

1. Y. Kalinikos i A. Slavin, *Theory of dipole-exchange spin wave spectrum
   for ferromagnetic films with arbitrary surface pinning*, J. Phys. C 19,
   7013 (1986), DOI:10.1088/0022-3719/19/35/7013.
2. V. Hernandez et al., *SLEPc: A Scalable and Flexible Toolkit for the
   Solution of Eigenvalue Problems*, ACM TOMS 31(3), 2005.

(source-code-index)=
## Indeks źródeł

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| examples/fem_de_smoke_numeric.py | MODAL_TARGET | Authoring celu modalnego. |
| scripts/run_de_100nm_pilot.py | _modal_selection | Routing single-k i walidacja celu. |
| scripts/run_nonzero_k_validation_controller.py | validation_cases | Sześć rzeczywistych przypadków nearest Γ/±DE/±BV wykonywanych sekwencyjnie; źródło wykonywane i kapsuła muszą mieć ten sam hash. |
| scripts/run_nonzero_k_validation_controller.py | selected_only_arguments | Przekazanie pinned shiftu bez używania go jako wyniku częstotliwości. |
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | void write_production_schur_diagnostics | Publikacja native targetu i selected-only statusu. |
| scripts/validate_de_smoke_rows.py | validate_selected_only_diagnostics | Sprawdzenie native JSON. |
| scripts/compare_de_100nm_pilot.py | load_comparison_input | Selected-only i postsolve analityka. |
| scripts/collect_signed_de_bv_dispersion.py | collect_selected_only | Związanie sześciu nearest Γ/±DE/±BV z kolejnością, pinned targetem, receiptami i artefaktami. |
| scripts/plot_de_bv_dispersion_comparison.py | validate_selected_only_record | Ponowna kontrola selected-only przed wykresem, w tym `mu0_t_m_a` i `external_induction_t` względem metadata. |
| scripts/test_de_smoke_model.py | test_nearest_single_k_target_is_explicitly_selected_only | Regression authoringu. |
| scripts/test_run_de_100nm_pilot.py | test_nearest_pilot_is_single_k_selected_only_and_fail_closed | Regression wrappera. |
| scripts/test_validate_de_smoke_rows.py | test_selected_only_native_diagnostics_require_exact_target | Regression native contract. |
| scripts/test_compare_de_100nm_pilot.py | test_nearest_alias_is_selected_only_and_validates_native_contract | Regression porównania. |
| scripts/test_signed_de_bv_dispersion.py | test_nearest_collector_keeps_actual_gamma_and_signed_samples_without_reflection | Regression agregacji bez odbicia. |
| scripts/test_plot_de_bv_dispersion_comparison.py | test_plot_selected_only_rechecks_native_target_and_scope | Regression receiptu i targetu przed wykresem. |
| scripts/test_nonzero_k_validation_controller.py | test_execution_rejects_modified_controller_before_running_pilots | Regression hashy wykonywanego kontrolera i kapsuły. |
