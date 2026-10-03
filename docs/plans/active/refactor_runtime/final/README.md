# Fullmag — finalny audyt i plan refaktoryzacji

Checkpoint P8-52/53, 03.10.2026: [przyrostowy backend Windows](p8/52-native-backend-dev.md)
ma rzeczywiste buildy exit 0: pierwszy profil 600,11 s, bez zmian 10,50 s,
przebudowa po zmianie 140,27 s; automatyczny build przy działającym edytorze
102,72 s. Test w przeglądarce potwierdził identyczny model, niezmienione
procesy/API UUID oraz działający WebGL. Własna sesja testowa zakończyła się
exit 0 z potwierdzonym cleanupem; ponowny start użył nowych EXE bez Cargo,
zsynchronizował metadane Python i uruchomił watcher. Automatyczne odtworzenie
modelu pozostaje niewykonane. Użytkownik zatwierdził docelowy
[restart w workspace](p8/53-development-restart-workspace.md): jawne zastosowanie
nowej wersji, ochrona szkiców, odtworzenie edytowalnego modelu i blokada aktywnej
symulacji. Kontrakt [ADR 0050](../../../../adr/0050-development-backend-restart.md)
jest przyjęty; sam restart pozostaje planned/NOT VERIFIED. Procenty bez awansu.

Checkpoint P8-50/51 i P6-78, 03.10.2026: natywny build Windows utworzył
wersjonowane CLI/API/UI, pusty workspace i zapis zmienionej geometrii
sprawdzono w przeglądarce na 3197. Cały własny przebieg zakończył się kodem 0;
WebGL i HMR PASS. Naprawiono pętlę Tailwind oraz guard po ACK szkicu.
[Launcher](p8/50-windows-empty-ui-just-route.md),
[wersja](p8/51-development-build-version.md),
[Inspector](p6/78-primitive-ack-selection.md).
88 regresji Python i 4 Node PASS, produkcyjny source check PASS. Pełny produkt
Windows, native FEM, science i cały plan nadal mają otwarte bramki;
procenty etapów bez awansu.

Checkpoint P8-49 / P6-76, 03.10.2026: rzeczywisty eksport OpenAPI z
terminalnego buildu 218, weryfikacja tożsamości i hashy oraz cleanup PASS.
25 interpretowanych regresji eksportera i 11 regresji importu PASS.
Kontrakt scalar/runtime-service i klient zostały wygenerowane; produkcyjny
source check baseline PASS. [Dowody i granice](p8/49-managed-package-openapi-export.md).
Integracja skalarów w UI trwa; runtime, nauka, B-04–B-08 i Windows nadal
wymagają odrębnych dowodów. Procenty etapów bez awansu.

Checkpoint B-08: [właściciel pola zewnętrznego i regionalnego FDM CPU](b/08-fdm-cpu-zeeman-owner.md).
Osiem metod zachowuje sygnatury i ciała; Oersted, SoA capability i fused loop
pozostają bez zmian. Source comparison i review PASS.
Build 218 zakończył się succeeded/exit 0: 120 artefaktów i 15 wymaganych wyjść
zweryfikowano razem z kapsułą źródeł. Dotyczy źródła B-03; B-04–B-08, runtime,
fizyka i produkt Windows nadal wymagają osobnych dowodów.

Checkpoint B-07: [właściciel magnetoelastyczności FDM CPU](b/07-fdm-cpu-magnetoelastic-owner.md).
Pięć metod zachowuje sygnatury i ciała; fused loop i wspólny moduł naukowy
pozostają bez zmian. Source comparison i niezależny review PASS.
Build 218 nie obejmuje późniejszych zmian B-04–B-07; runtime pozostaje otwarty.

Checkpoint B-06: [właściciel DMI FDM CPU](b/06-fdm-cpu-dmi-owner.md).
23 metody zachowują sygnatury i ciała; cztery metody spoza DMI oraz fused loop
pozostają w rodzicu. Source comparison PASS; runtime i kwalifikacja otwarte.
Build 218 jest aktywny: native-build exit 0, trwa instalacja zależności frontendu.
Buduje źródło B-03, bez późniejszych B-04/B-05/B-06; pełny receipt jeszcze otwarty.

Checkpoint P8-46: [odtwarzalny audyt execution](p8/46-read-only-execution-verifier.md).
18 regresji i review PASS; pełny świeży dowód zachowany w storage. Kapsuły
integralne, znane różnice jawne i skopiowane. Sprzątanie pozostaje niewykonane.

Checkpoint B-05: [właściciel anizotropii FDM CPU](b/05-fdm-cpu-anisotropy-owner.md).
Sześć metod zachowuje sygnatury i ciała; wspólny helper energii i fused loop
pozostają przy dotychczasowych konsumentach. Runtime i kwalifikacja otwarte.

Checkpoint P8-48: [dokładne kopie zmienionych plików execution](p8/48-execution-source-preservation.md).
Dziesięć kopii i ich hashe zachowano w kanonicznym storage. Nie wykonano
sprzątania. Historyczna blokada miejsca została usunięta poza tym zadaniem;
bieżący stan audytu i buildu opisują nowsze checkpointy powyżej.

Checkpoint P8-44/45: [audyt siedmiu zakończonych execution](p8/44-execution-cleanup-proposal.md)
i [natywny Windows fixture usuwania samych linków](p8/45-windows-reparse-unlink-fixture.md).
18 662 cele linków zbadane; dokładne tagi junction/Windows/LX przeszły fixture
z zachowaniem celów. Niczego z jobów nie usunięto, bramka retencji pozostaje;
produkcyjny cleanup i build 218 nadal otwarte.

Checkpoint B-04: [właściciel pola wymiany FDM CPU](b/04-fdm-cpu-exchange-owner.md).
Cztery sygnatury i ciała zachowane; source comparison/Rustfmt/review PASS.
Przyrost jest późniejszy niż źródło queued buildu 218; runtime i kwalifikacja
pozostają otwarte, bez awansu procentów.

Checkpoint P8-43: [pełny kontrakt pakietu wdrożony do runnera](p8/43-package-contract-runner-overlay.md).
Siedem interpretowanych regresji obrazu i niezależny review PASS; profile,
mounty i queued job 218 zachowane. Kolejka zdrowa i wznowiona, build nadal
blokuje storage; runtime i kwalifikacja pozostają otwarte.

Checkpoint 03.10.2026: [P7-C/P8 — niezależny proces runtime](p8/18-native-runtime-service.md)
— source owner lock, gated scheduler startup, loopback drain i packaging;
49 lekkich testów pakowania PASS. UI attach/detach i runtime pozostają otwarte.

Checkpoint 03.10.2026: [P7-C/P8 — kanał właściciela runtime](p8/17-native-runtime-owner-control.md)
— oba schedulery mają prywatny drain niezależny od konsoli Windows;
utrata właściciela drenuje i raportuje błąd. Usługa i UI attach/detach nadal
pozostają do realizacji; runtime NOT VERIFIED, procenty bez zmiany.

Checkpoint 02.10.2026: [P8-16 — drzewa procesów Windows](p8/16-windows-owned-worker-process-tree.md)
obejmuje worker/preparer wspólną własnością OS przed uruchomieniem solvera.
Usługa runtime niezależna od UI oraz native testy pozostają otwarte.

Checkpoint 02.10.2026: [P8-15 — Submit zainstalowanego Windows](p8/15-installed-windows-submit-store.md)
usuwa zależność wyboru magazynu runów produktu od konfiguracji checkoutu.
Native Windows i trwałość pozostają NOT VERIFIED; procenty bez zmian.

Data audytu: 20.09.2026. Rewalidacja checkpointu: 23.09.2026. Baza audytu: `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, lokalny `master`.

**Werdykt:** zachować projektowy kierunek CAE, ale wdrażać go po zabezpieczeniu persystencji, uzgodnieniu istniejących kontraktów i ustaleniu jednej tożsamości wykonania. Refaktoryzacja obejmuje authoring, Python/IR, planowanie, wykonanie, FDM/FEM CPU/GPU, storage, API, Control Room, desktop oraz kwalifikację. Nie oznacza przepisywania wszystkich solverów ani automatycznego rozszerzenia zakresu fizyki.

Aktualny checkpoint implementacyjny na `masterze`: **P0 około 85%**, **P1 około 98%**, **P2 około 59%**, **P3 około 94%**, **P3a około 90%**, **P4 około 50%**, **P5 około 99%**, **P6 około 52%**. P3 obejmuje typed `StudyPlan v2`, jawne `study_execution_plan.v2` z przypiętym per-step `until_seconds`, immutable `study_problem_catalog.v1` i lowering do canonical `fullmag-plan`, RunSpec, durable catalogs/leases, worker protocol, `WorkerCoordinator`, idempotentne zastosowanie retry, ograniczony one-shot worker dla FDM CPU, resource-scoped supervisor z globalnym bounded limitem, fenced receipt zakończenia potomka, orphan recovery sprzed decyzji oraz scheduler jawnej, uporządkowanej puli RunId, dynamicznej puli zasobów, bounded priority queue i limitu publicznego backlogu. `worker_protocol.v3` wymaga durable Heartbeat/ACK, worker-originated Stop/Stopped i bariery `Completing`. Scheduler stosuje round-robin, odświeża trwałe intenty w trybie store-discovery, zapisuje sequence-fenced kursor fairness dla `--pool-id` i odtwarza następny RunId po restarcie procesu. Tryb rezydentny przeżywa puste skany, wykrywa późniejsze runy i może działać z `--max-tasks 0`; sygnał systemowy zamyka admission, drenuje aktywne workery, zapisuje checkpointy i zwalnia lease przed statusem `drained`. Jeden proces może centralnie przydzielić kilka zasobów i równolegle nadzorować workery; durable lease nadal blokuje podwójny przydział tego samego zasobu. Krótkotrwała kontencja single-writer jest obsługiwana bounded retry wyłącznie dla tej samej idempotentnej operacji lub zachowanego envelope. Scheduler wybiera dependency-ready task, wykonuje fenced admission, publikuje trwałe `Prepare/Prepared/Start` i uruchamia supervisor; run z katalogiem widocznym przed preparation receiptem pozostaje chwilowo niegotowy. Retry jest ponownie planowane tylko na podstawie jednej trwałej decyzji i zwiększa ownership epoch. P4 ma source-level `PreparationPlan`, pięciu producerów, certyfikaty quality/marker/space, selective reuse, jawny state transfer, materializację FDM z resolved `ExecutionPlanIR`, application `PreparationReceipt`, hashujący `PreparationBinding` w `ResolvedTaskInput`, wymaganie pełnego receiptu na granicy `WorkerCoordinator::prepare`, niezmienną publikację receiptu per run, provenance UI, revision-fenced akcje Geometry oraz status Mesh z tożsamością ostatniego poprawnego artefaktu i jego rewizjami. Nadal otwarte są transport cross-host, process E2E pozostałych lane'ów, process proof publicznej nazwy CLI, walidacja pełnej parzystości wszystkich pól authoringu, native FEM mesh/space, pozostałe endpointy P3a oraz pełna kwalifikacja backendów i release. Są to wskaźniki zakresu planu, nie kwalifikacji produkcyjnej. Accepted-run FEM preparation ma trwałe lease, launch/exit receipts, procesy preparera, supervisora i schedulera oraz pełne pakowanie portable/MSI. Publiczne `run-json` jest transportem accepted-run przez HTTP API v2; bezpośredni ProblemIR pozostał wyłącznie ukrytym narzędziem repozytoryjnych bramek. Globalnie daje to około **49%** planu.

Najnowsze uszczelnienie centralnego admission odrzuca oferty CPU/GPU bez
pełnego i spójnego budżetu CPU, RAM, storage oraz VRAM właściwego dla lane'u.
Wspólna, pięciosekundowa polityka retry z jitterem usuwa lockstep schedulera,
supervisorów i workerów; dwie kolejne próby puli oraz wymuszona kontencja
przechodzą na identycznym źródle. Przyrost stabilizuje już policzony zakres,
dlatego nie podnosi procentów P3/P5.

## Dokumenty finalne

Checkpoint P8-41: [wdrożone sondy nightly](p8/41-nightly-probes-deployed.md).
Kolejka zdrowa po kontrolowanej wymianie; pojemność Windows storage nadal blokuje build 218.

Checkpoint B-03, 03.10.2026: [właściciel STT/SOT FDM CPU](b/03-fdm-cpu-direct-torques-owner.md).
Ekstrakcja zachowuje dwadzieścia ciał funkcji i adapter FEM; kwalifikacja pozostaje otwarta.

Checkpoint B-02, 03.10.2026: [właściciel pola demagnetyzacji FDM CPU](b/02-fdm-cpu-demag-owner.md).
Siedem metod zachowuje sygnatury i ciała; weryfikacja produkcyjna pozostaje otwarta.

Checkpoint domknięcia 02.10.2026: [warunki odbioru P1/P3/P3a/P5](07-domkniecie-etapow.md).
Dodano bramkę stale scope ośmiu operacji workspace; 11 regresji skryptu PASS,
managed runtime otwarty. [Build 197 i browser startup](p1/10-browser-empty-startup.md)
przeszły kompilację i uruchomienie na porcie 3104. Pusty FDM działa; FEM działa
po reloadzie, lecz zastąpienie sesji bez reloadu ujawniło Checking for sessions.
Brak jeszcze dowodu swobodnego używania edytora podczas długiego meshingu.
Żaden z etapów nie otrzymuje 100% na podstawie tego checkpointu.

Checkpoint 02.10.2026: [P6-71 — kod wdrożonego runnera](p6/71-deployed-runner-contract-gap.md)
potwierdza, że źródłowe kontrole pakietu z P6-68–70 nie są jeszcze wdrożone.
Aktualizacja musi zachować siedem operatorowo dopuszczonych profili; nie wolno
zastąpić rozszerzonego entrypointu wariantem trzech profili. Bieżący odczyt
runnera z tamtego checkpointu: 88 084 480 B wolnego, brak aktywnych jobs,
`waiting_for_disk`. Późniejsze [P6-72 — zatwierdzone usunięcie cache](p6/72-approved-cache-cleanup.md)
potwierdza usunięcie wszystkich 44 celów i zachowanie 349 plików dowodowych.
Odczyt po operacji: 17 839 595 520 B wolnego (16,61 GiB), aktywny wcześniejszy
build 196; źródłowy kontrakt P6-68–70 nadal wymaga integracji z runnerem.
Natywny build, runtime i pełny plan pozostają otwarte; procenty bez zmian.

Checkpoint 02.10.2026: [P6-65a — bezpośredni powrót do current view](p6/65a-direct-current-viewport.md)
usuwa zależność powrotu od reopen workspace. Przycisk czyści lokalny wybór;
browser `373378d47ba04d3ba20dc86c24975b79` PASS potwierdza ten sam viewport/canvas,
current camera, WebGL 613×634 i brak mutacji runtime/saved fetch. Źródła i review
PASS; native, nauka, pozostałe reprezentacje i pełna kwalifikacja nadal otwarte.
P6 około 52%, cały plan około 49%.

Checkpoint 02.10.2026: [P6-65 — zapisane pole w jednym viewportcie](p6/65-saved-field-single-viewport.md)
ma produkcyjne źródła i niezależny review PASS oraz pełny browser fixture
`d836530e926145f58d371a3f3506764d` PASS. F32/F64, support, osobne kamery,
negative cases i reopen live mają dowód; bezpośredni deselect odebrano później
w P6-65a. Native HTTP/archive, pozostałe reprezentacje i kwalifikacja pozostają otwarte.
P6 około 52%, cały plan około 49%.

Checkpoint 02.10.2026: [P6-66 — producent accepted FEM CPU](p6/66-accepted-fem-cpu-producer-contract.md)
łączy preflight, wykonanie native, exact final state, typed cancellation oraz
receipt-only recovery bez drugiego solve. Produkcyjne źródła worker/API i review
PASS; commit `d6d1b31cd7eb5e706210e7c0e2c7d4815b362acf` jest na remote.
Nowy managed build i native archive roundtrip czekają na pojemność runnera:
ówczesny odczyt 02.10.2026: 867 024 896 B wolnego przy minimum 8 GiB;
aktualniejszy pomiar jest w P6-71 powyżej.
Stan runtime, nauka i release pozostają NOT VERIFIED; procenty bez zmian.

Checkpoint 01.10.2026: [P6-64 — transport zapisanej geometrii](p6/64-pinned-saved-geometry-transport.md)
łączy przypięty dataset z metadanymi, topologią FMMT v2 i supportem FMSP v1.
Źródła, codegen i API hygiene PASS; HTTP i viewport pozostają otwarte.
Build 192 zakończony exit 0, 113/113 artefaktów zweryfikowanych; runtime osobno.
P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-63 — czytnik historycznej geometrii](p6/63-exact-pinned-geometry-reader.md)
centralizuje exact pinned owner/geometry/support lookup i podłącza natywną
bramkę. Produkcyjne źródła PASS; transport i viewport nadal otwarte.
P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-62 — aktualność źródeł native buildu](p6/62-managed-native-source-freshness.md)
usuwa wykazaną przyczynę błędu buildu 191 bez kasowania cache.
Testy źródłowe PASS; po zewnętrznym wznowieniu runnera build 192 zakończył się exit 0.
Jego źródła poprzedzają P6-62, więc nie kwalifikują tej poprawki.
Managed build po poprawce i runtime pozostają NOT VERIFIED; procenty bez zmian.

Checkpoint 01.10.2026: [P6-61 — trasa kontroli archiwum FEM](p6/61-saved-fem-archive-roundtrip-route.md)
przygotowuje izolowany export/import bez buildu/solvera. Build 189 ma terminalny
sukces i 113 zweryfikowanych artefaktów dla P6-55; build 191 failed,
192 ma exit 0 oraz 113/113 zweryfikowanych artefaktów dla P6-60.
Actual roundtrip nadal NOT VERIFIED; P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-60 — bramka zapisanego snapshotu FEM](p6/60-saved-native-snapshot-integrity-gate.md)
udostępnia kontrolę integralności dla dokładnego historycznego źródła,
bez zmiany sesji. Source check PASS; wykonanie i archive roundtrip otwarte.
P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-59 — projekcja rzeczywistej geometrii MFEM](p6/59-native-indexed-geometry-projection.md)
dodaje bounded native node/cell export i digest porównywany z accepted oraz
saved MeshIR. Native compilation/runtime nadal otwarte; P6 około 52%,
cały plan około 49%.

Checkpoint 01.10.2026: [P6-58 — dokładne powiązanie mapy z geometrią](p6/58-exact-saved-map-geometry-binding.md)
sprawdza historyczny geometry owner i pełną core periodic partition podczas
odczytu mapped snapshotu. Live native geometry i renderer nadal otwarte;
P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-57 — natywna mapa lokalnych indeksów](p6/57-native-local-node-index-map.md)
rozdziela MFEM local/true DOF i core periodic classes; source CAS zachowuje
actual map powiązaną z finalnym polem. Native compilation/runtime i renderer
pozostają otwarte. P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-56 — exact reader zapisanego snapshotu](p6/56-exact-saved-snapshot-reader.md)
wiąże historyczny source CAS z pełnym hashem tensora. Produkcyjne źródła PASS;
native build 189 czeka na zakończenie aktywnego kontenera dyspersji.
Runtime/map/API/renderer otwarte. P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-55 — receipt finalnego snapshotu FEM](p6/55-native-final-snapshot-receipt.md)
wiąże actual handle receipt z endpointem i hashem wartości w source CAS,
oddzielnie od layout fingerprint. Default źródła PASS; zgodny klient runnera
odnaleziony, native build/map/renderer/runtime pozostają otwarte.
P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-54 — niezmienna geometria zapisanego pola](p6/54-immutable-saved-field-geometry.md)
wiąże geometry/support CAS z dokładnym tensorem i historycznym ownerem,
rozszerzając publication, recovery i live/archive retencję. Źródła PASS;
native representation, runtime/FMS, transport i renderer pozostają otwarte.
P6 około 52%, cały plan około 49%.

Checkpoint 01.10.2026: [P6-53 — ograniczony podgląd wartości w Inspectorze](p6/53-bounded-saved-field-values-inspector.md)
podłącza binarny slice do resource hooka i readonly tabeli z paginacją,
limitem 64 KiB/32 elementów, wyborem komponentu i anulowaniem po zamknięciu.
Przebiegi browser fixture potwierdzają checksum, reload i zwolnienie odbiorcy;
backend HTTP, przestrzenny renderer, nauka i release pozostają NOT VERIFIED.
P6 nadal około 52%, cały plan około 49%.

Poprzedni checkpoint: [P6-52 — binarny odczyt fragmentów trwałego datasetu](p6/52-bounded-materialized-dataset-binary-slices.md)
obejmuje exact pinned source, bounded FMDS transport, range checksums,
F32/F64, odrzucanie NaN/Infinity i jawny limit metadata. Produkcyjna kompilacja
przy codegen, TypeScript, API hygiene i review przeszły; testy jednostkowe,
backend HTTP, resource hook i renderer pozostają NOT VERIFIED.
P6 nadal około 52%, cały plan około 49%.

Poprzedni checkpoint: [P6-51 — zapisane wyniki projektu bez aktywnej
sesji](p6/51-project-results-without-session.md), po [discovery i przypiętym
Inspectorze P6-50](p6/50-saved-results-discovery-and-inspector.md). Otwarty
projekt korzysta z tego samego dockingu i readonly Inspectora bez fikcyjnej
sesji. Wspólna confirmed identity chroni workspace, menu, resource hooks,
komendy, WS, selekcję i kamerę. Binarny podgląd pól, managed HTTP, kwalifikacja
przejścia aktywnych sesji, nauka i release pozostają otwarte; procentów
realizacji planu nie podniesiono na podstawie fixture.

W rewalidacji 21.09.2026 dodano także trwały, fenced journal
`retry_decision.v1`; wcześniejsze sformułowanie o otwartej decyzji retry należy
czytać jako brak zastosowania decyzji do durable snapshotu i brak automatycznej
polityki supervisora.

Najnowszy checkpoint P3a-A obejmuje także context-bound przyjęcie komendy
obliczeniowej, binarny odczyt FMRM, listę/pobranie/capture/restore checkpointu i politykę events;
przyrosty P3a-B opakowują cache/decode data preview, planar field, pola modalne,
model/runtime/workspace, meshing, membership/domain, katalogi data-plane,
analysis-result, analysis runtime, diagnostics/runtime explorer, spin-wave,
Frozen Spins, preparation i mode-composition w `session_id + epoch`, a scheduler
odrzuca spóźniony wynik decode po abort, a export/commit archiwum sesji rewalidują
context przed transakcją/publikacją. Recovery list/clear również jest
context-bound. `ResourceRuntimeStore` przekazuje `sessionScopeKey` do
`ControlRoomApi`, więc deduplikacja materializacji pól i sprawdzenia świeżości
meshu jest izolowana per sesja. Odczyty GET wizualizacji oraz istniejące mutacje
PATCH/POST mają teraz backendowy transition fence, a hooki stanu, ACK i
kontrolery mutacji przekazują `sessionScopeKey`; PUT display/state pozostają
otwarte bez typed konsumenta. Status P3a wynosi obecnie **90%**.
Source-level macierz rodzin jest w [`p3a/05-endpoint-coverage.md`](p3a/05-endpoint-coverage.md),
a pełny inventory 300 operacji OpenAPI z ownerem/write policy i statusem
context migration w [`p3a/06-endpoint-owner-policy.md`](p3a/06-endpoint-owner-policy.md).
Migracja 18 operacji `OPEN`, legacy semantics recovery/persistence/events oraz
browser/runtime nadal pozostają otwarte.

1. [Finalny audyt](01-finalny-audyt.md) — ustalenia, rozstrzygnięcia Gemini/Claude, ryzyka i granice dowodów.
2. [Architektura i kontrakty](02-architektura-i-kontrakty.md) — docelowi właściciele, tożsamości, transakcje i decyzje migracyjne.
3. [Produkcyjny plan refaktoryzacji](03-plan-refaktoryzacji.md) — kolejność, pakiety pracy, zależności, bramki i rollback.
4. [Kwalifikacja i scenariusze](04-kwalifikacja-i-scenariusze.md) — zachowane CAE-01–60, skorygowane CAE-61–70 i dodatkowe testy przekrojowe.
5. [Dowody, źródła i uzgodnienie ADR](05-dowody-i-adr.md) — aktualne źródła, rozliczenie wszystkich dokumentów wejściowych i istniejących decyzji.
6. [Checkpoint P2](p2/README.md) — wykonane slice'y izolacji kontekstu Python, kanonicznych bajtów IR, sekwencji cech geometrii i projekcji Model/Component/PhysicsConfiguration.
7. [Checkpoint P3](p3/README.md) — typed studies, `study_execution_plan.v2` i lowering do `fullmag-plan`, RunSpecification, durable catalogs, leases, worker identity, retry decision, coordinator journal, przypięty horyzont TimeEvolution, one-shot worker, resource-scoped supervisor oraz scheduler dependency-ready tasków z trwałym retry, restartowym kursorem fairness, dynamiczną pulą zasobów, bounded priority queue, limitem backlogu, rezydentnym discovery, graceful drain i worker-originated control ACK; transport cross-host i pozostałe lane'y pozostają otwarte.
8. [Checkpoint P3a](p3a/README.md) — pilot immutable request context oraz kolejne przyrosty sesyjnej tożsamości klienta dla data-plane i resource hooks; pełny inventory endpointów jest w [macierzy owner/write policy](p3a/06-endpoint-owner-policy.md).
9. [Checkpoint P4](p4/README.md) — `PreparationPlan`, typed producers, FDM materialization z resolved planu, adaptery grid/mesh, application receipt, `PreparationBinding` w wejściu `Prepare`, durable publikacja tożsamości per run, last-good mesh UI, jawne FDM `Build Grid`, wspólne Operations/Problems, trwały journal komend Live oraz publiczny readback dokładnego kroku, czasu i segmentu zastosowania komendy.
10. [Checkpoint P5](p5/README.md) — bezpieczny runtime, granice zastosowania komend i źródłowy kontrakt `AcceptedStateRef`; materializacja lane'ów i managed qualification pozostają otwarte.
11. [Checkpoint P8-A](p8/01-retire-legacy-web-archive.md) — usunięcie 981 plików archiwalnej kopii `_to_delete_legacy_web` przy zachowaniu aktywnego Control Room i jawnych granic kwalifikacji release.
12. [Tabela statusu całego planu](06-status-realizacji.md) — procenty etapów, wykonane zakresy, dowody i blokery.
13. [Semantic history P2-D](p2/05-semantic-history.md) — revision-fenced Undo/Redo i granice obecnego slice'u.

## Jak używać pakietu

Ten pakiet jest scaloną wersją planistyczną. Materiały w katalogu nadrzędnym oraz `raport_gemini` i `raport_claude` pozostają materiałami wejściowymi; rozstrzygnięcia finalne wskazują, które rekomendacje przyjęto, zmieniono lub odrzucono. Nie należy wykonywać sprzecznej rekomendacji starszego raportu równolegle z finalnym planem.

Nowe kontrakty mają status **PROPOSED — finalna rekomendacja do wdrożenia**. Istniejące ADR i reguły projektu nadal obowiązują; wymagane zmiany normatywne mają osobne zadania przed zależną implementacją. Ten katalog nie nadaje numerów nowym ADR i nie deklaruje ich formalnej akceptacji.

Plan jest przeznaczony do produkcyjnego wdrożenia, ale **produkt nie został tu zakwalifikowany produkcyjnie**. Główne dokumenty są zapisem audytu statycznego i kontroli dokumentów z chwili powstania pakietu; późniejsze wykonanie P0/P1 jest rejestrowane osobno w podkatalogach [`p0`](p0/README.md) i [`p1`](p1/README.md). Nie należy przenosić ich receiptów na pełną kwalifikację wydania: nadal brakuje m.in. power-loss, pełnej rekonsyliacji runtime/session-recovery, ścieżek naukowych i release gate.

Pierwszy krok realizacyjny był P0-A; bieżący checkpoint przeszedł minimalną bramkę P0 i rozszerzył P1-C o lokalny lifecycle dokumentu, browserowy wybór i pobieranie archiwum, hostowy adapter Tauri Save oraz ikonę komendową do chowania Inspektora przez `panelVisible.right`. Dodano też zarządzany smoke runtime-free API z kontrolowanym restartem procesu, zarządzane smoke CLI `fullmag project open` i Python `_fullmag_core.open_project_json`, managed handshake/reconnect WebSocket na pustej sesji, managed active-run reconnect z rzeczywistym FDM CPU oraz browserowy smoke zachowania tego samego workspace/canvasu po reconnect, wszystkie z przypiętą tożsamością źródła tam, gdzie dotyczy to managed runtime. W kolejnym kroku P2 dodano context-bound flat DSL z jawnym `fm.ExecutionContext`, owner fencing uchwytów, wspólne bajty/digest ProblemIR, wersjonowany AST parametrów SI, opisową sekwencję cech geometrii z lineage CSG, niemutowalną projekcję Model/Component/PhysicsConfiguration, revision-fenced semantic Undo/Redo, rejestr aktywnego formularza Inspectora, wrapper staged sessions oraz helper revision-fenced immediate mutations; szczegóły są w [P2](p2/README.md). Pozostaje trwały Rust/browser roundtrip modelu, ewaluacja selekcji/ambiguity, pozostałe bezpośrednie/multistep mutacje, selection/focus, jawna materializacja study/run, fizyczny desktop smoke, runtime Tauri, pełna session-recovery, nauka i release gate. Dokumentacja nie upoważnia do przeskoczenia tych bramek.

Lokalny probe aktywnego FDM wykazał dodatkowo zachowanie `session_id`/`run_id`
i wzrost kroków po zerwaniu i reconnect WebSocket; jest to opisane w
[`p1/06-active-run-reconnect-diagnostic.md`](p1/06-active-run-reconnect-diagnostic.md)
jako historia diagnostyczna. Aktualny dowód zarządzany active-run, z przypiętym
source snapshotem i receipt SHA-256, znajduje się w
[`p1/07-active-run-reconnect-managed.md`](p1/07-active-run-reconnect-managed.md).
Browserowy smoke na aktywnej sesji wykonał przez menu `File` pełny cykl
`New Project → Save Project → Open Project → Save Project → Close Project`,
porównał 942 bajty archiwum 1:1 i potwierdził pustą listę mutacji runtime;
szczegóły są w
[`p1/08-browser-lifecycle-runtime.md`](p1/08-browser-lifecycle-runtime.md).
Kontrolowane zerwanie pierwszego WebSocketu w osobnym smoke zachowało ten sam
`#fm-main-content` i canvas WebGL (`703×478`, `contextLost=false`) po
reconnect z `after_seq=14`; dowód znajduje się w
[`p1/09-browser-mounted-workspace-reconnect.md`](p1/09-browser-mounted-workspace-reconnect.md).
Pozostają statusy Tauri, pełna session-recovery i release gate.

Bieżący browserowy smoke potwierdził również pełny cykl tej ikony: `Hide Inspector` ukrywa `panel-right`, menu `Panel` pokazuje `Inspector = 0`, a ponowna pozycja `Inspector` przywraca panel (`Inspector = 1`).

Ten scenariusz został następnie włączony do automatycznego Playwright smoke
`apps/control-room/scripts/smoke-inspector.mjs`; rewalidacja 21.09.2026 na
`http://localhost:3100/workspace` zakończyła się `exit 0` z wynikiem
`inspectorPanelToggle: verified; header icon and ribbon restore`. Jedyny zliczony
błąd konsoli był oczekiwanym pojedynczym `409 Conflict` z ochrony dirty-selection;
nieoczekiwane błędy oraz powtarzające się konflikty są przez smoke odrzucane.

Dodano także wykonywalny smoke lifecycle projektu
`apps/control-room/scripts/smoke-project-lifecycle.mjs`: `New → Open → Save → Close`
bez sesji, z file chooserem, dwoma downloadami `.fms` i pustą listą mutacji
runtime. Wykonanie zakończyło się `exit 0`.

Po tej zmianie przeprowadzono końcową kontrolę spójności repozytorium, API/architektury Control Room oraz kompilację i testy desktopowego adaptera Tauri: wszystkie kontrole zakończyły się `PASS`. Fizyczny smoke w zbudowanym oknie Tauri pozostaje osobnym gate'em; testy Rust/TS potwierdzają kontrakt mostu, ale nie zastępują interakcji z hostem.

Kontrola pakietu z 21.09.2026: parsery `inventory.json`, `02-baseline-manifest.json` i wygenerowanego OpenAPI przeszły; wszystkie względne linki Markdown w `final/` wskazują istniejące pliki; `python scripts/check_repo_consistency.py` i `git diff --check` zakończyły się powodzeniem. Ostrzeżenia `git diff --check` dotyczą wyłącznie normalizacji LF→CRLF na Windows.

Aktualizacja startupu 02.10.2026: ACK scope i invalidacja replacement naprawione w źródłach; nowy build/browser NOT VERIFIED. Checkpointy BLOCKED: symlink w pierwotnym launcherze, a po jego naprawie nieobsługiwany filesystem Desktop 9p. Runner ma poniżej 8 GiB wolnego storage i wykrywa istniejący runtime. Sesja użytkownika na 3104 zachowana. Szczegóły: [raport startupu](p1/10-browser-empty-startup.md).

Kolejny checkpoint 02.10.2026: miejsce odblokowane (43,8 GB wolnego podczas preflight), zlecono [build nr 200](p1/12-startup-rebuild-200.md) czystego commita z poprawkami UI. Backend w kompilacji, terminalny receipt NOT VERIFIED. Import definicji sceny na prywatne 3114 PASS, oryginał 3104 bez zmian. [Propozycja magazynu sesji Desktop](p1/11-desktop-session-storage-proposal.md) pozostaje do decyzji operatora; nie provisionowano wolumenu.

Nowszy checkpoint 02.10.2026 zastępuje stan RUNNING powyżej: build 200
SUCCEEDED/exit 0, pakiet zweryfikowany. Na 3124 pusty FDM i replacement FEM
bez reloadu PASS; ACK transport 200 z pełnym scope. Przyjęcie pustej sceny
nadal zgłasza timeout, a checkpointy 500/9p — pełny startup nie jest zaliczony.
Operator wymaga niezależnego Windows bez Docker/WSL/Linux; propozycja wolumenu
została wycofana jako rozwiązanie produktu, nie wymaga już tej decyzji.
[Natywny pusty workspace](p1/14-windows-native-workspace.md) dodano do launchera;
7 lekkich regresji PASS. Aktualny natywny pakiet, FEM oraz pełny storage/restart
pozostają NOT VERIFIED. Sesja 3104 zachowana; procenty planu bez awansu.

Review natywnego Windows ujawnił brak budowy desktopowego UI w launcherze;
source increment uzupełniono o `fullmag-desktop`, niepusty plik i hash manifestu.
16 regresji PS/Python i 6 kontroli źródeł PASS. [P8-C — luki Windows](p8/01-windows-native-gaps.md)
określa dalsze zadania ABI, dependency bundle, pakowania, executora i recovery.
Build/runtime Windows i pełne FEM nadal NOT VERIFIED; P8 nie został zamknięty.

Kolejny fragment P8-C: poprawiono target-aware rpath, wybór konfiguracji
CMake/import library oraz eksport 86 funkcji i publicznego symbolu danych FEM.
6 sprawdzeń rzeczywistym preprocesorem MSVC C/C++ PASS; 2 istniejące kontrole
źródeł buildu PASS. Bez kompilacji unit tests. Szczegóły i granice dowodu w
[P8-C](p8/01-windows-native-gaps.md). Runtime DLL staging, linkowanie,
native FEM launch i regresja Linux pozostają otwarte; procenty bez awansu.

Zewnętrzny FDM w CMake rozpoznaje teraz osobno runtime DLL i import library
Windows; Linux `.so`/`.so.0` zachowano. 12 configure-only cases PASS, bez
kompilacji/linkowania, na jawnych fiksturach. Runtime i pełny P8-C niezaliczone.

Installer Windows kieruje DLL obok EXE, kontroluje konflikty nazw/hashów
i zapisuje inventory DLL w manifestach. 8 regresji rzeczywistej funkcji
PowerShell PASS. Pełny bundle zależności FEM/CUDA i clean install nadal
NOT VERIFIED; brak awansu procentów ani publikacji wydania.

Konfiguracja FEM rozdziela teraz jawny CPU build bez CUDA i wymagane GPU.
CMake odrzuca brak CUDA compiler przy REQUIRE_GPU; Cargo przekazuje tę
politykę. CPU modal SLEPc pozostaje jawnie dostępne przez override.
11 configuration/wiring checks oraz 2 istniejące source contracts PASS;
native compile/link/runtime i pełny P8-C nadal NOT VERIFIED.

Zlecono [managed build FEM CPU 204](p8/02-fem-cpu-build-204.md) dokładnego
commita `a55fa13d76052cdc5e3f96d8369127752061237d`. QUEUED za cudzym aktywnym
buildem; terminalny receipt i artefakty NOT VERIFIED. Próba jest regresją
Linux, nie kwalifikacją natywnego Windows. Sesja 3104 zachowana.

Packager Windows MSI korzysta teraz z resolvera/preflight storage oraz
osobnego stagingu każdej próby; natywne CI odbiera zwalidowane outputy
artefaktów. 15 lekkich regresji PowerShell/YAML PASS, scoped review bez
nowego P0/P1. Enrolment Windows executora, native FEM i pełny install/recovery
pozostają NOT VERIFIED; procenty nie są awansowane do kwalifikacji produktu.
Szczegóły w [P8-C](p8/01-windows-native-gaps.md).

Dodano bramkę x64 PE/importów przed MSI: brak CRT/solver/CUDA runtime
w bundle zatrzymuje pakowanie, graph zależności trafia do manifestów.
21 regresji PE i 15 storage PASS; real MSVC dumpbin sprawdzono na istniejącym
Windows notepad.exe (56 importów), nie na buildzie Fullmaga. Runtime ABI,
native FEM i clean install pozostają NOT VERIFIED; pełny P8-C otwarty.

Pakowanie Windows wyznacza teraz transitive DLL closure przed dodatkowym
copy z jawnych MSVC/CUDA/operator SDK roots; plan i source hashes zapisuje
w manifestach. 24 planner/PowerShell oraz 23 PE i 15 storage regresji
PASS (62). Real MSVC redist plan/copy/audit PASS, bez Fullmag build/runtime.
Pełny natywny FEM, Windows receipt i install/recovery pozostają otwarte.

Build FEM CPU 204 przeszedł z QUEUED do RUNNING. Potwierdzono żywy worker
i poprawne job/source/profile argumenty entrypoint. Logi jeszcze puste;
terminalny receipt i artefakty nadal NOT VERIFIED. Obserwować ten sam job.

Nowy fragment P8-C przypina discovery Windows MFEM do jawnego prefixu x64
MSVC, konfiguracji i zgodnych double/CUDA exports; Linux discovery zachowano.
30 configure-only regresji i 11 build policy checks PASS, rustfmt PASS;
review zamknęło stale-cache i empty-profile defects. Actual Windows ABI,
native dependencies, kompilacja, runtime i install/recovery nadal otwarte.
[Raport P8-C](p8/01-windows-native-gaps.md) określa granice dowodu.

Kolejna obserwacja tego samego workera 204: native-build zakończony exit 0
(około 804 s), rozpoczęto frontend-dependencies. Cały job wciąż RUNNING;
terminalny receipt i wymagane artefakty pozostają NOT VERIFIED. Jego starsza
tożsamość źródeł nie obejmuje nowego discovery MFEM Windows.

Build 204 zakończony SUCCEEDED/exit 0: niezależnie sprawdzono wszystkie
119 artifact hashes, 291 618 738 B i wymagane niepuste CLI/API/Python/native/UI.
[Końcowy receipt](p8/02-fem-cpu-build-204.md) pozostawia runtime/naukę/Windows
NOT VERIFIED; źródła to wcześniejszy przypięty SHA.

[Nowe assembly natywnego FEM Windows](p8/03-native-fem-package-assembly.md)
podłącza CMake DLL/import pair do CLI/API/MSI, dodaje CPU/GPU profiles,
strict availability JSON i manifesty eksperymentalne. 153 lekkich regresji
PASS. API GitHub: 0 zarejestrowanych self-hosted runners; real Windows build,
qualified prefix oraz install/recovery pozostają otwarte. Procenty całego
planu nie są awansowane przez ten dowód źródłowy.

[Poprawka bootstrapu spakowanego UI](p8/04-static-ui-package-bootstrap.md)
uzupełnia wspólny zestaw plików Node dla MSI, eksportu lokalnego i portable.
Rzeczywisty start HTTP z katalogu pakietu i staging MSI: PASS. Pełna
instalacja Windows oraz kwalifikacja wydania pozostają NOT VERIFIED.

[Dołączony Node Windows](p8/05-bundled-windows-node.md) usuwa wymaganie Node
z PATH dla nowego MSI: jawne wejście z licencją, SHA-256 i wspólny audyt PE.
Actual copied Node z pustym PATH oraz produkcyjny source check CLI: PASS.
Dołączenie Pythona i pełna instalacja Windows pozostają otwarte.

[Preflight locka Python](p8/06-python-lock-preflight.md) wykrywa niespójność
obecnego `uv.lock` z pyproject i zatrzymuje MSI przed buildem. 13 lekkich
regresji PASS; rzeczywisty lock pozostaje niezsynchronizowany. Bootstrap uv
zatrzymany przez regułę kolejki storage; CPython bundle nadal otwarty.

[Przypięty wheelhouse Windows](p8/07-locked-windows-python-wheelhouse.md)
zastępuje zwykły staging pip eksportem z locka, hash enforcement i offline
instalacją. 8 regresji z prawdziwym pip, 7 kontroli kopii wheela oraz
2 testy metadanych PASS.
UV export był atrapą w testach; rzeczywisty lock/export i CPython bundle
pozostają NOT VERIFIED.

[Dołączony CPython Windows](p8/08-bundled-windows-python-runtime.md)
ma źródłowy staging x64 embeddable, izolowane ścieżki, minor ABI 3.12,
licencję/hash inventory i płaski audyt standard-library PYD. 149 różnych
lekkich regresji PASS; executable probe jest atrapą, realny runtime/MSI
i scientific wheel graph pozostają NOT VERIFIED.

[Polityka launchera Python](p8/09-bundled-python-launcher-policy.md)
wspólna dla CLI/API wybiera bundled interpreter i odrzuca zewnętrzny
fallback w pakiecie Windows. Produkcyjne source checks CLI/API PASS;
Rust regresje niewykonane z powodu zakazu kompilacji unit tests.
Gotowy MSI i runtime bez hostowego Python nadal NOT VERIFIED.

[Rekurencyjny audyt Python PE](p8/10-recursive-python-native-audit.md)
obejmuje także scientific wheel PYD/DLL i odróżnia dostępność bibliotek
od kwalifikacji loadera/runtime. Nowe regresje interpretowane PASS;
realny pakiet Windows i kwalifikacja nadal NOT VERIFIED.

[Managed build aktualnego mastera, 210](p8/11-current-master-managed-build-210.md)
ma terminalny SUCCEEDED/exit 0; 122 artefakty i niezmienna kapsuła PASS.
Konsument gotowego pakietu potwierdził osiem binariów i bibliotekę FEM.
Accepted FEM execution, realne HTTP/CAS i archive roundtrip pozostają otwarte.

[Przygotowanie FEM z gotowego pakietu](p6/73-managed-preparation-package-reuse.md)
dodaje zweryfikowany konsument receiptu i tryb bez kompilacji. 55 lekkich
regresji PASS; managed runtime wrapper, pełny accepted solver i pin/archive
nadal pozostają otwarte.

[Driver accepted FEM CPU](p6/74-accepted-fem-cpu-runtime-driver.md) dodaje
kontynuację przygotowania przez solver, trwały wynik, publiczny SolutionSet
i pin z produkcyjną kontrolą native snapshot. 85 regresji PASS; rzeczywiste
wykonanie w zweryfikowanym obrazie, archive i nauka nadal NOT VERIFIED.

[Writable state desktopu Windows](p8/12-windows-desktop-writable-state.md)
usuwa zapis logów obok instalacji i wiąże checkpointy z rootem stanu API.
Kontrole źródłowe PASS; natywny pakiet, rzeczywisty zapis/restart/restore
i wydanie pozostają NOT VERIFIED. Docker nie jest wymaganiem produktu Windows.

[Wspólna walidacja katalogu danych](p8/13-shared-state-root-validation.md)
odrzuca względny FULLMAG_STATE_ROOT w CLI, API i desktopie przed zapisem.
Parser/review PASS; regresje Rust NOT RUN, Windows MSI PENDING bez wykonanego
kroku. Pakiet i trwałość nadal wymagają rzeczywistego odbioru.

[Build aktualnego runtime, 212](p8/14-managed-build-current-runtime-212.md)
jest w istniejącej kolejce z przypiętego commita zawierającego późniejsze
poprawki state i driver. QUEUED nie oznacza PASS; build 210 zachowuje swój
oddzielny terminalny dowód, a runtime/Windows pozostają otwarte.

Checkpoint P7-C: [19 — żywe discovery runtime](p8/19-native-runtime-discovery.md).

Checkpoint P7-C: [20 — klient zgodności runtime](p8/20-native-runtime-client.md).

Checkpoint P7-C: [21 — launcher niezależnego runtime](p8/21-native-runtime-launcher.md).

Checkpoint P7-C: [22 — UI i kanoniczny accepted store](p8/22-native-ui-service-binding.md).

Checkpoint P7-C: [23 — handshake store API](p8/23-api-accepted-store-handshake.md).

Checkpoint P7-C: [24 — tożsamość procesu i HTTP fence](p8/24-api-instance-fence.md).

Checkpoint P7-C: [25 — przypięcie native UI do API](p8/25-native-ui-instance-pinning.md).

Checkpoint P8: [26 — lint i retencja mapy pola](p8/26-frontend-lint-and-frame-retention.md).

Checkpoint P8-C: [27 — trasa workspace w pakiecie](p8/27-native-workspace-package.md).

Checkpoint P8-C: [28 — natywny odczyt zasobów hosta](p8/28-native-capacity-observation.md).

Checkpoint P8-C: [29 — stabilna konfiguracja usługi aplikacji](p8/29-stable-application-service-config.md).

Checkpoint P8-C: [30 — domyślne budżety natywnej usługi](p8/30-native-service-resource-budgets.md).

Checkpoint P8-C: [31 — inicjalizacja zasobów pakietu i handshake](p8/31-packaged-service-preparation.md).

Checkpoint P8-C: [32 — rzeczywisty odczyt stanu natywnej usługi](p8/32-native-service-status-observer.md).

Checkpoint P8-C: [33 — zasób API natywnej usługi](p8/33-native-service-api-resource.md).

Checkpoint P8-C: [34 — import OpenAPI z przypiętego buildu](p8/34-managed-openapi-import.md).

Checkpoint P8-C: [35 — regresja polecenia importu kontraktu](p8/35-managed-openapi-import-regression.md).

Checkpoint P8-C: [36 — historyczny build i pauza runnera](p8/36-historical-build-and-runner-pause.md).

Checkpoint P6-C/D: [75 — trwały skalar przez API](p6/75-durable-scalar-api.md).

Checkpoint P8-C: [37 — authoring przed attach runtime](p8/37-authoring-before-runtime-attach.md).

Checkpoint P8-C: [38 — wersje rzeczywistego toolchaina w receipt](p8/38-nightly-build-evidence.md).

Checkpoint P8-C: [39 — ścieżki launchera pod właścicielem blokady](p8/39-launcher-path-ownership.md).
