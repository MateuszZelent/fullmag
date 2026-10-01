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
| `scripts/validate_de_smoke_rows.py` | Walidacja wierszy oraz faktycznych pól selected-only native diagnostics. |
| `scripts/compare_de_100nm_pilot.py` | Odczyt native rows, postsolve referencja analityczna i raport `NOT VERIFIED`. |
| `scripts/test_de_smoke_model.py` | Regression authoringu i odrzucenie niepoprawnych celów. |
| `scripts/test_run_de_100nm_pilot.py` | Regression CLI/routingu i metadata/native guard. |
| `scripts/test_validate_de_smoke_rows.py` | Regression artefaktów i targetu native. |
| `scripts/test_compare_de_100nm_pilot.py` | Regression rozpoznania aliasu selected-only. |

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
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | void write_production_schur_diagnostics | Publikacja native targetu i selected-only statusu. |
| scripts/validate_de_smoke_rows.py | validate_selected_only_diagnostics | Sprawdzenie native JSON. |
| scripts/compare_de_100nm_pilot.py | load_comparison_input | Selected-only i postsolve analityka. |
| scripts/test_de_smoke_model.py | test_nearest_single_k_target_is_explicitly_selected_only | Regression authoringu. |
| scripts/test_run_de_100nm_pilot.py | test_nearest_pilot_is_single_k_selected_only_and_fail_closed | Regression wrappera. |
| scripts/test_validate_de_smoke_rows.py | test_selected_only_native_diagnostics_require_exact_target | Regression native contract. |
| scripts/test_compare_de_100nm_pilot.py | test_nearest_alias_is_selected_only_and_validates_native_contract | Regression porównania. |
