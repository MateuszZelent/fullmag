# Docker DEV i wielomateriałowy mixed-P1 FEM — plan wykonania

Data: 2026-10-19. Branch: `codex/docker-volume-only-implementation-20261018`.
Baza: `fc50a43efa6a19ed10e03e1f9a0060809014605f`. PR: #197.

## Cel i zakres

Dokończyć architekturę `docs/guides/docker-development-architecture.md`:
dwa stałe serwisy Compose wybranego checkoutu, build i runtime w tym samym
backendzie, readonly źródła, frontend HMR, przyrostowy cache i wszystkie dane
budowania w Docker volumes/BuildKit. Sesje, wyniki, projekty i ustawienia
pozostają w skonfigurowanym fizycznym storage Windows.

Użytkownik 19.10.2026 rozszerzył zakres o wielomateriałowy mixed-P1 FEM dla
`examples/permalloy_layer_cofeb_rings_relax_300nm.py`. Obowiązują rzeczywiste
stałe i instrukcje skryptu; jego stary docstring nie opisuje obecnej geometrii.
Nie zmieniamy GPU na CPU, pryzmatów na free-tet ani dwóch materiałów na jeden.
Odrębny smoke nie dowodzi wykonania tego modelu.

## Kolejne wyniki i odpowiedzialność

1. **Bootstrap Docker — root.** Naprawa pełnych wejść interpolacji Compose
   przy odczycie/zapisie receiptów oraz rozwiązywania logicznego klucza mountu
   do dokładnej external volume. Commit `48c52e530ab6e73505f4c78f63208a328aabd121`.
   Regresja najpierw odtworzyła brak dwóch zmiennych; 36 testów bootstrapu
   przechodzi. Rzeczywisty zarządzany bootstrap przeszedł do BuildKit.
2. **Kontrakt naukowy — agent dokumentacji.** Przed kodem zaktualizować
   kanoniczną notę 0106 i source-map, ADR 0021, masterplan oraz zakres capability
   matrix. Opisać mapowanie materiałów i komórek, fizykę rozłącznych ciał,
   współczynniki operatorów i granice interfejsów. Stan planned/implemented
   nie zastępuje kwalifikacji runtime.
3. **Python, mesher i planner — agent planner.** Rozszerzyć realną generację
   conforming shared-domain prism/pyramid/tet, certyfikat dokładnej warstwy,
   mapowanie body/region/material oraz lowering Ms/A/alpha i anisotropii.
   Nie zdejmować walidacji bez odpowiadającego jej wykonania. Zachować
   authored/requested/resolved identity i fail-closed dla nieobsłużonych zakresów.
4. **Natywne FEM — agent native.** Sprawdzić i rozszerzyć operatorowe użycie
   współczynników w exchange, demag source/recovery/energy, Zeemanie,
   anisotropii i metryce PG-BB dla CPU/GPU. Uzgodnić ABI i certyfikat z plannerem.
   Zachować GPU residency i brak niejawnego fallbacku.
5. **Weryfikacja źródeł — właściciele części.** Dodać regresje dodatnie i ujemne
   dla wielu materiałów, markerów, dokładnych warstw, geometrii, współczynników
   i granic nieobsługiwanych przypadków. Lekkie testy Python uruchamiać zgodnie
   z zakresem. Lokalne kompilowanie testów jednostkowych pozostaje zabronione;
   pełny build aplikacji wykonuje tylko stały backend. CI ma wcześniej
   autoryzowany wyjątek dla wymaganych kontroli tego zadania.
6. **Build i wykonanie — root.** Z natywnego Pythona Windows uruchomić
   `bootstrap_docker_toolchain.py --direct-development`, następnie
   `docker_dev.py up --source-root <ten checkout> --port 32871`.
   Obowiązuje grupa `fullmag-worktree-docker-volume-only-implementatio-670653a9f4702651`.
   Chronić działający backend innego worktree. Sprawdzić rzeczywiste mounty,
   gotowość API, Home oraz konkretny requested/resolved/executed GPU i artefakty.
   Exact rings, skrypt auto-Solve i wait-for-solve są osobnymi dowodami.
7. **Cykl DEV i dysk — root.** Potwierdzić restart bez zmian z tym samym ID
   i cache-hit, przyrostową zmianę backendu, HMR po zapisie Windows,
   trwałość danych użytkownika i brak nowych duplikatów technicznych.
   Mierzyć fizyczne miejsce Windows oraz Docker VM. Nie usuwać cudzych danych,
   wolumenów, aktywnego cache ani globalnie prune. Retencję pakietów
   sprawdzić osobno; brak ogólnego GC/quota raportować jawnie.
8. **Integracja — root i niezależny reviewer.** Zapisane logiczne części
   zweryfikować, commit/push, aktualny PR opis, wymagane CI i review,
   merge, fast-forward głównego mastera z zachowaniem cudzych zmian.
   Cleanup tylko po wykazaniu braku użycia i cudzych/unikalnych zmian;
   aktywne mounty albo rzeczywiste cudze zmiany blokują automatyczne
   usunięcie worktree i muszą trafić do rejestru. Pozorne zmiany typu
   `.claude/skills` z odczytu Windows junction przez WSL weryfikować natywnym Git;
   sam status WSL nie dowodzi zmiany tych plików.

## Warunek ukończenia

Sukces wymaga dowodów dla wszystkich powyższych punktów. Zielony source test,
build, otwarty port, wykryte GPU ani sam status Running nie zastępują
odpowiednio UI, poprawnego solvera, konkretnego urządzenia i zakończonego runu.
Nie uznawać samego istnienia named volumes za dowód ograniczonego wzrostu dysku.

## Checkpoint 19.10.2026 — kolejne fragmenty

- `9eaab7740bdb497727becca1c4c221be5d8a9004`: kontrakt naukowy v2 zapisany;
  status planned, bez kwalifikacji runtime.
- `0b92e2ebd3e0f9a7c0e0405b66e6f6ff9c38670b`: wspólna walidacja rzeczywistego backingu backend/frontend
  named volumes; świeży inspect bez tworzenia zasobów przed każdym `compose up`.
  Weryfikacja: backend cache 16/16, bootstrap 36/36, frontend cache 10/10;
  runtime 100 przypadków, wynik OK, 3 pominięte. Niezależne source review
  bez pozostałego blokera. Historyczne pełne inspect frontendu pozostaje
  w descriptorze bieżącego procesu, a receipt zachowuje skróconą tożsamość;
  nie jest to dowód trwałego zapisu całego historycznego backingu.
- Native Python Windows: `setup_docker.py --check` PASS; Docker Linux 29.8.1,
  Compose 5.5.1, RTX 4080 SUPER wykryta. Nie dowodzi to wykonania solvera GPU.
- `9ff9fdc5b12b5cc96bcf9c86e336d0ec92d9f675`: deklaratywna polityka
  izolowanego probe manifestu w Compose; 39/39 lekkich testów bootstrapu PASS.
  Zarządzany bootstrap ukończony (exit 0), ponowny build wykorzystał cache
  wszystkich ciężkich warstw i zachował image ID
  `sha256:bc1bf072d62d417776a330b9c48491b84f27fce50f78d79cb1556df2738a5476`.
  Manifest zależności SHA-256:
  `daac69df4c0a985f2818a94490a226426e7670cba64bcc1076e494e7192fdbfa`.
  Nie jest to jeszcze dowód przyrostowego buildu aplikacji.
- Realny start ujawnił brak source commit podczas interpolacji helper image
  oraz zgubione zmienne Compose maintenance. Poprawki launchera: 34/34
  lekkich regresji PASS. Kolejny start ujawnił zbyt wczesny handoff katalogu
  runtime-control do UID 65532: CAP_CHOWN nie umożliwia późniejszego mkdir.
  Tworzenie runtime-services przeniesiono przed handoff; 12/12 testów Python
  PASS, w tym regresja kolejności i ponownego provisioningu. Start ponowiony
  kanonicznym launcherem, bez osobnego kontenera budującego backend.
- Pomiar C: 59 722 297 344 bajtów wolnych. Niczego nie usuwano.
- Native mixed-P1: kod i fixtures przygotowane, review w toku; lokalnej
  kompilacji testów C++ nie wykonywano. Planner/mesher i realny operator probe
  pozostają w implementacji. Dokładny rings i UI tej grupy NOT VERIFIED.

### Checkpoint po drugim rzeczywistym starcie

- Run `87be4fd854104870bbf098c79d9228d3`: oba serwisy zakończone błędem,
  launcher exit 1 / `failed_resources_retained`. Backend wykonał dwa zgodne
  odczyty 9024 plików (134835 ms), synchronizację cienia (408834 ms) i część
  Cargo (139283 ms), po czym kompilator odrzucił niejednoznaczny eksport
  walidatora V2. Jawny eksport jest poprawiony w aktualnych źródłach.
  To dowód realnej kompilacji w stałym `backend`, bez dowodu gotowego pakietu.
- Frontend: Docker utworzył rodziców zagnieżdżonych bindów jako root;
  UID 65532 nie mógł zapisać `components.json`. Commit
  `1d5cb6e19c60fe465a5bf1abadd081bed155606c` przygotowuje dokładne katalogi
  obrazu oraz bounded maintenance wyłącznie named volume, bez rekurencyjnego
  chown i bez źródeł hosta. Regresje: maintenance 16 OK / 1 skip, frontend
  v2 13 OK, runtime-control 9 OK, runtime 102 OK / 3 skip. Start NOT VERIFIED.
- Zatrzymane definicje obu serwisów i pusta sieć wycofane po sprawdzeniu
  etykiet, image ID, readonly root, braku OWNER/process receipt i pustego
  session-store. Wolumeny, cache, pierwotne receipty i dane użytkownika
  zachowane. Dowód: control `docker-dev/retirement/87be4fd854104870bbf098c79d9228d3.json`.
- Commit `da6e6b260f977f07e9f5345cde60357a80789fc8`: poprawiony explicit
  source-root w wrapperze codegen, 15 lekkich testów PASS. Skill zawiera
  aktualną deltę 614 aktywnych recept; realny codegen pozostaje NOT VERIFIED.
- Python V2 consumer: schema-native PyO3 dispatch, persistence, receipt,
  fingerprinty i rozdzielony remesh V1/V2. Lekki corpus: 7 passed/14 skipped
  oraz 22 passed/1 skipped. Niezależny review wykrył pominięte V2 airbox
  marker i dane materiałów remesh; poprawki przed następnym capture.
- Skill `fullmag-build-stage-cleanup` nie jest dostępny. Stosowano governance;
  nie wykonano prune ani usunięcia build volumes. Po hostowym source check
  agenta pozostało siedem wskazanych plików `cpython-310.pyc` w checkoutcie;
  nie są dowodem builda Docker i wymagają kontrolowanej kwalifikacji.

### Checkpoint — build aplikacji i poprawki przed wykonaniem

- Zintegrowany master `b48b2934df60b074d00fce7b01ea040180505ad4` wniósł
  kanoniczną ścieżkę `docker_volume_dev.py` / `docker_build_control.py`.
  Commit `d22e82d26882d5cf6303eaf84b59a1cb5d40b50d` zachowuje pełne
  deklaracje wolumenów i wykonuje Compose preflight przed mutacją daemona.
  Wymagane CI tego commita PASS; nie obejmuje to niezacommitowanego mixed V2.
- Próba `3ed04665d1334e64bbee354da7df2bb0`, wznowienie
  `211aa96580ed4eed82195363da351f48`: ten sam backend `bcfa73a93ce0`.
  Capture 144,448 s; przyrostowa synchronizacja cienia 3,075 s. Pełny build
  binariów i rozszerzenia Python PASS (652,724 s), pakiet 24 plików: 7,314 s.
  API nie wystartowało: nested mount utworzył rodzica `session-store`,
  zawierającego wyłącznie pusty `runtime-services`; inicjalizator potraktował
  techniczny scaffold jako częściowy store. Poprawka nie może dopuszczać
  inicjalizacji dowolnych istniejących lub niepustych danych.
- Przegląd mixed V2 wykrył spłaszczanie markerów ciał w `dispatch` i fasadzie
  `fem::plan`; normalizatory zachowują teraz certyfikowane markery V2.
  Poprawka far-air utrzymuje osobne cele ciał 20/25 nm oraz grading
  10→500 nm. Jej lekka regresja Gmsh mock PASS.
- Home: rzeczywisty Chromium i HTTP 200, stabilny przez 15 s bez migania.
  HMR aktywnego `HomeSection`: zmiana po 54,242 s, powrót po 16,102 s;
  WebSocket HMR działał, liczba pełnych load pozostała 1. Źródło przywrócone
  bajtowo; wydajność HMR wymaga dalszej oceny. Dowody w frontend named volume
  `browser-proof/`, bez eksportu obrazów do hostowego storage.
- Polecenie aktywacji `.py` w istniejącej grupie: pięć lekkich regresji PASS,
  sześć regresji granicy argv PASS. Nadal wymagany rzeczywisty test API.
- Lokalnych testów kompilowanych nie budowano. Exact rings GPU, operator
  CPU/GPU, gotowość native runtime, codegen i restarty pozostają NOT VERIFIED.
  Nie usuwano cache, wolumenów, sesji ani danych innych grup.

- Commit `40fb3456231e08ecd0e4eba14774ba018e60d7c3` zapisuje aktywację
  skryptu bez lifecycle kontenerów. Kolejny review wykrył import helpera
  launchera przy innym wybranym worktree; poprawka korzysta z istniejącego
  loadera zweryfikowanych bajtów helpera wybranych źródeł. Bieżący corpus:
  12 regresji aktywacji + 6 granicy argv PASS.
- Przed następną próbą jawne `recreate-volume --fresh-state` zachowa poprzedni
  pusty scaffold i wszystkie wolumeny, a nowa próba przypnie GPU oraz Zarr
  dla operator probe. Odtworzenie jest zmianą konfiguracji; nie dowodzi
  zachowania container ID przy zwykłym restarcie.

## Checkpoint: cache i wspólny host ledger

- HEAD `a3bdc3bc8e4ef8bc6ef9d82171b9fe1734ef402b`; mieszany FEM V2
  pozostaje zmianą roboczą, bez deklaracji kwalifikacji fizyki.
- Próba `460e057014ee435fb3731facdecc7b98`: przyrostowy build aplikacji
  PASS 119,025 s; pakiet 24 plików 6,068 s. Docker-created Windows scaffold
  miał tryb 0755 i blokował zapis `WRITER.lock` przez UID usługi.
- Operacja `repair-empty-scaffold3d959ff562084bbda1f80c868e21ece3`
  potwierdziła zatrzymany własny backend, brak ownera i dokładnie cztery
  puste katalogi. Odtworzono je natywnie na Windows; widok Docker potwierdził
  0777. Usuniętych plików: 0; wolumeny i cache zachowane. Trwała poprawka
  launchera ma przygotować wyłącznie nowy namespace przed mountem Dockera.
- Resume `1795c6cddb214b7e93387376a3d4e0a0`: rzeczywiste
  `backend_package_cache_hit=true`, bez kompilacji Cargo, ten sam backend
  `469ed8bad549`. Store przeszedł inicjalizację. API nadal NOT VERIFIED:
  inicjalizacja hosta odrzuciła zmianę readiness, gdy inny worktree trzyma
  inventory owner. Jego backend pozostaje nienaruszony.
- Przyczyną jest mieszanie tożsamości binarki z generacją współdzielonych
  faktów hosta. Trwa analiza zgodnego ponownego użycia generacji z niezależną
  lokalną atestacją natywnego ABI; nie wolno usuwać kontroli źródeł, przejmować
  ownera ani resetować rezerwacji.
- Zatrzymano zamrożenie źródeł: codegen wymaga działającego backendu i będzie
  wykonany po poprawce startu. Frontend tej grupy pozostaje healthy pod 32871.

## Checkpoint: działający backend i Home

- Commit `8d2a5d08d51098f3f453d5a380f3fb1ab7816eb5` zapisuje naprawę
  wspólnej generacji readiness z niezależnym lokalnym ABI attestation.
  Niezależny review wykrył podwójny probe GPU w heartbeat; usunięto go przed
  buildem, zachowując warm recovery i wszystkie fences.
- Odtworzenie własnych zatrzymanych usług `fe9cd4366c6e44539889b156d7da3b7a`
  zachowało wolumeny oraz poprzedni Windows namespace. Zależności/toolchain
  cache hit. Nowy helper wymagał nowego obrazu
  `sha256:6e459ecfd541ee18db46f82d372ddf2f5f5c6cc64249197d2c4d22e003f188fa`.
- Development `0350aefc4a034f0f82ccb7eaa51fe319`: **succeeded**; Compose SHA
  `3d2a18b7ec251b39eda484f632c1f3be2b7fc02530e9cbc0dffb167801a87931`.
  Backend `ceb3eca447590ee18a165d5ce55cb2f5257aa8286c0432c8b9d3b29fce159c26`,
  frontend `121642047f56`, port 32871. Capture 113,619 s, sync 3,341 s,
  make PASS 156,188 s, pakiet 24 plików 5,985 s, verify 1,441 s.
  Cache nadal dokładnie `fullmag-backend-v2-dfed102145bdada82a7b5883-build`
  i odpowiadający mu `-package`; bez powtórnego budowania zależności.
- API/native runtime zgłosiły ready. Health i compute nodes przez port
  frontendu HTTP 200; aktualny snapshot hosta, RTX 4080 SUPER. Drugi worktree
  pozostał zdrowy, jego owner/generacja nie zostały przejęte.
- Managed OpenAPI codegen **succeeded** w istniejących usługach, receipt
  `backend/codegen/openapi-v2/47924feee58459ab78739eaeaff85b079afcca7713f7c2beea9483c29b5ed4dc.json`.
  Opublikowano wyłącznie cztery wersjonowane artefakty API.
- Chromium: Home HTTP 200, sześć próbek przez 10 s bez Checking for sessions
  i Session unavailable, brak page errors. Przyciski FDM/FEM enabled; bez ich
  klikania, aby zachować pusty Workspace do testu skryptu. Compute probe failed
  zniknął; FDM CPU/GPU Available, FEM CPU/GPU Experimental (bez promocji do
  kwalifikacji produkcyjnej). Dowody `browser-proof/home-backend-ready.*`.
- Exact rings w głównym checkoutcie i worktree mają identyczne bajty, SHA
  `86c67df4c48c04bf2e4b51ed54ceb61ab6ef4667de4be2adb54eb31e82334797`.
  Dwie próby aktywacji zatrzymały się **przed POST**: błędna nazwa źródeł
  backendu w walidatorze, następnie Windowsowy zapis ścieżki POSIX helpera.
  Backend pozostaje zdrowy; brak uruchomionej symulacji i brak nowego buildu.
- Draft prywatnego retirementu Workspace w `/tmp` **nie jest zastosowany**:
  review ujawnił błędy publikacji, epok, proofów i autoryzacji. Nie stanowi
  dowodu wdrożonej obsługi kolejnych skryptów po aktywnej sesji.

## Checkpoint: pierwsza aktywacja dokładnego rings

- Request `rings-mixed-v2-gpu-20261019-1` dotarł do przygotowania siatki,
  ale zakończył się autorytatywnym HTTP 400 / `bad_request` w
  `attach_disconnected_mixed_p1_certificate_v2`. **Nie powstał RunIntent;
  obliczenia GPU nie zostały wykonane.** Backend pozostał healthy.
- Historyczny launcher błędnie oznaczył odrzucenie jako sukces. Poprawka
  rozdziela attempt operacji i developmentu oraz zwraca exit 2 dla odrzucenia.
  Lekkie regresje: activation 20/20, startup 29/29 na Windows i Linux.
  Rzeczywisty replay tego samego requestu: exit 2, `failed-confirmed`, nowy
  poprawny attempt operacji `71e82319568646438c35f0678f2549dc`, bez ponownego
  Solve ani buildu. Pierwotny receipt odrzucenia pozostaje zachowany.
- Komunikat helpera obcina traceback do pierwszych 2048 znaków, ukrywając
  końcowy wyjątek. Pełna przyczyna certyfikacji pozostaje do odczytu;
  nie zmieniono progów jakości ani authored parametrów modelu.
- Ciężkie przygotowanie Gmsh trzyma blokadę transition sesji i opóźnia jej
  odczyty; health nadal odpowiada. Draft rozdzielający prepare/commit jest
  w niezależnym review i nie został zastosowany ani zbudowany.
- Commit `7a8b92a2db586d4bd57d8bae5cdb5e1548596537`: nowy Windows
  namespace przygotowany natywnie przed mountem, rozpoznanie wyłącznie pustego
  scaffoldu nested volume. Cztery lekkie regresje i rzeczywisty start PASS;
  testów Rust lokalnie nie kompilowano.
- Commit `e2afbe006c7324cb43570fe74f36a558d364c546`: per-request receipts,
  walidacja Windows/POSIX, rozdzielone attempt IDs, prawidłowy exit odrzucenia
  i zachowanie końcowej przyczyny długiego błędu. Niezależny source review PASS;
  activation 20/20 oraz startup 30/30, także natywnie na Windows.
  Branch wypchnięty do remote; CI w toku. Mixed V2 nadal niezacommitowany.
- Odczyt health o `2026-10-19T09:03:22Z`: `status=ok`, ponad 50 minut po
  zapisanym starcie API `08:12:40Z`; nie używano błędnego pola `uptime_seconds`
  do obliczania tego czasu. Nie dowodzi to wykonania solvera.
- Diagnostyka siatki działa w istniejącym backendzie, bez mutacji API,
  RunIntent lub Solve. Pliki wyłącznie w control volume. Pierwszy attempt
  `be2ff6449f7d4ffba414853163e8ae00` ujawnił błąd instrumentacji `vars()` na
  slotted dataclass; nie jest to przyczyna błędu meshera. Instrumentacja
  poprawiona tak, by zachowanie danych nie mogło zasłonić właściwego wyjątku;
  drugi attempt w toku. Limit pojedynczego zapisu raw arrays: 2 GiB.

## Checkpoint: przyczyna certyfikacji ustalona na zachowanej siatce

- Diagnostyka `991a6235028647d0bb026f9b9b7edee1` zakończona; to wyłącznie
  przygotowanie, nie wykonanie solvera. Siatka: 183 766 węzłów, 1 087 250
  komórek (1 063 188 tet4, 482 pyramid5, 23 580 prism6). Zachowany jeden NPZ
  ma 15 933 629 bajtów, SHA-256
  `996a0d14f3f5e814a7d3edb6b4e40664b1866e37f759853e10f368c1d1c59113`.
  Leży w control volume pod `mesh-diagnostic/attempts/<attempt>/`; kwargs,
  pełny traceback i małe raporty pomiarów są obok. Bez eksportu do Windows.
- Natywny walidator błędnie porównywał transition shell z AABB unii obu ciał.
  Box ma z ±0,8 nm, ring 10,8–310,8 nm, shell ±5,3 nm. Wszystkie sześć
  offsetów względem Boxa wynosi 4,5 nm; offset względem unii ma błędne
  −305,5 nm na górnej stronie. Naprawa wybiera jednoznaczny region
  `exact_sweep`; ogólne bounds nadal obejmują oba ciała.
- Drugi błąd: redukcja sekwencyjna 1,09 mln objętości dawała względny błąd
  wspólnej domeny 3,9086e-14, NumPy 2,1836e-16, stabilne `math.fsum` 0.
  Sam floor `16 * EPSILON` nie wystarczał (różnica 3,8868e-14). Dodano
  kompensowane redukcje Neumaiera, zachowując dotychczasowe tolerancje.
  Probe portuje bezpośrednie determinanty Rust dla tet/pyramid; pryzmaty
  używają referencji Pythona. To diagnostyka, nie wynik kwalifikacji natywnej.
- Source review wykrył jeszcze runnerową bramkę V1 w
  `require_supported_fem_topology`, pomijającą certyfikat V2. Poprawka w toku
  przed następnym buildem, aby nie ponawiać kosztownej próby bez tej zmiany.
- Poprawka blokady API zastosowana do źródeł: prepare poza transition,
  ponowna walidacja kontekstu, synchroniczny commit/bind pod write guardem,
  publikacja realtime z zachowaniem transition oraz blokada pięciu komend
  compute w stanie `activating`. Testy Rust napisane, lokalnie niekompilowane;
  rzeczywisty build i responsywność podczas Gmsh pozostają NOT VERIFIED.
  Częściowy commit RunIntent→catalog jest zastanym ograniczeniem recovery;
  poprawka nie otwiera automatycznego retry ani nie resetuje ownera.

## Checkpoint: gotowość do przebudowy z poprawioną certyfikacją

- Wszystkie cztery workflow CI dla `e2afbe006c7324cb43570fe74f36a558d364c546`
  przeszły. Nie obejmują jeszcze niezacommitowanych zmian mixed V2 i blokady API.
- Runner obsługuje teraz certyfikat V2 przez pełny walidator siatki oraz
  istniejącą politykę planera: BB, NonlinearCg i LlgOverdamped. Dopasowanie
  algorytmu studium i planu jest obowiązkowe; TPI, time evolution i brak planu
  pozostają odrzucone. Testy zachowania zapisane, lokalnie niekompilowane.
- Odczyt przed zatrzymaniem potwierdził `startup_failed`, pustą kolejkę,
  brak bieżącego runu (404), gotowy runtime, brak katalogów runów w store
  oraz 10/10 rezerwacji hosta w stanie `released`. To nie jest dowód Solve.
- Rozwijana wąska recepta `docker-dev-stop-unadmitted` przypina grupę,
  kontenery, obraz, request, źródła i zachowany marker odrzucenia. Przed
  zatrzymaniem wymaga powyższych dowodów, a po nim terminalnego drain.
  Nie czyści ledgera, nie przejmuje inventory ownera i nie usuwa wolumenów.
  Wykonanie zatrzymania i następnego buildu pozostaje NOT VERIFIED.
- Pomiar przed następnym buildem: C: 45,17 GiB wolnego. Cache i diagnostyczny
  NPZ pozostawiono; niczego nie usuwano.

## Checkpoint: rzeczywisty stop ujawnił błąd aliasu technicznego

- Recepta stopu przeszła source review. Regresje Windows/Linux guest-path,
  ponownej kontroli frontendu i ograniczonego czekania na writer: 21/21.
- Attempt `2da781b43429465b9829a5f51342b802` odmówił przy chwilowo zajętym
  writerze ledgera i prawidłowo przywrócił frontend. Nie resetowano blokady.
- Attempt `d02ab11fd52242f3831c36f8294a6bec` zatrzymał frontend kodem 0,
  lecz backend zakończył się kodem 1. Rust odrzucił `--expected-owner`
  przekazany z `/opt/fullmag/runtime-control/runtime-services`, ponieważ
  wymaga pina wewnątrz accepted store. Oba widoki są tym samym submountem.
- Poprawka Pythona zachowuje zapis wyłącznie w volume, weryfikuje równość
  bajtów obu aliasów i przekazuje CLI ścieżkę accepted-store. Guard Rust
  pozostaje bez zmian. Suite Python runtime: 103 testy, 3 skipped, PASS.
- Obie usługi zadania są obecnie zatrzymane. Stan historyczny: process receipt
  `shutdown_unknown`, `OWNER.json` nadal `ready`, logi dzieci tylko boot/ready.
  Nie ma dowodu `drained`; nie wolno go dopisywać ani zmieniać ręcznie ownera.
  Dotychczasowe `recover_unknown_empty` słusznie odrzuca ten przypadek.
- Projektowany jest osobny typowany wariant odzyskania pustego store po
  faktycznym zakończeniu prywatnej przestrzeni procesów Docker, zgodnie z
  wcześniejszą zgodą użytkownika na kontrolowane odzyskiwanie. Ma zachować
  historię i wszystkie blokady, nie uruchamiać Solve i nie zmieniać istniejącej
  semantyki v1. Do czasu implementacji i review: NOT VERIFIED.

## Checkpoint: typowane odzyskanie zakończonego namespace

- Poprawka aliasu owner-pin jest zapisana w `1914f31bebb22fa863d66b0ea907b9eebcc78aaf`.
  ADR 0063 (`880aafc818773eca9632ff76d04af334ea39770d`) opisuje osobne,
  jawne odzyskanie pustego store po zakończeniu prywatnego namespace Docker.
- Natywny kontrakt, blokady, niezmienne archiwum i CLI zapisano w
  `45c97b67a9d034f0c6ff269686c8518fe720c434`. Przejście `ready/unknown → failed`
  wymaga przypiętych dowodów; nie udaje `drained`, nie zwalnia rezerwacji
  i nie zmienia inventory/readiness obcej, działającej grupy.
- CI wykryło brak importu stałej w nowym module testowym. Poprawka
  `1321d509c2902da35312410e2132bc966b330a68` jest wypchnięta; nowe CI trwa.
  Lokalnie testów Rust nie kompilowano. Source review i parser nie są
  dowodem runtime.
- Pod blokadą grupy opublikowano operator authorization
  `container-recovery/operator-authorizations/1eccf696-733d-4506-bbd7-9fd79ea602fa/authorization.json`,
  SHA-256 `ffb86cb78a971706388f0c6ab6906cc3fd246f166d0f2efc2c8baf9a728d3ed4`.
  Niezmienna kopia poprzedniego dziennika stopu jest obok. To wyłącznie
  dokument autoryzacji, nie wykonane odzyskanie: owner i kontenery pozostały
  bez zmian. Attempt publikacji: `d0352b79d1744c4087b7db8d886d91d9`.
- Równolegle wdrażane są hostowy orchestrator oraz mostek entrypoint → CLI,
  z jednorazowym zużyciem dowodów i zachowaniem zwykłego restartu. Review
  wychwyciło rozbieżności raw/canonical SHA i stanów stopu; poprawki trwają.
  Build nowego backendu, ponowny start UI i Solve dokładnego skryptu GPU
  pozostają NOT VERIFIED. Wolumenów, cache i danych użytkownika nie usuwano.

## Checkpoint: źródła zamrożone przed uruchomieniem recovery

- Mixed-P1 zapisano w `bfc0b4c36f448312776f64891945c1b4844c25fe`.
  CI znalazło błędną nazwę helpera field-drive; minimalna poprawka
  `58bcd4f66c4f23f60d9a1310f9c359ca624eae89` używa istniejącej semantyki
  aktywnego stage. Oba commity są na branchu PR.
- Mostek PID 1 → typowane recovery (`4958493d5`) przeszedł 53 testy Pythona;
  poprawka responsywności API jest zapisana w `808e122939c462a2fbaaeaf8cedf800fd17e5525`.
  Wszystkie zmiany Rust nadal wymagają aktualnego buildu/runtime i CI.
- Hostowy producer przeszedł niezależny final review bez blokujących findings.
  Wznowienie obsługuje prepared-only, częściowe usunięcie i absence, zawsze
  pod lifecycle lease, bez zmiany przypiętego requestu. Świeże dowody ownera,
  konfiguracji, store i ledgera oraz certyfikat Windows są kontrolowane przed
  usunięciem. Sam brak kontenera wymaga jednoznacznego `No such object`.
- Targeted producer/start regression: 13/13 PASS (Python, bez Cargo/CMake).
  Odczytowy preflight na rzeczywistych danych przeszedł do celowego przerwania
  przed buildem. Nie wykonał rm ani zmiany ownera.
- Zarządzane `docker-dev-images` zakończone w grupie zadania: toolchain
  `c8a3d6fc26824513b90a5c99de0f95b4` CACHE HIT; helper dev
  `27947a60abb04303b6fcdb96e4aaff9a`; helper backend
  `195a302a549b474da904f6919475598e`. Nowy backend image:
  `sha256:930e286f27b5b421a9aa74ed090b5cbf521b5598ae0d66c9e8804a7087c957c5`.
  Kompilacja aplikacji nie odbywała się w tych etapach.
- Po przygotowaniu obrazów C: 48,01 GiB wolnego. Żadnych wolumenów, cache,
  wyników ani obcej grupy nie usuwano. Następny krok: rzeczywista recepta
  recovery → build aplikacji w backendzie → API/UI → dokładny skrypt GPU.

## Checkpoint: pierwsza rzeczywista próba recovery i wznowienie

- Attempt `71856466c94945a5afb1da11624b51ef` przeszedł kontrole, zachował
  request/manifest/prepared/absence i usunął dokładnie stare dwa zatrzymane
  kontenery. Nie usunięto żadnego wolumenu ani danych Windows.
- Start zatrzymała kontrola grupy: uznała własny aktywny helper `build-control`
  (trzymający lifecycle lease) za konflikt aplikacji. Aplikacja nie rozpoczęła
  kompilacji ani nowego native recovery. Stan operacji: failed-confirmed.
- Wznowienie tego samego requestu sprawdzono na rzeczywistych zachowanych
  sidecarach: odczytowy preflight przeszedł do celowego przerwania przed
  buildem. Nie trzeba odtwarzać starych kontenerów ani zmieniać ownera.
- Poprawka dopuszcza wyłącznie konkretny zweryfikowany helper trzymanej
  operacji; wszystkie inne kontenery i obce sieci nadal blokują start.
  Rzeczywisty build/API/Solve pozostają NOT VERIFIED do kolejnej próby.

- Próba `0ce695d030f54b6892187f8fe2830476` wykazała brak source project-id
  i checkout-kind w etykietach helpera. Dodano je wyłącznie do kontenerów
  pomocniczych, bez zmiany etykiet/tożsamości istniejących wolumenów.
  Regresje receipts: 16/16 PASS; guard: 5/5 PASS. Rzeczywisty guard pod lease
  przeszedł (`guard-inspection/attempts/ed109e6d99614653b151f172592af713`).
  Owner, dane aplikacji i cache pozostały bez zmian; build aplikacji nadal
  nie rozpoczął się w tych próbach.


## Uproszczone komendy DEV — 19.10.2026

- `just docker-dev` rozwiązuje źródła i port z argumentów, środowiska, wybranego
  worktree oraz ustawień operatora; toolchain i obrazy stosują ten sam wybór.
- Kreator zapisuje `FULLMAG_SOURCE_ROOT` i `FULLMAG_HTTP_PORT` w głównym `.env`;
  zachowany jest odczyt starszego `index/docker-host-settings.json`.
- `just docker-dev-script "examples/model.py"` odkrywa dokładne piny aktualnej,
  zweryfikowanej pary backend/frontend. Nie buduje, nie restartuje i nie odtwarza
  usług. Stare jawne argumenty zachowuje `docker-dev-script-pinned`.
- Weryfikacja: 81 interpreted Python checks (defaults, setup, activation,
  bootstrap); nowe przypadki obejmują forwarding ścisłej powłoki, zgodność grupy
  etapów, deduplikację tej samej pary i jawnie nadpisany port. `bash -n`: PASS.
  Nie kompilowano lokalnych testów Rust.
- Żywa aktywacja nowego skrótu: NOT VERIFIED, backend nie jest zdrowy.
  Restart istniejącej grupy na d739 potwierdził `backend_package_cache_hit=true`,
  ale ponownie zakończył się `StoreWriterBusy` w odzyskiwaniu host ledger;
  nie stanowi to dowodu wykonania skryptu ani gotowego backendu.
- Stan źródeł/grupy: istniejący worktree zadania, PR #197; nie przenoszono cache,
  nie usuwano wolumenów ani wyników. Integracja na master i kwalifikacja runtime
  pozostają niedokończone.

## Decyzja integracyjna użytkownika — 19.10.2026

Użytkownik jawnie polecił „to zrob merge mimio to” po informacji, że PR #197
nie jest scalony i CI nie jest zielone. Integracja ma użyć normalnego merge PR
bez obchodzenia ochrony brancha; ta decyzja nie jest kwalifikacją runtime ani
fizyki. Wszystkie przygotowane poprawki są dołączane przed merge.

Dodatkowe checkpointy: `9cd4654be4ddea228c30e0e52886bd7bed5eed9f` (fixture’y CI),
`05ef8fcfae2055541b99edf31926f363a85375cc` (bounded writer retry),
`9a6393c9cf1b558b7181eaa57b40ebbc7818f2a8` (P1 konfiguratora),
`9b185c4479d2b795fe0ed4f28c3651967f8b7abc` (ostatni mock startup-script), `da1ba3a72c9c8caed113030da34b2415cd8975d8` (przenośne testy),
`38430ecc936c72510059ce5054be7092f846f229` (wymagany katalog fixture’u Rust). Ostatnie 50 testów Windows oraz 20 zmienionych testów Linux: PASS;
30 testów startup-script: PASS. Walidator noty 0106 i 41 testów kontraktu
dokumentacji: PASS. Poprzednie CI 9a639 miało 397/398 testów session PASS;
pozostały fixture poprawiono, bez lokalnej kompilacji testów Rust.

Review nie ma już Required/P1 w nowych defaults/setup. Istniejące ograniczenie
apostrofów w jawnych argumentach ścisłej powłoki pozostaje P2. NOT VERIFIED:
aktualny live start API po bounded retry, aktywacja nowego skrótu, exact rings
i operator/parity CPU/GPU. Nie usuwano cache, wolumenów ani wyników.

## Checkpoint 20.10.2026 — ponowne restarty odtworzonego modelu

- PR #205 scalony na remote `master` jako
  `bb50223a30562ce9d6f85d0ee410760d34f1e038`. Worktree zadania jest na tej bazie.
  Lokalny główny `master` pozostał na `759c1e66799c0c8b28c4c8974ef38a7f676bb0bd`:
  fast-forward blokują cudze zmiany `justfile`; nie wykonano stash/reset.
- Poprawka restartów rozdziela historyczny dowód pierwszej awarii od kolejnych
  poprawnie zamkniętych generacji API. Natywny ACK jest przypięty do instancji,
  a drain zachowuje surowe archiwa procesu i obu stanów ownera. Publikacja
  jest create-only, z identycznym replayem; konflikt nie nadpisuje dowodu.
- Interpreted checks w tej samej grupie Compose: 117 przypadków, 3 pominięte,
  wynik OK. Receipt w control volume:
  `verification/interpreted-attempts/bceeee3b00d245749f1f969441f80006.json`.
  Test obejmuje trzy kolejne generacje held, terminalny ACK, zmianę surowego
  archiwum i rzeczywisty wyścig dwóch writerów. Symuluje wynik ACK; nie dowodzi
  natywnej decyzji katalogu, wykonania solvera ani restartu żywego backendu.
- Audyt starego runu `fullmag-master` wykazał brak admission, próby workera,
  lease i rezerwacji hosta. Istniejący cancellation intent nadal wymaga
  kanonicznej projekcji do katalogu. Nie utworzono fałszywego WorkerNoSpawn,
  nie zmieniono schematu shared ledgera i nie zwolniono obcych zasobów.
- Build zależności nadal działa w istniejącej próbie recreate; przy tym
  checkpointcie MFEM/CUDA osiągnął 254/269. Nie uruchomiono drugiego buildu,
  nie usunięto cache, wolumenów ani wyników. Bieżący build, natywne testy CI,
  restart API, browser/WebGL, exact rings, kolejne skrypty, HMR i retencja
  pozostają osobnymi, niedokończonymi bramkami pełnego zadania.

- Review natywne: każda generacja ponownie sprawdza bieżący projekt Compose,
  źródła i control volume; starsze regresje zostały zachowane. Parser Rust
  w helperze tej grupy PASS, receipt
  `verification/rust-parse-attempts/8423f4eebfb446ceafb3044798f61b13.json`.
  To dowód składni, bez lokalnego Cargo i bez kompilacji testów jednostkowych.
