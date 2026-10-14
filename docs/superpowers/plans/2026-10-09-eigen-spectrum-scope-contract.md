# Kontrakt spectrum_scope — propozycja naprawy #4060116242

Stan na 11.10.2026: użytkownik wybrał wariant 1: osobno adresowalne per_sample oraz global jako kolekcja całego sweepa. Decyzja semantyczna jest przyjęta; lowering, publikacja, zasoby i wykonanie pozostają **NOT VERIFIED**. Nie jest to dowód wdrożonego nowego kontraktu API.

## Obecna luka

Publiczny `SaveSpectrum` w `packages/fullmag-py/src/fullmag/model/outputs.py` akceptuje `global` i `per_sample` (default), a `world.py::save` przekazuje `spectrum_scope`. Eksport skryptu zachowuje global i pomija wartość domyślną. Aktywny `OutputIR::EigenSpectrum` w `crates/fullmag-ir/src/study.rs` przechowuje tylko quantity. V03 gubi pole; strict `OutputV04Wire` w `v04_spectral_wire.rs` odrzuca je. Osobne `EigenSpectrumScopeIR`/`EigenSpectrumOutputIR` nie są aktywną ścieżką.

Obecny artefakt v2/v3 ma jedną kolekcję `samples[]`. Specyfikacje frequency-domain artifacts/product projection i nota0831 nie definiują normatywnej różnicy scope. Nie wystarczy zachować dodatkowe pole IR i uznać naprawy za kompletną.

## Dwie rozważane semantyki

1. **Osobno adresowalne per_sample + kolekcja global (propozycja zalecana):** global publikuje widmo całego badania jako kolekcję niezależnych próbek. Per_sample publikuje widma próbek z uporządkowanym indeksem i stabilnymi IDs. Scope opisuje publikację, nie zmianę operatora ani jedno wspólne rozwiązanie dla różnych k/pól.
2. **Grupowanie w jednym zasobie:** oba zakresy pozostają jednym resource, ale różnica jest jawnie zdefiniowana w jego projekcji i konsumentach. Zawartość fizyczna i tożsamość próbek pozostają identyczne.

Odpowiedź użytkownika z 11.10.2026: „Zalecane: per_sample daje osobno adresowalne widmo każdego k; global daje kolekcję całego sweepa.” Wariant 2 nie został wybrany. Kolejny krok implementacyjny obejmuje scoped ADR/spec, wersjonowany shape zasobów i całą ścieżkę. Dotychczasowych artefaktów nie migrujemy ani nie klasyfikujemy retroaktywnie na podstawie samej kolekcji samples[].

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


## Aktualna lokalizacja utraty i wdrozenie - 12.10.2026

SaveSpectrum.to_ir emituje scope; OutputIR::EigenSpectrum ma tylko quantity i serde ignoruje authored scope. To nie jest argument native ModalEigenRequest. Zgodnie z0600, k pozostaje parametrem osobnego operatora; scope nie zmienia fizyki/damping/residual ani nie agreguje czestotliwosci.

Etap1 przywraca typed intent w IR: optional enum per_sample/global, brak pola w historicalwire pozostaje omission z efektywnym defaultper_sample. Unknown explicit value musi byc odrzucona. Callers tylko mechanical preservation; nigdy nie przepisac global na default przy rekonstrukcji OutputIR. PublicPython juzpoprawny, nativeABI bez zmian.

Etap2 przenosi scope przez outputs selection i writer do distinct spectrum_output_scope w manifest. Nie kolidowac z Poisson certificate spectrum_scope=selected. V3 pozostaje nieusredniona kolekcja; per_sample wskazuje istniejace sample_id resource addresses, global adres kolekcji. Etap3: API/UI wybieraja zasob wedlug authored scope przez istniejacy typowany ResultsAPI; brak nowych bocznych fetch/endpoints. Etap4: actualPython->Rustparse->writer->manifest->Resultsresource regression, hostedRust+UI+browser proof. Sama metadata nie zamyka4060116242.

Wszystkie etapy sa autoryzowana realizacja zaakceptowanej decyzji uzytkownika; sourcefoundation nie jest pelnym wdrozeniem ani kwalifikacja naukowa.


### Korekta adaptera0.4 i deduplikacji

CI38243351489 wykryl brak fieldscope w Self::EigenSpectrum w v04_spectral_wire. Ten adapter strict deny_unknown_fields, wiec przed naprawa scope w0.4 byl odrzucany, nie po cichu ignorowany jak w legacySerde. Dodano typed optional scope takze OutputV04Wire i bezstratne przekazanie doOutputIR. Regresje obejmuja standalone/root wszystkich5studytypow, historyczne omission, obie scope i malformed/selected/per_run rejection. Testy0.3 same nie byly wystarczajaca bramka.

Planner deduplikacja quantity-only nie pozwalala dwom scope dotrzec dowritera. Klucz teraz uwzglednia effective scope: per_sample+global legalne, None+explicitper_sample nadalduplicate, global+global duplicate. ActualProblemIR->plan->ExecutionPlanIR roundtrip zachowuje oba authoredoutputs. Nie oznacza to jeszcze writer/API/UI wdrozenia.


### Kanoniczny typ zakresu — korekta po CI 38245737002

Kompilacja wykazała duplikat `EigenSpectrumScopeIR` w `study` i `eigen_contract`. OutputIR i adapter 0.4 korzystają teraz z istniejącego typu `eigen_contract::EigenSpectrumScopeIR`, wspólnego również z wcześniejszym kontraktem eigensolve. Dodano default `PerSample` na kanonicznym typie; nie zmieniono nazw wire ani intencji authoringu. Usunięto drugi enum zamiast wprowadzać konwersje między identycznymi typami. Weryfikacja wykonania testów pozostaje pending do nowego CI.


### Etap 2 — zakresy żądane w manifestach producentów

Wspólny resolver zbiera zakresy wyłącznie z rzeczywistych `EigenSpectrum` outputs. Legacy omission daje `per_sample`; dwa zakresy są zachowane w stabilnej kolejności. Manifesty generic, native single-k i native path otrzymują addytywne `spectrum_output_scopes`. Pusta lista oznacza brak jawnego żądania spektrum, nawet gdy dyspersja potrzebuje pomocniczego artefaktu widma. Certyfikat numeryczny `spectrum_scope=selected`, selekcja modów i ABI pozostają odrębne.

Regresje uruchamiane wyłącznie w GHA sprawdzają resolver, rzeczywistych trzech producentów, identyfikatory próbek niezerowego k, niezmienione ścieżki modów i bajty artefaktów single-k. Stan: implementacja źródłowa; wynik nowego CI pending. To nie zamyka obsługi API/UI ani komentarza 4060116242; osobno adresowalne zasoby per_sample i kolekcja global wymagają następnego etapu.


### Pełna bramka planera — GHA 38246536065

Kompilacja zakresów i oba named wire tests przeszły. Pełny planner: 522 PASS, 2 FAIL. Obydwie porażki były w istniejących fixture’ach: unknown StudyStepKind podawał scalar zamiast kanonicznego tagged object, a test zakazu łączenia synthetic K0 z dispersion_validation miał tylko dwie próbki scenariusza, więc zatrzymywał się na wcześniejszym wymaganiu co najmniej trzech. Skorygowano wejścia testowe, zachowując produkcyjne reguły i dokładne wymaganie docelowego odrzucenia; dodano pełne reasons do komunikatu failure. Nowy pełny CI pending; wynik nie stanowi kwalifikacji fizycznej.


### Bramka integracyjna CLI — GHA 38247247461

Po korekcie fixture’ów pełne IR/planner/application/runner oraz named scope producers przeszły. Końcowy cargo check API/CLI zatrzymał się na istniejących referencjach `fullmag_quantities` w CLI bez direct dependency manifestu. Dodano istniejący crate workspace do manifestu i wyłącznie odpowiadającą zależność lockfile pakietu CLI. Brak aktualizacji wersji lub nowych pakietów; lokalny lockfile zachowano, zdalny zaktualizowano względem dokładnego rodzica. Nowy pełny CI pending; API/UI semantyka zakresów oraz kwalifikacja naukowa wciąż niezamknięte.
