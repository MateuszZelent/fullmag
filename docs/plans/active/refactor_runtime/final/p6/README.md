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
12. [Strumieniowy integralny range-read CAS](12-streaming-cas-range-read.md)
    — pełna weryfikacja SHA-256 dużego obiektu przy stałym buforze I/O i
    alokacji ograniczonej do żądanego zakresu.
13. [Trwały katalog SolutionSet](13-durable-solution-set-catalog.md)
    — monotoniczne immutable revisions, append-only artifacts/coverage,
    atomowy current manifest i idempotentne domknięcie po przerwaniu zapisu.
14. [Reconciliation rewizji SolutionSet](14-solution-set-reconciliation.md)
    — pełny skan ciągłego łańcucha, weryfikacja current wobec historii i
    atomowa promocja ostatniej poprawnej orphan revision.
15. [Automatyczne recovery katalogu SolutionSet](15-solution-set-startup-recovery.md)
    — discovery logicznych ID z portable katalogów, fail-closed kontrola
    tożsamości i reconciliation wszystkich wyników podczas otwarcia katalogu.
16. [Integracja SolutionSet z SessionStore](16-session-store-solution-sets.md)
    — jeden writer i root sesji, recovery podczas zwykłego open oraz
    bezefektowy `open_existing` dla inspekcji i GC preview.
17. [CAS publication barrier SolutionSet](17-solution-set-cas-publication-barrier.md)
    — pełny streaming hash i exact byte length wszystkich artifacts/segments
    pod tym samym writer lease przed publikacją immutable revision.
18. [GC reachability SolutionSet](18-solution-set-gc-reachability.md)
    — typowany traversal current i pełnej historii rewizji, walidacja identity,
    ciągłości oraz bounded integralności wszystkich obiektów CAS.
19. [Portable `.fms` dla SolutionSet](19-solution-set-fms-roundtrip.md)
    — typed archive preflight, profile-aware pack, exact CAS selection oraz
    restore immutable rewizji z reconciliation przed publikacją sesji.
20. [Zwalnianie pinów CAS po publikacji SolutionSet](20-solution-set-pin-retirement.md)
    — selektywny unpin po trwałym root commit oraz restartowe domknięcie
    przerwanej operacji przez pełną walidację immutable historii.
21. [Produkcyjny writer SolutionSet dla accepted study](21-accepted-study-solution-writer.md)
    — automatyczna otwarta rewizja po output-manifest barrier, terminalne
    domknięcie z oceną koordynatora, exact provenance i idempotentny replay.
22. [Jawna tożsamość bezpośredniego writera modal-eigen](22-direct-eigen-artifact-identity.md)
    — wymagane session/run/stage/runtime ID, fail-closed brak kontekstu i
    zachowanie exact identity w manifeście rodziny oraz field-sweep.
23. [Jawna tożsamość pochodnego Kittel fit](23-direct-kittel-artifact-identity.md)
    — identity-aware builder/writer dla bezpośredniej gałęzi modal-eigen oraz
    jawne odseparowanie niemigrowanych adapterów legacy.
24. [Jawna tożsamość writera FMR](24-direct-fmr-artifact-identity.md)
    — identity-aware entrypointy pełnego i przerwanego response sweep,
    walidacja przed solve oraz dokładne session/run/stage/runtime w manifeście
    rodziny `driven_response`.
25. [Kontekst tożsamości FMR w runnerze](25-fmr-runner-artifact-context.md)
    — trzy wejścia dla jawnego `dense_reference`, walidacja przed zapisem
    i odmowa nieobsługiwanej tożsamości writera natywnego; managed build PASS,
    testy NOT RUN, produkcyjni callerzy i runtime pozostają otwarte.
26. [Trwały manifest FMR bez odnośników current](26-fmr-durable-manifest-without-current-routes.md)
    — dokładny writer zachowuje ścieżki artefaktów i pomija zależne od
    aktywnej sesji odnośniki transportowe; managed build i commit/push PASS,
    testy NOT RUN, runtime pozostaje otwarty.

27. [Natywna granica tożsamości FMR](27-native-fmr-artifact-identity-boundary.md)
    — osobny kontekst ABI C/Rust, walidacja i przekazanie do solve oraz sześć
    punktów publikacji; managed build PASS, testy NOT RUN, runtime NOT VERIFIED.
28. [Manifest modalny i field-sweep](28-modal-manifest-and-field-sweep-durable-references.md)
    — durable indeks i ID pola bez mutable transportu, zgodny odczyt API;
    native bundles i dowody runtime pozostają otwarte.
29. [Pakiety modalne bez zapisywanego transportu](29-modal-bundles-without-persisted-transport.md)
    — spectrum, mode metadata, branches i CSV przechodzą na ID; zgodne
    walidatory oraz projekcje API/wykresów; review i managed build PASS,
    testy NOT RUN, runtime pozostaje otwarty.

30. [Copy-on-write legacy manifestu rodziny — build PASS](30-legacy-family-manifest-copy-on-write-adapter.md)
    — bounded adapter zachowuje oryginalny hash i naukowe bajty; publikacja,
    pełne bundles oraz runtime pozostają otwarte.

31. [Niezmienne artefakty terminalnego membera](31-terminal-solution-member-artifact-fence.md)
    — blokada late append w nadal otwartym SolutionSet; review i kontrola
    kompilacji źródeł API/session PASS, testy NOT RUN, runtime NOT VERIFIED;
    commit `a5b775b9ba789d8b250d8353de2526064a6d6616` na remote master.

32. [Integracja migracji z rzeczywistym wykonaniem](32-migration-publication-integration-contract.md)
    — audyt producenta i przejrzana kolejność integracji; brakujący trwały
    runtime ID oraz importer pozostają NOT IMPLEMENTED.
33. [Strumieniowy eksport osiągalnych CAS](33-streaming-cas-export.md)
    — file-backed typed traversal i kopiowanie z weryfikacją hash/length;
    review i kompilacja źródeł PASS, testy NOT RUN, pomiar pamięci otwarty;
    commit `dbdd2f3f0be61bb1ced7af61ed23243d9ef8d824` na remote master.
    Dokumenty i import pozostają otwarte.

Pozostałe resource keys w `runner/eigen/artifacts`, przeprowadzenie identity z
głównego runner context, FEM artifact writers i migracja legacy copy-on-write,
materializator/evaluator
datasetów, API i generated client,
pozostałe quantities, frontend porównań i wykresów oraz produkcyjne dowody
pamięci i wszystkich lane'ów pozostają otwarte. P6 wynosi **52%**.

34. [Leniwy katalog plików eksportu FMS](34-lazy-file-backed-export-documents.md)
    — run/solution jako fingerprinty, typed odczyt na żądanie i strumieniowy
    zapis; review i kontrola źródeł PASS, import oraz pomiar RAM otwarte.

35. [Leniwa historia rewizji SolutionSet](35-lazy-solution-revision-history.md)
    — katalog ścieżek i walidacja sąsiadującej pary zamiast parsed historii;
    kontrola źródeł PASS, testy i pomiar RAM otwarte.
