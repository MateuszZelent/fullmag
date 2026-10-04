# Przyrost 40 — evaluator różnicy przypiętych wycinków

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod i nota naukowa: `1cd01d25f34c689219b084c91c965e7c48d06efb`, opublikowany na remote master.

## Wynik

`fullmag-quantities::dataset_difference` rzeczywiście odejmuje lewy operand
minus prawy, zachowując F32/F64, real/imaginary, harmonic convention i jednostki.
Wynik ma oddzielne little-endian bytes oraz receipt obu przypiętych źródeł
i hashy nowych płaszczyzn. `output_semantics=unnormalized_signed_difference`
zapobiega utożsamianiu wyniku z normalizacją operandów.

Przed decode wymagane są poprawne requesty, SHA manifestów i DatasetFieldDescriptor,
Ready + Quantitative, zgodne pola semantyczne, dokładny layout, zakres, shape
i precyzja. Checksum dotyczy rzeczywistych zakresów. Input NaN/Inf i overflow
wyniku są błędami. Brak danych, preview i niezgodne units/layout nie stają
się zerem. Sam receipt projekcji nie odblokowuje odejmowania innych przestrzeni.

Session adapter `compare_tensor_dataset_slices` łączy evaluator z istniejącym
zweryfikowanym odczytem CAS. Wymaga element-major `[elements, components]`
albo scalar `[elements]`, zgodnych logical axes obu operandów i planes.
Transpozycja oraz ByComponent są odrzucane przed odczytem CAS.

## Limity i trust boundary

- Output ma najwyżej istniejące 64 MiB; aggregate budget liczy dwa surowe
  inputy, dwa decoded inputy i output, czyli `5 × payload`.
- Przed odczytem CAS adapter rezerwuje konserwatywnie dwa razy sumę budżetów
  inputów plus maksymalny output. To nie jest pomiar RSS ani limit całego I/O:
  checksum CAS może streamować cały obiekt.
- Typed JSON SHA jest streamowany z limitem 4 MiB per manifest/descriptor.
  Comparison adapter dopuszcza najwyżej 16384 chunks per plane.
- Samodzielny publiczny `read_tensor_dataset_slice` nadal ma otwartą granicę
  liczby chunków/metadanych; ten przyrost nie zalicza całego P6-C.
- Hash TensorDescriptor jest guardem kosztu serializacji, bez expected digest.
  Caller musi rozwiązać dataset→tensor z zaufanego katalogu/materializera.
  Przypięcie samego requestu i checksum nie dowodzi właściciela datasetu.

Nie publikuje się nowego MaterializedDataset, CAS ani API. Receipt wejścia
nie zostaje podmieniony na manifest outputu. Nie uruchamia się solve, rekonstrukcji
modalnej, projekcji ani renormalizacji. Publiczny materializer/API/consumer UI
pozostaje wymaganym następnym krokiem, a nie wykonanym elementem tego przyrostu.

## Dowody

| Bramka | Wynik |
|---|---|
| Finalna kontrola produkcyjnych źródeł API/session/quantities | PASS, exit 0, `source_changed_during_run=false` |
| Niezależny ograniczony source review evaluatora i noty | PASS w zakresie przyrostu; otwarte P2 readera zapisane powyżej |
| Parser Rust/rustfmt oraz staged diff | PASS |
| Focused scientific source-map validator | PASS |
| Validator changed scientific docs od poprzedniego HEAD | PASS |
| 32 istniejące testy kontraktu walidatora dokumentacji Python | PASS, wykonywane z `-B`, bez kompilacji testów Rust |
| Samodzielny przykład referencyjny Python w nocie | PASS; nie jest dowodem działania Rust evaluatora |
| Nowe regresje Rust | NOT COMPILED / NOT RUN |
| Managed runtime, browser, CAS publication i peak RAM | NOT VERIFIED |

Finalny receipt:
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/c37d8e0bbd154df8858a593c7884769e/receipt.json`.

Wcześniejszy source check `666e1046b913469285b4bcd6401c002a` miał exit 0,
lecz wykrył zmianę źródeł podczas dopisywania regresji: **source_changed**.
Nie użyto go jako dowodu finalnego przyrostu. Późniejszy stabilny check został
ponowiony po poprawkach review. Kontrole pochodzą ze współdzielonego dirty
checkoutu; nie dowodzą kwalifikacji czystego remote pakietu.

Regresje obejmują signed difference, F32 complex, stale revision/digest/checksum,
unit/layout/preview/unavailable, payload/working budgets, nonfinite/overflow,
brak renormalizacji outputu, serializację metadanych oraz transpose/mixed planes
i chunk limit adaptera. Aktualny zakaz kompilacji jednostkowej nadal obowiązuje.

Nota i mapa źródeł:
`docs/physics/0990-pinned-dataset-field-difference.md` oraz odpowiadający source-map;
indeks posiada linki przypięte do pełnego commita kodu.

## Następne wymagane kroki

1. Zaufany durable resolver dataset→tensor, evaluator/materializer i publikacja
   wyniku z pełną provenance i integralnością CAS.
2. Publiczne comparison API i generated client, bez aktywnej sesji i implicit solve.
3. PlotDefinition/export recipes oraz porównania w istniejącym interfejsie.
4. Wykonane regresje po odwołaniu zakazu, managed receipts, RAM i browser proof.

Nie uruchamiano kolejnego ciężkiego buildu ani nie usuwano danych storage.
Ponowny odczyt runnera 30.09.2026: `worker_alive=true`, `accepting_jobs=true`,
`worker_error=null`, brak aktywnych jobów i `storage_free_bytes=1752481792`
(około 1,63 GiB), poniżej guard 8 GiB. Joby
`a5b88dbd27414615ae44413357d542b7` oraz `106c264dfe954e6b816a7811bbde2d4b`
pozostają queued, bez exit code. Nie jest to dowód bieżącego runtime.
