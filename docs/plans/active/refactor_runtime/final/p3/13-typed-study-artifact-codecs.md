# P3-B — wersjonowane kodeki artefaktów study

Data: 25.09.2026. Ten przyrost dodaje wąską, fail-closed obsługę dwóch typów
wyników. Nie uruchamia jeszcze accepted tasków w supervisorze i nie dowodzi
wykonania solvera.

## Obsługiwane formaty

`state` i `initial_state` przyjmują wyłącznie
`fullmag.runner.field_json@v1`. Dekoder wymaga końcowego pola `m` w jednostce
`1`, skończonych wektorów trójskładowych, czasu i `solver_dt`, obiektu
provenance oraz `state_identity` wiążącego backend, SHA-256 serializowanego
layoutu i liczbę próbek. Layout FDM musi identyfikować grid, origin i dodatni
cell size oraz zgadzać liczbę komórek z próbkami. FDM multilayer wymaga
ciągłych offsetów, pełnych zakresów próbek i fingerprintu każdej siatki
warstwy. FEM v1 obsługuje tylko H1 P1, gdy liczba próbek równa się liczbie
węzłów, a layout zawiera fingerprint topologii. Inne obserwable, siatki bez
identyfikatora, FEM P2 i nieznane backendy są odrzucane.

`scalar` przyjmuje wyłącznie `fullmag.study.scalar_json@v1` z envelope
`study_scalar.v1`: `quantity_id`, jednostką, skończoną wartością w SI,
numerem kroku i nieujemnym czasem. Payload nie interpretuje fizyki ani
nie konwertuje jednostek; producent deklaruje już wartość SI.

Wszystkie pozostałe typy (`field`, `table`, `mesh`, `operator`, `artifact`,
`run_record`) pozostają bez zarejestrowanego codec i nie mogą wejść do
typowanego `StepOutput`.

## Granice walidacji

- `ResolvedStudyArtifact::validate` dopuszcza wyłącznie dokładne pary
  data kind/codec/version zarejestrowane w `fullmag-application`.
- `publish_study_outputs` dekoduje cały deklarowany zestaw bajtów przed
  pierwszym zapisem do CAS. Błędny późniejszy payload nie zostawia wcześniej
  poprawnego payloadu w CAS ani wpisu katalogu.
- Bariera `Completed` ponownie pobiera dokładne bajty z CAS i dekoduje je
  względem referencji manifestu; sama obecność pliku nie wystarcza.
- Resolver `StepOutput` dekoduje wybrany CAS object przed dołączeniem typed ref
  do wejścia następnego taska. Oryginalne bajty i ich digest pozostają
  niezmienne.
- Runner emituje `state_identity` dla `m_initial` i `m_final` oraz zapisuje
  fingerprint siatki/topologii w layoutach, jeśli producent ma odpowiedni
  certyfikat.

Dekoder na granicy aplikacji/runtime-control sprawdza strukturę i tożsamość
payloadu. Nie weryfikuje jeszcze zgodności przestrzeni źródłowej z preparation
następnego solvera ani mapowania/interpolacji między różnymi dyskretyzacjami.
To wymaga adaptera workera i osobnego, jawnego kontraktu transferu stanu.

## Dowody i ograniczenia

`just verify-project-application` przeszedł (run
`c7561e2eeb2c4f7d8a3df54e8afb4292`), obejmując testy dekodera i fail-closed
rejestru. `just verify-api-project-runs` przeszedł (run
`867f9153c9714377a8b3210be8806d77`): syntetyczne FDM State i SI Scalar są
publikowane, zdekodowane przed ukończeniem, a publikacja z poprawnym pierwszym
wynikiem i błędnym drugim nie przypina pierwszego wyniku do CAS.
`just check-api-source` przeszedł (run
`7dc2d9e1051341728613ed0b69b6d536`).

Test producenta w `fullmag-runner::artifacts` sprawdza layout fingerprint i
`sample_count`, ale pozostaje **NOT RUN**. `just runner-doctor` wykazał aktywny
kontener BuildKit i politykę `defer-existing-workload`; `just runner-list`
zakończył się `Container profile allow-list mismatch`. Nie uruchomiono
równoległego ani hostowego fallbacku. Zmiana runnera i jej managed build są
więc **NOT VERIFIED**.

Nadal brakuje supervisor/workera, który odtworzy zaakceptowany plan i
preparation, odczyta CAS na granicy runnera, dostarczy zdekodowane wejście,
jawnie opublikuje output allow-listę i dopiero potem wyemituje `Completed`.
Potrzebne są też testy cross-space transferu oraz runtime/physics proof dla
każdej wspieranej realizacji FDM/FEM CPU/GPU. Nie należy na podstawie tego
przyrostu twierdzić, że study wykonuje solver end-to-end.
