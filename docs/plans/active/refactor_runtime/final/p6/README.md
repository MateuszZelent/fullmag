# Checkpoint P6 — trwałe wyniki i frontend analityczny

Status: **P6 IN PROGRESS**.

P6 rozwija minimalny katalog P3 i publikację P5 w trwałe, typowane wyniki,
bounded data plane oraz jeden frontend analityczny oparty o pinned source.

## Przyrosty

1. [Resource hooks trwałych ramek obserwacji](01-observation-frame-resources.md)
   — session-scoped katalog, descriptor i historyczne `m` z exact source oraz
   field generation identity.
2. [Explorer i pinned observation source](02-pinned-observation-source.md)
   — ramki w drzewie Results, typowana selekcja, dedykowany Inspector i mały
   session-fenced workspace descriptor bez kopiowania payloadu pola.
3. [Pinned observation source w viewport 3D](03-pinned-observation-viewport.md)
   — historyczne `m` w istniejącym render-modelu, bounded cache, exact-source
   validation, source-fenced last-good retention i browser/WebGL proof.
4. [Fundament kontraktu datasetów](04-dataset-contract-foundation.md)
   — osobne identity receptury i materializowanego wyniku, typowane
   axis/sample/item/branch, jawne availability, derived value, plot oraz
   obowiązkowa projekcja między niezgodnymi przestrzeniami pól.
5. [Ograniczone partial reads datasetów](05-bounded-dataset-slices.md)
   — storage-neutralny slice manifest ponad istniejącym CAS/TensorDescriptor,
   twarde budżety, exact range checksums i pełne płaszczyzny real/imag.
6. [Pełny descriptor pola K11](06-field-descriptor-k11.md)
   — frame, sample location, support, carrier, function space/basis/order,
   axes, complex convention, normalization i fail-closed compatibility.
7. [Receipts projekcji i metryki błędu](07-projection-receipts.md)
   — osobna receptura i dowód wykonania, exact source/target layout oraz jawne
   measured/estimated/certified error metrics z jednostkami.
8. [Semantyka pól modalnych K18](08-modal-field-semantics.md)
   — jawne rozróżnienie składowych fizycznych, współczynników FEM i lokalnej
   bazy stycznej, przypięty stan równowagi oraz reguła rekonstrukcji.
9. [Fundament katalogu SolutionSet](09-solution-set-catalog.md)
   — immutable artifact refs, provenance wejść i wykonania, osobna ocena
   naukowa oraz jawne kompletne/częściowe/nieznane pokrycie segmentów.
10. [Bounded decoder slice'ów](10-bounded-slice-decoder.md)
    — checksum-first decode bez pełnego bufora pośredniego, zachowanie
    precision i real/imag planes oraz fail-closed finite/alignment checks.
11. [Adapter TensorDescriptor/CAS](11-tensor-cas-slice-adapter.md)
    — integralny odczyt ograniczonych chunków CAS, exact-range checksum oraz
    manifest slice bez niejawnego odczytu nieograniczonego obiektu.

Writers i trwały katalog SolutionSet, materializator/evaluator datasetów, API i
generated client, pozostałe quantities, frontend porównań i wykresów oraz
produkcyjne dowody pamięci i wszystkich lane'ów pozostają otwarte. P6 wynosi
**23%**.
