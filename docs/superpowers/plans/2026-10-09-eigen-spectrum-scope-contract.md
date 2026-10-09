# Kontrakt spectrum_scope — propozycja naprawy #4060116242

Stan: diagnoza źródłowa potwierdzona; wybór semantyki oczekuje na odpowiedź użytkownika. Implementacja i wykonanie **NOT VERIFIED**. Nie jest to przyjęty nowy kontrakt API.

## Obecna luka

Publiczny `SaveSpectrum` w `packages/fullmag-py/src/fullmag/model/outputs.py` akceptuje `global` i `per_sample` (default), a `world.py::save` przekazuje `spectrum_scope`. Eksport skryptu zachowuje global i pomija wartość domyślną. Aktywny `OutputIR::EigenSpectrum` w `crates/fullmag-ir/src/study.rs` przechowuje tylko quantity. V03 gubi pole; strict `OutputV04Wire` w `v04_spectral_wire.rs` odrzuca je. Osobne `EigenSpectrumScopeIR`/`EigenSpectrumOutputIR` nie są aktywną ścieżką.

Obecny artefakt v2/v3 ma jedną kolekcję `samples[]`. Specyfikacje frequency-domain artifacts/product projection i nota0831 nie definiują normatywnej różnicy scope. Nie wystarczy zachować dodatkowe pole IR i uznać naprawy za kompletną.

## Dwie rozważane semantyki

1. **Osobno adresowalne per_sample + kolekcja global (propozycja zalecana):** global publikuje widmo całego badania jako kolekcję niezależnych próbek. Per_sample publikuje widma próbek z uporządkowanym indeksem i stabilnymi IDs. Scope opisuje publikację, nie zmianę operatora ani jedno wspólne rozwiązanie dla różnych k/pól.
2. **Grupowanie w jednym zasobie:** oba zakresy pozostają jednym resource, ale różnica jest jawnie zdefiniowana w jego projekcji i konsumentach. Zawartość fizyczna i tożsamość próbek pozostają identyczne.

Użytkownik otrzymał pytanie o ten wybór. Brak odpowiedzi nie jest zgodą na zmianę publicznej semantyki. Dopiero wybór pozwoli ustalić minimalny scoped ADR/spec, shape/version resource i zaimplementować całą ścieżkę.

## Wspólne niezmienniki

- Zachować `sample_id`, `sample_index` i `mode_id`; global nie scala numerycznie różnych operatorów.
- Zakres obejmuje K-sampling i bias-field sweep. Single-sample zachowuje requested scope nawet przy tej samej zawartości.
- Domyślnie per_sample dla brakującego pola nowego IR, zgodnie Pythonem. Jawne null/unknown/wrongtype odrzucić. Historycznych artefaktów bez scope nie klasyfikować retroaktywnie na podstawie `samples[]`.
- Scope nie implikuje branch tracking, dispersion ani obliczeń dodatkowych modów. Requested output intent i resolved publication shape są provenance outputów, nie etykietą solver execution.
- Zachować istniejące fences owner/run/sample i generacji artefaktów. Nowy zakres nie uzasadnia trusted cross-file join po samej ścieżce ani po niezweryfikowanych historycznych plikach; #4225198873 pozostaje osobnym obowiązkiem.
- Duplikaty i mieszane żądania scope wymagają jednoznacznej reguły kolizji w spec; nie odrzucać dotychczasowych legalnych outputs bez ustalenia tego kontraktu.

## Cała powierzchnia zmiany

Python authoring/output/script round-trip; aktywny V03/V04 i planner OutputPlanIR; `eigen::output_selection`; generic `eigen/artifacts/modal_manifest.rs`; FEMpath `fem/eigen_path.rs` i manifest; native `fem/eigen_native_artifacts.rs`; reference `fem/eigen_execution.rs`; bias-field `fem/eigen_sweep.rs::merge_bias_field_sweep_runs`; API frequency-domain spectrum resources, DTO/OpenAPI/generated types i resource hooks; `frequencyDomainChartModels` oraz Inspector.

Obecny manifest zawiera pojedyncze spectrum_v2_path/resource_key. W wariancie osobnych próbek trzeba zdefiniować jawny indeks i próbko-specyficzne odczyty, zachowując czytelność istniejącej kolekcji. Nie zmieniać znaczenia v2/v3 po cichu.

## Weryfikacja wyłącznie GitHub Actions

V03/V04 default i obie wartości, invalid/null rejection, Python atomicity i skrypt round-trip, plan retention, legalne mieszane outputs, real global/per-sample writers dla co najmniej dwóch próbek, single-k native/reference i bias-field; indeks/manifest membership/stable order/identity; API resource i Inspector/chart model; wymagany browser proof zmiany zachowania UI. Sukces fixture lub źródłowego parsera nie kwalifikuje dyspersji fizycznie.
