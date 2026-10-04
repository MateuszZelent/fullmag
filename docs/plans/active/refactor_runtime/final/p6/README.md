# Checkpoint P6 — trwałe wyniki i frontend analityczny

Status: **P6 IN PROGRESS**.

P6 rozwija minimalny katalog P3 i publikację P5 w trwałe, typowane wyniki,
bounded data plane oraz jeden frontend analityczny oparty o pinned source.

## Przyrosty

[P6-63 — wspólny czytnik historycznej geometrii](63-exact-pinned-geometry-reader.md)
— exact owner/tensor/geometry CAS, jawny brak i wspólny konsument native;
źródła PASS, binary resource i viewport pozostają otwarte.

[P6-62 — aktualność źródeł natywnego buildu](62-managed-native-source-freshness.md)
— usunięcie przyczyny wyboru starych zależności Cargo po materializacji
kapsuły; testy Python PASS, managed build po poprawce otwarty.

[P6-61 — trasa kontroli archiwum FEM](61-saved-fem-archive-roundtrip-route.md)
— frozen kopia, native read lease, Archive export/import, receipt comparison
i kontrolowana korupcja chunku; rzeczywisty roundtrip nadal otwarty.

[P6-60 — bramka integralności zapisanego snapshotu FEM](60-saved-native-snapshot-integrity-gate.md)
— read-only kontrola exact owner i historycznej próby, pełnego pola,
native map oraz indexed geometry; runtime i FMS roundtrip otwarte.

[P6-59 — projekcja rzeczywistej geometrii MFEM](59-native-indexed-geometry-projection.md)
— bounded actual node/cell ABI, inkrementalny digest oraz porównanie
z accepted i saved MeshIR; native/runtime qualification otwarte.

[P6-58 — dokładne powiązanie mapy z geometrią](58-exact-saved-map-geometry-binding.md)
— exact historical binding, tensor semantics i pełna canonical periodic
partition; status native representation pozostaje `not_verified`.

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

36. [Seekable preflight ZIP](36-seekable-zip-preflight.md)
    — brak kopii compressed archive, bounded metadata scan i actual length;
    review i kontrola źródeł PASS, decoded staging i RAM nadal otwarte.

37. [Plikowy preflight i import archiwów](37-file-backed-archive-import.md)
    — API/CLI dekodują raz do prywatnych plików, streamują publikację i blokują
    GC przy niepokrytym grafie; source checks/review PASS, runtime/RAM otwarte.

38. [Zgodność rewizji z odczytanymi wynikami](38-result-artifact-snapshot-identity.md)
    — jeden odczyt dla JSON i hasha sześciu rodzin, limit wejścia 64 MiB;
    kontrola źródeł PASS, regresje NOT RUN, comparison API i runtime otwarte.

39. [Trwałe zasoby wyników historycznych](39-durable-solution-resources.md)
    — project/run/revision API, bounded strony, generated client i hooki;
    źródła i higiena API PASS, pełny lint FAILED, testy/runtime NOT VERIFIED.

40. [Evaluator różnicy przypiętych wycinków](40-pinned-dataset-difference-evaluator.md)
    — rzeczywiste signed difference, CAS read adapter i jawna semantyka outputu;
    source review/check PASS, regresje Rust NOT RUN, materializer/API/UI otwarte.

41. [Przypięty tensor i trwały graf chunków](41-pinned-solution-tensor-graph.md)
    — owner fences, typed root i transitive publication/recovery/GC/export/import;
    source check/review PASS, regresje NOT RUN, FMS owner closure otwarte.

42. [Właściciel przypiętego tensora w FMS](42-fms-pinned-tensor-owner-closure.md)
    — exact intent i owner CAS closure, fail-closed export/import;
    source check/review PASS, round-trip NOT RUN, lokalna publication owner barrier otwarta.

43. [Lokalna bramka właściciela typed tensorów](43-local-pinned-tensor-owner-barrier.md)
    — owner przed publication/replay/recovery/GC, wspólny bounded reader;
    source check/review PASS, regresje NOT RUN, materializer/API/UI nadal otwarte.

44. [Opis pola i wycinek z przypiętego tensora](44-pinned-tensor-field-binding.md)
    — immutable binding w tensor root i odczyt pola przez exact SolutionSet owner;
    producer hookup, pełny materializer, API/UI i runtime nadal otwarte.

45. [Binarny tensor zapisanego pola FEM P1](45-recorded-fem-state-tensor-materializer.md)
    — wersjonowany opis producenta, walidacja accepted planu i chunky w tym samym
    SolutionSet; pełny MaterializedDataset, API/UI i runtime nadal otwarte.

46. [Zgodność opisu pola z regionami runtime FEM](46-fem-field-runtime-support-parity.md)
    — pełna bramka geometrii, wspólna normalizacja markerów i maska bez kopii
    topologii; runtime, RAM i trwały manifest datasetu nadal otwarte.

47. [Trwały manifest MaterializedDataset](47-durable-materialized-dataset-manifest.md)
    — typowany artefakt CAS w tej samej rewizji SolutionSet, exact owner i
    graf publication/recovery/FMS; source check/review PASS, API/UI i runtime otwarte.

48. [Audyt markerów regionów native FEM](48-native-region-marker-followup-audit.md)
    — potwierdzona podwójna normalizacja i granice raw IDs / binary mask;
    audyt źródłowy, implementacja i runtime pozostają otwarte.

49. [Przypięty zasób MaterializedDataset](49-pinned-materialized-dataset-resource.md)
    — exact owner reader, project-owned API, pełne typed metadata, generowane
    OpenAPI/client i resource hook; source/codegen/API hygiene PASS,
    konsumenci UI, binarny slice i runtime pozostają otwarte.

50. [Discovery i readonly Inspector](50-saved-results-discovery-and-inspector.md)
    — project/run/SolutionSet discovery, exact pin i UI fixture; renderer otwarty.

51. [Wyniki projektu bez aktywnej sesji](51-project-results-without-session.md)
    — ten sam docking, Inspector i confirmed session identity; browser fixture PASS.

52. [Binarny odczyt fragmentów trwałego datasetu](52-bounded-materialized-dataset-binary-slices.md)
    — bounded FMDS, exact range integrity, F32/F64 i publiczny kontrakt;
    source/codegen/review PASS, unit/HTTP/resource hook/renderer otwarte.

53. [Ograniczony podgląd wartości w Inspectorze](53-bounded-saved-field-values-inspector.md)
    — resource-owned numeric window, 64 KiB/32 elementy, checksum, readonly
    pagination i anulowanie ostatniego odbiorcy; HTTP/renderer/nauka otwarte.

54. [Niezmienna geometria zapisanego pola](54-immutable-saved-field-geometry.md)
    — exact owner, canonical mesh/support CAS i publication/recovery/GC/FMS
    closure; native representation, runtime, transport i renderer otwarte.

55. [Receipt finalnego snapshotu FEM](55-native-final-snapshot-receipt.md)
    — actual handle, exact endpoint i F64LE digest w immutable source;
    default źródła PASS, native build/map/runtime/renderer otwarte.

56. [Exact source reader zapisanego snapshotu](56-exact-saved-snapshot-reader.md)
    — historyczny owner/source i pełny hash tensora względem native receiptu;
    źródła PASS, runtime/map/API/renderer otwarte.

57. [Natywna mapa indeksów lokalnych FEM](57-native-local-node-index-map.md)
    — actual vertex DOF guard i handle-bound MFEM/core map w source CAS;
    native compilation/runtime, geometry/API/renderer otwarte.

64. [Przypięty transport geometrii i supportu](64-pinned-saved-geometry-transport.md)
    — dokładny dataset owner, FMMT v2/FMSP v1, integralność body i centralne
    resource hooks; źródła/codegen/API hygiene PASS, runtime/viewport otwarte.

64a. [Adapter archiwum Windows z dokładnymi artefaktami](64a-windows-exact-artifact-archive-adapter.md)
    — izolowany FEM CPU, attestation obrazu/mountów/sieci, zachowanie
    nieznanego wyniku; 31 regresji Python i review PASS, runtime otwarty.

64b. [Luka accepted FEM execution](64b-accepted-fem-execution-gap.md)
    — preparation nie jest wykonaniem solvera; brakujące binaria i producer
    accepted FEM pozostawiają P6-60/P6-61 otwarte.

64c. [Binaria accepted flow w pakiecie managed](64c-managed-accepted-runtime-binaries.md)
    — pięć pominiętych programów w instalacji/rpath; kontrola źródeł PASS,
    odbiór nowego pakietu i runtime pozostają otwarte.

66. [Producent accepted FEM CPU](66-accepted-fem-cpu-producer-contract.md)
    — preflight przed solverem, typed cancellation, receipt-only recovery i
    exact final state; produkcyjne źródła worker/API oraz review PASS,
    managed build blokowany pojemnością, runtime i nauka pozostają otwarte.

65. [Zapisane pole w jednym viewportcie](65-saved-field-single-viewport.md)
    — pinned geometry/support/FMDS, F32/F64, atomic upload i oddzielne kamery;
    źródła, review oraz browser fixture PASS, native/runtime/nauka otwarte.

65a. [Bezpośredni powrót do bieżącego viewportu](65a-direct-current-viewport.md)
     — lokalne czyszczenie pinned selection bez API mutation i reload;
     produkcyjne źródła, review oraz browser z tym samym canvasem PASS.

67. [Propozycja zwolnienia miejsca na runnerze](67-terminal-frontend-cache-proposal.md)
    — 44 dokładne fizyczne katalogi cache zakończonych prób, 10,66 GiB;
    historyczna propozycja; zatwierdzone wykonanie i zachowanie dowodów w P6-72.

68. [Obowiązkowy kompletny pakiet accepted runtime](68-required-accepted-runtime-package.md)
    — build nie akceptuje brakujących lub pustych binariów accepted flow;
    18 lekkich testów Python PASS, wdrożony runner i native runtime otwarte.

69. [Pakowanie supervision i retry przygotowania](69-preparation-supervisor-retry-packaging.md)
    — uzupełnione dwa programy wymagane przez portable/MSI, instalacja/runpath
    i required outputs; 31 testów Python PASS, pełne pakiety/runtime otwarte.

70. [Jednolity odbiór pakietu przez koordynator](70-coordinator-required-package-receipt.md)
    — wspólny kontrakt 14 release outputs, odbiór receipt odrzuca brak/puste
    programy; regresje trzech profili i identity archiwum PASS, runtime otwarty.

71. [Różnica kodu wdrożonego runnera](71-deployed-runner-contract-gap.md)
    — aktywny entrypoint wymaga nadal 5 outputów i ma rozszerzone profile;
    ustalone hashe, zachowanie 7 dopuszczonych profili konieczne przy integracji,
    historyczna blokada pojemności usunięta w P6-72; wdrożenie kontraktu otwarte.

72. [Zatwierdzone usunięcie cache](72-approved-cache-cleanup.md)
    — usunięto 44 dokładne katalogi, zachowano 349 plików dowodowych;
    runner raportuje 16,61 GiB wolnego i aktywny wcześniejszy build 196.

75. [Trwały skalar przez API](75-durable-scalar-api.md) — przypięty odczyt CAS,
    istniejący decoder i dokładne liczniki; build/transport/UI NOT VERIFIED.

76. [Odbiór skalarów w Saved Results](76-scalar-frontend-integration-checklist.md)
    — audyt istniejących konsumentów, kolejność integracji i scenariusze;
    implementacja frontendu oraz browser NOT VERIFIED.
