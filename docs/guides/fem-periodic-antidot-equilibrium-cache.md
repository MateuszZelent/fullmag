# Trwały stan równowagi dla okresowej warstwy z otworem

## Cel

Relaksacja FEM dla okresowej warstwy Permalloy z otworem jest kosztownym etapem przygotowawczym. Po zakończeniu relaksacji można przygotować jawny, zahashowany cache stanu magnetycznego i używać go w kolejnych obliczeniach widma, odpowiedzi częstotliwościowej i dynamiki. Cache nie jest anonimowym snapshotem: wiąże stan z konkretną siatką, topologią, scenariuszem i kryterium momentu.

## Przygotowanie cache

Źródłem musi być raport z ukończoną relaksacją, zawierający `workspace-history/session-*/stages/stage_00_flat_relax`. Nie wolno przygotowywać cache z raportu, którego relaksacja nie spełniła własnego progu `tolT`. Producent akceptuje wyłącznie jednoznaczny certyfikat momentu: `status=completed`, `converged=true`, `stop_reason=torque`, `stop_metric_kind=max_torque_apm`, `stop_metric_unit=A/m`, skończone `stop_metric_value <= stop_threshold` oraz zgodność `stop_metric_value` z `final_torque_apm` i progu z autorskim `equilibrium_torque_tolerance_a_per_m`. Zakończenie przez limit kroków, czas, anulowanie, błąd backendu albo metrykę energii nie może utworzyć tego cache.

```bash
python3 scripts/prepare_fem_periodic_antidot_equilibrium_cache.py \
  /zfn2/mateuszz/git/fullmag/reports/fem-periodic-antidot-relax-eigenmodes/nearest \
  /zfn2/mateuszz/git/fullmag/reports/fem-periodic-antidot-relax-eigenmodes/reusable-equilibrium
```

Skrypt zapisuje:

- `domain_mesh.json` — dokładnie tę samą siatkę shared-domain, bez ponownego wywołania Gmsh,
- `equilibrium_m.json` — pełny wektor `m` w kolejności węzłów domeny, dla eigensolve z importowaną siatką,
- `magnetic_m.json` — tylko węzły magnetyczne, dla niezależnych etapów dynamiki/odpowiedzi,
- `manifest.json` — wersję schematu, pełny kontrakt zakończenia, fingerprint siatki, liczbę węzłów, próg i końcowy torque, SHA-256 każdego artefaktu oraz kanoniczną tożsamość cache.

Schemat `fem_periodic_antidot_equilibrium_cache.v2` zapisuje tożsamość źródła jako `fem_periodic_antidot_equilibrium_identity.v1`. Wiąże ona hash źródłowego `ProblemIR`, pełnego planu wykonania, kontraktu materiałów/statycznej fizyki/warunków brzegowych, zawartości siatki, indeksowania węzłów i rejestru części. `cache_identity_sha256` jest deterministycznym hashem całego manifestu wraz z hashami artefaktów. Loader najpierw sprawdza tę tożsamość, potem SHA-256 plików, a następnie ponownie wylicza tożsamość zawartości `domain_mesh.json` i indeksowania. Mutacja jednego pola albo pliku bez spójnego odtworzenia całego cache jest błędem fail-closed.

`--force` jest wymagane do zastąpienia niepustego katalogu cache. Nie należy nadpisywać cache bez sprawdzenia, że zmiana była zamierzona.

## Eigensolve K0

W kolejnym uruchomieniu ustaw jeden jawny katalog cache:

```bash
FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE=/workspace/reusable-equilibrium \
FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE=cpu \
fullmag-fem-gpu-bin examples/fem_periodic_antidot_relax_eigenmodes.py \
  --backend fem --mode strict --precision double --headless --json
```

Kontener musi zamontować katalog cache jako `/workspace/reusable-equilibrium`. Program sprawdza manifest i SHA-256 przed zbudowaniem `ProblemIR`. Podanie cache razem z pojedynczymi zmiennymi `FULLMAG_PERIODIC_ANTIDOT_EIGEN_DOMAIN_MESH` lub `FULLMAG_PERIODIC_ANTIDOT_EIGEN_EQUILIBRIUM_STATE` jest błędem — wybór źródła ma być jednoznaczny.

Stage `flat_relax` pozostaje w pipeline jako jawna kontrola kryterium i
certyfikowany handoff do operatora. Obecny cache jest bezpiecznym warm-startem:
nie gwarantuje pominięcia całego stage'u i nie zastępuje
`AcceptedFemRelaxStageHandoff.v3`. Przy zgodnym cache solver może wykonać krótką
korektę numeryczną, jeżeli po odtworzeniu operatora końcowy torque jest inny.
Całkowite pominięcie relaksacji wymaga osobnego, certyfikowanego handoffu
wiążącego pola, siatkę, materiały, statyczną fizykę, warunki brzegowe i
autorski próg zatrzymania.

## Odpowiedź częstotliwościowa i dynamika

Skrypt `fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py` może użyć tego samego cache w trybie `response`:

```bash
FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE=response \
FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE=/workspace/reusable-equilibrium \
fullmag-fem-gpu-bin examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py \
  --backend fem --mode strict --precision double --headless --json
```

W tym trybie ładowany jest `magnetic_m.json`, a etap relaksacji nie jest dodawany.
Gdy źródłem jest pełny cache, przykład przekazuje również `domain_mesh.json` do
`study.domain_mesh(...)`; `study.build_domain_mesh()` nie jest wywoływane dla tej
ścieżki. Dzięki temu response korzysta z tego samego shared-domain assetu, a nie
z nowej siatki Gmsh. To jest dozwolone wyłącznie wtedy, gdy bieżący problem ma tę
samą geometrię, materiały, PBC, shared-domain topology i kolejność węzłów.
Zmiana rozmiaru elementu, domeny powietrznej, materiału, pola bias lub warunków
brzegowych wymaga nowej relaksacji i nowego cache; nie wolno interpolować tego
stanu po cichu.

Tożsamość v1 jednoznacznie opisuje źródło i umożliwia porównanie z bieżącym
problemem, ale sam loader pliku nie ma jeszcze obiektu docelowego `ProblemIR`.
W ścieżce eigensolve zgodność docelowego operatora pozostaje wymuszana przez
`AcceptedFemRelaxStageHandoff.v3`. W ścieżce `response`, która pomija relaksację,
automatyczne porównanie wszystkich sygnatur źródło–cel pozostaje osobną bramką;
do jej zamknięcia cache wolno stosować wyłącznie dla dokładnie tego samego,
wersjonowanego fixture i należy porównać zapisane sygnatury w walidatorze CI.

## Bramka reprodukowalności

Przed użyciem cache w teście produkcyjnym należy zachować w raporcie:

1. `manifest.json` wraz z `cache_identity_sha256`, pełnym `completion` i `identity`,
2. `mesh_generation_id` i `topology_fingerprint` z raportu źródłowego i wynikowego,
3. końcowy `max_torque_apm` oraz authored `stop_threshold`,
4. `equilibrium_source` w podsumowaniu eigensolve lub `provided` w odpowiedzi częstotliwościowej,
5. informację, że Gmsh nie został uruchomiony ponownie dla etapu wykorzystującego cache.

Cache przyspiesza przygotowanie dynamiki, ale nie obniża wymagań kwalifikacyjnych operatora: residual widma i poprawność pól modów nadal muszą przejść pełne bramki artefaktów.
