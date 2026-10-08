# Dyspersja i analiza modów — UI

## Bieżący stan — 08.10.2026, po naprawie katalogu artefaktów

| Zadanie | Stan | Dowód / pozostała praca |
|---|---|---|
| U1 — dane i tożsamość | Zrealizowane | CI SUCCESS; realny signed sweep, dokładny owner próbek, osobna tożsamość Gamma |
| U2 — wykres | Zrealizowane dla demonstratora | 7 namalowanych i klikalnych punktów; finalna skala Frequency i symbole 7 px potwierdzone screenshotem |
| U3 — punkt → mod | Zrealizowane dla demonstratora | Browser PASS dla ujemnego k, Gamma i dodatniego k |
| U4 — pola zespolone | Zrealizowane dla demonstratora | Browser real/imag/abs/phase, faza, animacja, Focus, WebGL PASS |
| U5 — małe obliczenie | Zrealizowane w zakresie UI | 7/7 FEM, 38,3 s; bez certyfikacji kompletności okna i zbieżności |
| U6 — weryfikacja | Weryfikacja końcowa | CI `37832383619` SUCCESS; browser trzech próbek PASS; regresje ostatniego fragmentu skali wymagają końcowego CI |
| U7 — dostarczenie/integracja | Review / częściowo zrealizowane | Commity/push wykonane; merge całego odziedziczonego solvera do mastera pozostaje zablokowany jego szerszym zakresem i bramkami S00–S12 |

Wynik jest przeznaczony do demonstracji UI. Brak `geometry_identity` jest
jawnie raportowany (`NOT_VERIFIED`), a obliczenie nearest/selected_only nie
certyfikuje kompletności pasm. Żaden z tych braków nie jest maskowany przez UI.

## Cel i izolacja

Czytelny wykres obliczonej dyspersji oraz przejście od punktu do konkretnego
modu, jego parametrów i pola zespolonego w tym samym workspace. Zmiany
powstają na branchu codex/dispersion-mode-ui-20261008 z bazowego commita
1195663c67943cb57f6716bdd73639d9fe917e4f. Poprzednie worktree zawiera
równoległe zmiany API/pól i nie jest nadpisywane. Cały wcześniejszy plan
S00–S12 nadal obowiązuje; ten etap realizuje priorytet UI.

## Zadania i dowody odbioru

1. U1 — zachować pełną tożsamość punktów, falowe wektory SI i wiązanie
   wyboru z istniejącymi hooks/API. Centralny wykres oferuje współrzędną
   ścieżki oraz dostępne podpisane składowe k; nie odgaduje znaku z path_s.
   Jednostki prezentacji GHz i rad/µm nie zmieniają danych SI. Testy modelu
   obejmują ujemne k, brak wektora, crossing/powtarzane k i stabilne indeksy.
2. U2 — wykres i lista pasm: czytelne osie, zoom, legenda, punkty numeryczne
   odróżnione od analityki, zaznaczenie i eksport. Dane pozostają ograniczone,
   ECharts ma jednego właściciela i sprzątanie zasobów.
3. U3 — wybór punktu/modu: rzeczywiste częstotliwość, k, indeks/pasmo,
   residual, damping/linewidth, dostępność pola i provenance. Akcja pola
   przechodzi przez kernel commands do istniejącego viewportu.
4. U4 — analiza pola: real/imag/abs/phase, składowa i faza, legenda skali
   oraz istniejące sterowanie glyphs/surface. Animacja nie zmienia
   fizycznych danych, działa tylko jawnie uruchomiona i zwalnia zasoby.
5. U5 — mały runtime FEM: film DE 40×40×10 nm, Ms=800 kA/m, A=13 pJ/m,
   Bx=0.1 T, PBC xy, finite Dirichlet air ±2 µm, siatka L0 10 nm,
   sześć warstw i siedem rzeczywiście liczonych punktów signed od −25 do +25
   rad/µm w bieżącym demonstratorze. Managed runtime z dokładnego receiptu;
   podstawowe kryteria residualu zachowane. Pełne 15 punktów i kompletność
   okna pozostają osobną bramką naukową.
   Nie tworzymy syntetycznych wyników ani nie odbijamy dodatnich punktów.
   Mała siatka służy do demonstracji UI, nie do pełnej kwalifikacji nauki.
6. U6 — źródła/typecheck/lint/React Doctor i wykonywalne regresje w GitHub
   Actions (lokalny zakaz kompilowania unit tests pozostaje). Browser proof
   na realnej sesji: niepusty wykres, wybór punktu i pola, widoczny canvas,
   niezagubiony WebGL, niezerowy drawing buffer, zmiana fazy i składowej,
   powrót do wykresu bez stale field lub utraty tożsamości. Fixture proof
   jest dodatkowy i nie zastępuje runtime/browser proof na danych solvera.
7. U7 — review, spójne commity, push i integracja według wymaganych bramek.

## Stan początkowy

Wykres Analysis istnieje i ma resource hooks, legendę, eksport i selection.
Adapter ogólnego ChartSeries nie zachowuje jeszcze wektora k na punkcie;
inspector korzysta z bogatszego EigenDispersionPoint. Przed zmianami trzeba
zamknąć to przejście bez dodatkowego pobierania komponentowego.
Runtime ma osobny zapis sesji; nie uznajemy HTTP 200 za potwierdzenie GUI.

## Historia wcześniejszych prób

Benchmark signed15 L0 został zlecony z dokładnym modelem ba0045fef5978e67063047c5896384923d30960a
i runtime236/source digest d912feb0287423ba6a7adc832de6af14d192281cf9235c87c11c0d5f77e534ac.
Parametry: okno 8.5–16 GHz, EPS 1e-9, inner FGMRES 1e-12/restart30,
physical gate 1e-8, serial, capture-session, loopback API 8169.
Signed15 zakończył się błędem certyfikacji okna przy Gamma: 49/50
podokien przeszło, jedno nie. Nie mamy odebranej krzywej 15 punktów.

Pilot pojedynczego +10 rad/µm, nearest 11.2 GHz, dał około 11.1941924 GHz.
Bramki artefaktów przeszły; stan `completed_unqualified`, bez kompletności
okna ani kwalifikacji zbieżności. Capturing po poprawce trójczłonowego
scope wygenerował prawdziwe `de-smoke-k10.fms` (63 entries, 56 artefaktów),
run `run-session-1791450393746-190`, output `7b05e9ecada24d4cb9239063a7e02331`.

## Checkpoint 08.10.2026 — UI i odkryte poprawki

| Zadanie | Aktualny stan | Pozostały dowód |
|---|---|---|
| U1 | Signed axes, SI i metadane punktów zaimplementowane | Regresje CI i rzeczywisty sweep |
| U2 | Punkty/wybór, tooltip, jednostki i odróżnienie analityki zaimplementowane | Ocena wizualna na niepustej krzywej |
| U3 | Akcja 3D wiąże run/stage/sample/mode i sprawdza guard | Browser point-to-mode |
| U4 | Inspector real/imag/abs/phase, składowe, faza, animacja | Browser field/component/phase |
| U5 | +10 zaakceptowane, signed15 nieodebrane; osobny UI seven przygotowywany | 7 rzeczywistych próbek i pola |
| U6 | Dwie kontrole źródeł/types PASS, API hygiene PASS; browser rzeczywisty import/mesh | Pełne CI/lint/Doctor i mode WebGL |
| U7 | Commity i push etapu UI wykonane | Zielone bramki, review integracji, PR/merge |

Dowody źródłowe: production-source receipts `d2a8eaed10614de8ab6f005e93ddc32c`
i `17fb0093ac0d471a8ec39cab4621c983`; API hygiene `edd417ca86cf40ca9f30eec0ae61a5dc`.
Źródłowe review znalazło i zamknęło dwa P2: pomylenie punktu A z selekcją B
w akcji 3D oraz sprzeczne jednostki tooltipu. Testy jednostkowe wyłącznie CI.

Browser instancja 3199/API 8081 ma rzeczywiście zaimportowaną sesję i
pole magnetyzacji filmu (124 punkty i nonzero frames), bez błędów JS.
To nie jest jeszcze dowód pól własnych ani wykresu dyspersji.
Import Start otwiera dokument projektu; oddzielny canonical
`visualization_only` import odtworzył czytaną sesję.

Nowe podpunkty naprawy:

- U3a: routing `single` do widma przy stałym k, zamiast pełnej ścieżki;
  API ma walidować single-k metadata osobno, bez sztucznego KPath.
  Aktualny parser zwraca 500 `missing points` i blokuje Results.
- U6a: native packaged/staged root nie może zastępować checkoutu w
  walidacji managed accepted-store. Live binding był null, więc project
  runs i observation frames zwracały błąd braku storage.
- U6b: CI ma instalować zależności w odrębnym staging workspace;
  pnpm nie akceptuje obecnego aliasu root node_modules. Fixture cleanup
  musi użyć realnej kontroli właściciela z jawnie nieistniejącym kontenerem.
- U5a: UI seven to wybrane nearest mody, `selected_only`, bez deklaracji
  ciągłości gałęzi/pełnego widma. Fizyczny residual pozostaje 1e-8.

Całego S00–S12 oraz U1–U7 nie oznaczamy jako ukończonych.

## Checkpoint — realny solver, UI i kontrakt tożsamości

- UI działa na porcie 3199, API 8081. Nowy natywny pakiet `b77b7c6179734f97bae85735adf065ad` zakończył managed build z exit 0; binding accepted-store jest niepusty. Nie kompilowano lokalnych testów jednostkowych.
- Production-source receipt `e3e222fa9e594fa3ba942d179e92e259` ma stan `passed` i exit 0; obejmuje poprawiony Explorer oraz przekazywanie provenance z punktu gałęzi do inspectora.
- Nowy pojedynczy +10 rad/µm: output `42bea2930c244715b1a495d60f395e6c`, model commit `0e9fefead1910667392210cede93475084100a42`. Solver i artifact gates PASS, residual względny 1.6495550823782716e-14, prawdziwy FMS zaimportowany do UI. Nadal `completed_unqualified`.
- Siedem punktów zostało policzonych przez solver przy FGMRES, lecz runtime236 odrzucił publikację kompletu pól od sample=1. Częstotliwości surowe [GHz] dla ky=[-25,-15,-5,0,5,15,25] rad/µm: [13.475112856,12.008585732,10.304032283,9.299249697,10.304035281,12.008619117,13.475221787]. Są to diagnostyczne checkpointy, nie odebrana krzywa ani dowód ciągłości gałęzi.
- Poprawka zachowania indeksowanych pól sweepa `dbe9e72754c37a7e1d2ebc10a1e64e52fadf8c22` jest w źródłach nowego buildu #238, job `7c8d47ab57874bb7a35745e2822da555`, source digest `5b8a7c92690bfef42c17f50270374d444a1a3be1c4b3d0c6f4a4b4a605cb3ad1`. Job ACK otrzymany; stan queued. C: około 6 GiB, poniżej progu startu 8 GiB. Nie powielamy zlecenia.
- U3a parser single-k jest naprawiony; U6a accepted-store binding jest naprawiony i potwierdzony live. Nowa blokada U3b: legacy FEM manifest nie publikuje run/stage, mimo prawidłowych producer IDs w metadata. Samo jawne stage_id w modelu tego nie naprawia. Wymagana poprawka producenta i bezpieczna obsługa autorytatywnych legacy metadata.
- U6c: brak optional observation store w importowanym FMS ma zwracać resource missing 404, a uszkodzenie lub błąd uprawnień nadal 500. Poprawka i regresje przygotowane; wymaga CI i nowego pakietu API.
- Browser sprawdził realny import i siatkę, lecz pełne chart → mode → phase/component → WebGL jest nadal NOT VERIFIED. Verifier nie może zaliczać pustego widoku, błędów wymaganych zasobów ani samego HTTP 200.

Kolejność pozostałej pracy: zamknąć U3b → odebrać CI aktualnego źródła → uruchomić poprawiony API i browser point-to-mode → po zwolnieniu miejsca odebrać #238 i ponowić UI-seven → test całego wykresu i modów w przeglądarce → review i integracja. Nie zmieniamy physical residual 1e-8 ani nie certyfikujemy najbliższego modu jako n0.

### Domknięte źródłowo i kolejne dowody

CI `37775597830` dla `f19a134895f869aa5f1c3d88a1bbaccdaaa43f5b`: frontend, native-resource-contracts i capture-contract PASS. Kolejny CI `37777420518` dla `aa015eeabc7d828ce4269ca2e72766d9377723f8`: Rust/Python PASS, pięć regresji frontendowych ujawniło niekompletne mocki API/SceneResource i niestabilny mock API powodujący zapętlenie efektów. Poprawki fixture'ów są w `57febf8a0`; produkcyjny API w Kernel jest stabilny. Nowy CI wymagany.

Production-source `8e2d502d5eac47ffb9e35b072044d085`: PASS, obejmuje gate SceneDoc i transport nagłówka overlay. Header używa teraz `sessionRequestScopeKey`, a wewnętrzny NUL cache key nie trafia do HTTP. Prawidłowa sesja read-only z gotową sceną pozostaje dostępna; tylko dokładny expected NoSceneDoc nie emituje globalnego alarmu.

Job #238 zakończył się failed/exit2: PETSc 3.24.6 wymaga kontekstu destroy void**, a źródła przekazywały void*. Poprawka `74c549c95` wybiera ABI z rzeczywistej deklaracji biblioteki i utrzymuje zewnętrzną własność RAII; nie zmienia residual gate ani obliczeniowej części callbacku. Regresja przygotowana. Kompilacja FEM/runtime po poprawce nadal NOT VERIFIED; nowy managed job musi zawierać ten commit.

Zarządzany Windows build `27a6c4cefcb74eb7aab9ab60b0919de4` ukończony exit0; frozen source `853d57e2c72006e9868da902c6a486455bd430960c72c0a79fbb691d4005a683`, bez lokalnej kompilacji testów. Późniejsza zmiana tożsamości źródeł po poprawce CPP wymaga nowego pakietu przy uruchomieniu; launcher odmówił stale package, nie obchodzimy tej bramki. Stary owned workspace został kontrolowanie zamknięty, FMS/artefakty zachowane, runtime-recover zachował owner checkpoint. Wymagany świeży managed launch przed finalnym browser proof.

Browser receipt `dispersion-ui-browser/stage-identity-check/verification.json` jest blocked/exit1: prawdziwe zasoby gotowe, ale stare API nie publikowało stage identity; nie jest dowodem działającego wykresu/modu. Weryfikator rozszerzono o tożsamość run/stage/sample/mode, binary field ID, imag/abs, składową, fazę i Play/Pause. Wymagane wykonanie na nowym API.

Używalność kamery: Fit obejmuje cały airbox. Dla demo trzeba jawnie ustawić istniejący Camera Controls na skalę filmu; nie wolno kadrować przez zgadywanie niezerowej amplitudy ani hardkodować rozmiaru filmu w produkcyjnym rendererze.

Integracja U7: lokalny origin/master ma 13 własnych commitów względem brancha, a branch zawiera 628 własnych (w tym bazową pracę solvera). Nie przedstawiamy całego tego zbioru jako zweryfikowanego refaktoru UI. Przed PR do master konieczne jest ustalenie i review zakresu integracji; wymagane science/runtime bramki bazowego S00-S12 nadal nie są zakończone.


### Checkpoint — 08.10.2026, aktualny UI i testy przeglądarkowe

- Świeży workspace działa: UI 3199 / API 8081, instance `1b14b11d-87d6-4898-ade7-f91a6d9c7ba3`, frozen native source `80234d8adc843dc3da7a6612f01c2dfff55ebc88870362bbedf9e288827b54e8`. Import rzeczywistego +10 odtworzył run `run-session-1791460497246-190`; scene, metadata i owner run/stage są gotowe. Osobnej geometry identity nadal brak — kwalifikacja naukowa NOT VERIFIED.
- CI `37781642284` dla `74c549c95c1e511fbd4c59fc2f36b6be7cfd8e88`: wszystkie trzy joby PASS, frontend 761 plików testowych PASS / 1 skipped. Nie uruchamiano lokalnych unit tests.
- Build FEM #239 `bec08576836042399220e6536db027b5` zawiera poprawkę PETSc i remappera sweepa; source digest `73fe4fcf26f58dd8aab4523d73bb4c7e5743703e854bdebf26be15d52e134720`. Aktualny stan running, kompilacja natywna aktywna. Nie zlecono drugiego buildu.
- U3c: fixed-k Floquet jest powierzchnią Dispersion, subview `dispersion.modal` / Modes at fixed k, ale wykres ma kształt modal-spectrum. Path/grid zachowują f(k). Poprawki routingu i regresje przygotowane.
- U3d: legacy spectrum.v2 nie publikuje mode_id. Explorer oraz chart korzystają ze wspólnego ścisłego dopasowania do opublikowanego CSV: session/run/stage/artifact-set, jawne unikalne indeksy, częstotliwość i wektor SI. Nie generujemy identyfikatorów. Branch ID 0 jest zachowane; Inspector akceptuje dokładne modalne rodzaje selekcji.
- Review wykryło zgubienie mode_id po kliknięciu wykresu; wspólna funkcja wzbogacenia zastępuje wcześniejszą poprawkę tylko Explorera. Ponowne review i source check w toku.
- Production-source `1f12a7ebe8fd42aaa870aa81e71580f6` failed: brak zawężenia idle do AnalysisSurface. Poprawione bez cast; nowy source check w toku.
- Browser `dispersion-ui-browser/fixed-k-mode-ready/verification.json`: blocked/exit1. Odczyty frequency resources zostały anulowane i nie powróciły, Results unavailable. Nie zaliczamy tego jako sprawnego wykresu ani modalnego WebGL. Trwa diagnoza anulowania; test zostanie ponowiony po usunięciu przyczyny.

Pozostałe bramki U5/U6: odebrać #239, ponowić UI-seven, sprawdzić komplet 7 próbek i pól, zaimportować FMS, wykonać browser chart → wybór modu → binary field → składowa/faza/animacja → WebGL na prawdziwych danych. U7 pozostaje otwarte z uwagi na zakres odziedziczonej integracji solvera.


### Checkpoint — poprawki źródeł odebrane, kolejne wyniki

- Commit `9c927ca0371caeac40775099436d0c8a1f8fa81c` jest na remote; production-source `57c0b6d96dd84e0c825136953e86b54b` PASS. Review wspólnego owned enrichment nie ma nowych findings.
- CI `37794403623`: typecheck, module/API contracts, lint, React Doctor i capture-contract PASS; frontend miał jeden niepełny fixture (brak observables), poprawiony. Native miał sporadyczny invalid-single-k fixture 200 zamiast500; parser źródłowo odrzuca oba invalid cases. Dodano read-back pliku i pełną diagnostykę odpowiedzi, bez zmiany parsera ani tolerancji. Wymagany ponowny CI.
- Commit `e2f09e45b86dc64c94b1908bd9caa1bba4adbe1d` jest na remote. Kategoryzacja legacy manifest bez calculation_mode korzysta teraz z typed modal_eigen/Floquet/k_sampling; jawny mode zachowuje pierwszeństwo. ModeFieldOverlayIntent i Inspector akceptują tę samą dokładną listę modalnych rodzajów selekcji. Refresh Results ponawia rzeczywiste resource hooks.
- Production-source `438f740f45d04aeb8b0bd10471152dc6` i `f8b8ef5577e9437f94b1f55d3b450c1d`: PASS, bez local unit tests.
- Browser `fixed-k-mode-intent` potwierdził widoczny fixed-k wykres, owner selection, aktywny modeIntent, real/imag/abs/phase, komponent, zmianę fazy oraz Play/Pause. Finalny receipt blocked: verifier błędnie wymagał binary view phase_rotated_real zamiast publikowanego complex phasor, a locator kamery nie odpowiadał rzeczywistemu DOM. Poprawka verifiera ma wymagać właściwego binarnego kontraktu i kompletnych tożsamości; nie zaliczamy całości przed ponownym browser run.
- #239 succeeded/exit0. Runtime zweryfikowany z digest73fe4f..., source81eab6..., image7139ca...; lokalne C++ unit tests nie były kompilowane.
- UI-seven, trzy warstwy, output `4ebcccb44f824c3b95a2f6886af630c0`: failed przed solverem; mesh gate wykrył4 rzeczywiste przedziały z zamiast3 zadanych. Nie wyłączono gate.
- UI-seven, sześć warstw, output `1e1841ba34a445ad8a6f2afac1898c11`: solver exit0, 7 wierszy CSV i opublikowane pola, FMS7.5MB. Validator kampanii odrzuca Floquet boundary/gauge provenance sample0; diagnoza w toku, danych nie oznaczamy jako odebranych ani naukowo zweryfikowanych. Surowe częstotliwościGHz dla ky=[-25,-15,-5,0,5,15,25]rad/µm: [13.502303523,12.025066949,10.309811616,9.299249697,10.309816736,12.025102790,13.502167415].

Dodatkowa obserwacja U6: 5-sekundowy budżet ładowania był wyczerpywany podczas burst wejścia do workspace. Izolowane te same GETy odpowiadają38–134ms; brak dowodu trwałego wolnego odczytu dysku. Nie wprowadzono globalnej nieskończonej pętli retry. Manualny Refresh Results ma umożliwić recovery; test network-refetch pozostaje do wykonania.


### Browser/CI checkpoint i znaleziony błąd producenta

CI `37798428967` dla `e2f09e45b86dc64c94b1908bd9caa1bba4adbe1d`: frontend, native-resource-contracts i capture-contract PASS. Odczyt invalid JSON fixture w tym CI był prawidłowy; poprzednie sporadyczne200 pozostaje z diagnostyką, bez zmiany parsera.

Browser `fixed-k-complex-phasor/verification.json` exit0: prawdziwe owner IDs, metadata, binary FMVPv3 /6components, imag/abs/phase/real, komponent, faza, Play/Pause, odtworzeniephase0, Camera Controls i WebGL703x515 bez utraty kontekstu. Geometry identity nadal NOT VERIFIED. Oględziny screenshotu wykazały jednak pusty canvas samego wykresu, mimo widocznej legendy11.194GHz; dowód nonzero box nie zastępuje dowodu narysowanego punktu. U2/U6 plot-paint i chart-point-click pozostają otwarte, trwa diagnostyka renderera.

UI-seven,6warstw: final spectrum pomija per-mode Floquet/gauge provenance, które istnieje w raw checkpointach. To rzeczywisty błąd agregacji KPath w eigen_path.rs/eigen_path_artifacts.rs; validator prawidłowo odrzuca final. Poprawka ma kopiować niezmienione certyfikaty z exact native-mode match, nigdy wywnioskować ich z samego residualu. Wymagane przygotowane regresje Gamma/nonzero-k, review, CI i świeży runtime; istniejące failed artefakty pozostają zachowane.


### Checkpoint — producer7d i rzeczywisty render wykresu

Poprawka KPath provenance `7d478c225a5859eec91aec11f546596cf1e66b09` jest na remote; CI `37801515892` PASS obejmuje obie regresje `eigen_path_native_mode_provenance`. Wartości native certyfikatów są kopiowane verbatim z exact matched record; Gamma zachowuje własne block_residuals i nie dostaje nieistniejących per-mode flag z aggregate diagnostics. Rustfmt parsuje pliki; pełny format-check ujawnia wcześniejszy dług formatowania, nie wykonano masowego formatowania.

Nowy managed build #240 / `4793e17bf9dd46ef9669335b62a265d6` jest running. Source commit7d, digest `af288be2febb967bbf34e3ff3b19765e2f15018167997fd88b6595e30efb621b`, snapshot `d032af32d921b2b1f962ed7fb205b6b57a40d50b4de6554efd1dd8d088412ac4`, capture `e6c5a1d7084e4afe93e9311f90627347`. Brak duplikatu joba; source commit jest zamrożony niezależnie od dalszych HMR zmian UI.

Diagnoza U2/U6: pojedynczy punkt widma jest linią bez symbolu, więc nie tworzy odcinka ani hit-target. Metadane zajmują210px z360px body przy overflow:hidden, przycinając wykres. Wymagana poprawka source series/layout oraz dowód widocznego znacznika i chart-click, nie samo boundingBoxcanvas. Dopiero po tej poprawce pełne UI zostanie uznane za odebrane.

Footer energy: brakujące obserwable mają być prezentowane jako kreska, nie jako0J; zmierzone zero pozostaje0. Poprawka i regresja przygotowane, source/CI po zakończeniu spójnego fragmentu UI.


### Checkpoint — dopracowanie wykresu i bootstrap pod obciążeniem

Wykres widma używa jawnych scatter markerów. Body karty zawiera wyłącznie canvas; metadane są w rozwijanych szczegółach, a frequency subviews nie pokazują nieaktywnego table-dataset pickera. Default nagłówek nie pokazuje wewnętrznych tuple rewizji; source revisions pozostają w provenance. Review źródłowe bez nowych findings.

Production-source `bc00cf47c9d64a31b481e71aa2059a1c` oraz `2f118c11cca44c319096ee96fcb53ec2` PASS. Browser `fixed-k-painted-marker` potwierdził scatter pixel marker, nieprzycięty body360px/canvas676x326, kliknięcie rzeczywistego markera i exact mode0 metadata200. Receipt blocked przez ReferenceError w verifierze, poprawiony; nie jest pełnym końcowym proof.

Browser `fixed-k-final-layout` blocked na cold bootstrap: wszystkie frequency resource GETy anulowane po5s; topology206 dotarło dopiero po kilkunastu sekundach przy aktywnym buildzie/source-check. Source review zaleca domyślny łączny budżet30s w useResource, zachowując3 próby, backoff, terminalnyTimeoutError oraz jawne krótsze/null polityki. Jest to ograniczona mitigacja opóźnienia, nie dowód usunięcia jego przyczyny. Regresje i browser przy porównywalnym obciążeniu wymagane.

Opcjonalne State snapshots: hook obsługuje wyłącznie dokładny legacy ControlRoomApiError404/not_found/message='durable observation run storage was not found'; ready/null pokazuje unavailable/not recorded. Inne404, permission/corruption500 i wybrane frame/vector pozostają błędami. Footer brakujące/niefinitych energie pokazuje jako kreskę; rzeczywiste0J zachowane. Review źródłowe PASS, testy CI po commicie.


### Checkpoint — UI accepted dla single-k, aggregate contract w toku

Production-source `95d70f5030154f5597c5a61239be078f` PASS. Browser `fixed-k-final-budget/verification.json` passed/exit0 obejmuje widoczny namalowany znacznik, brak klipowania, rzeczywisty chart-click i exact-mode Inspector, complex FMVPv3/6components, phase/component/Play-Pause, Camera Controls i liveWebGL. Zasoby załadowały się podczas aktywnego buildu z default30s; np periodic_pairs odpowiedziało200 zamiast wcześniejszego abort5s. Optional ObservationStore404 jest już not recorded/unavailable bez globalnego resource alarmu. Geometry identity pozostaje NOT VERIFIED.

UI commit `7064e97594ef8c6dd6f7dd01f2e61c76c5903857` jest na remote. CI `37807455146`: Rust/Python PASS; frontend typecheck failed na niepełnym snapshot fixture (error/missing/revision), poprawione w `f78812b4bce0eb99b50b036045f40661444b77cf`, również na remote. Kolejny CI wymagany. Drobna korekta zawijania nagłówka frequency card jest lokalna i wymaga finalnego browser screenshotu.

Diagnostic UI-seven import zachowuje oryginalne failed dane z output1e184; restore visualization_only200, run `run-session-1791472031576-190`, request_scope_epoch `1b14b11d-87d6-4898-ade7-f91a6d9c7ba3:2`. Warning o braku packaged checkpoint oraz semantic execution difference zachowane. Nie jest to naukowy odbiór danych.

Browser `ui-seven-diagnostic` blocked/exit1: run/stage/spectrum owner zgodne,7samples/7modes, lecz aggregate frequency-domain manifest nie publikuje boundary_context; geometryidentity również brak. Weryfikator prawidłowo nie zgaduje boundary z nazwy/kpath. Potrzebna poprawka aggregate manifest na podstawie typedFemEigenPlan oraz przegląd reszty obowiązkowego context, zanim kolejny immutable build i sweep.


### Aktualny checkpoint — przyjęte siedem punktów i korekta pochodzenia

Build #240 (`4793e17bf9dd46ef9669335b62a265d6`, source
`7d478c225a5859eec91aec11f546596cf1e66b09`) zakończył się sukcesem.
Pilot `ab0589d9b38e44c987dc63b883462526`, run
`run-session-1791478615226-190`, ukończył obliczenia i bramki artefaktów:
7 wierszy dyspersji, 7 pól modów i 7 potencjałów fizycznych. Status
`completed_unqualified`; nie dowodzi kompletności okna ani zbieżności.
FMS został zaimportowany do działającego workspace 3199 / API8081 w trybie
visualization_only. Oryginalne pliki nie zostały zmienione. Zachowano warning
braku packaged checkpoint i różnicy execution; session jest tylko do odczytu.

| k_y [rad/µm] | f [GHz] |
|---:|---:|
| −25 | 13.502303523 |
| −15 | 12.025066949 |
| −5 | 10.309811616 |
| 0 | 9.299249697 |
| 5 | 10.309816736 |
| 15 | 12.025102790 |
| 25 | 13.502167415 |

Dalszy audyt znalazł błąd legacy aggregate manifest: brak typowanego
boundary/k-sampling, normalizacja `unitl2` zamiast `unit_l2` i globalna
tożsamość kopiowana z pierwszej próbki. Gamma ma inny hash artefaktu
równowagi niż pozostałe punkty; nie jest to samoistny dowód odmiennego m0.
Rzeczywiste diagnostyki i metadata wszystkich siedmiu modów mają konwencję
`exp_plus_i_omega_t`, a agregat błędnie deklaruje `exp_minus_i_omega_t`.
Poprawki producenta i konsumentów są przygotowywane razem: kompletna mapa
próbek, globalne pola tylko przy consensus, exact sample identity aż do pola
3D. Nie przepisujemy istniejących artefaktów i nie obniżamy residual gate.

CI `37809623665` wykryło jeszcze niepełny fixture snapshotu
(`resultContextRunId`); poprawka jest częścią bieżącego frontend fragmentu.
Pełny fixed-k browser proof `fixed-k-final-budget/verification.json` jest
PASS. Pełna krzywa i przejście jej punktu do pola 3D wymagają nowego
producer/runtime i browser proof. U7 nadal review/blocked: odziedziczony
branch solvera ma szeroki, niezakończony naukowo zakres oraz aktywny UI.

## Checkpoint 08.10.2026 — świeży sweep i naprawa transportu

Build FEM #241 (`4ebf0c524ca2479eab4672836694586d`) zakończony exit 0,
źródła `0c1810f3fe3b2fad17b550b050ea7f146245f774`.
Pilot `a3bbb515bfce4efd96f3d8df4e347ff0`: 38,3219 s, siedem niezależnie
obliczonych punktów i siedem pól modów. Stan `completed_unqualified`,
`selected_only`, `window_complete=false`; nie jest to certyfikat kompletności pasm.

| ky [rad/µm] | f [GHz] |
|---:|---:|
| -25 | 13.5023035235 |
| -15 | 12.0250669488 |
| -5 | 10.3098116162 |
| 0 | 9.2992496971 |
| 5 | 10.3098167356 |
| 15 | 12.0251027895 |
| 25 | 13.5021674152 |

Manifest publikuje `floquet_periodic`, path/sample_count=7, normalizację
unit_l2, mesh identity i zgodną konwencję `exp_plus_i_omega_t`.
7/7: Eq z mapy próbki == Eq artefaktu modu == Eq kandydata.
Gamma ma inny hash artefaktu; sam hash nie dowodzi zmiany fizycznego m0.

Pierwszy browser proof całej krzywej ujawnił rzeczywisty błąd transportu:
katalog artefaktów miał ETag >40 KB, proxy Next zwracało
`HPE_HEADER_OVERFLOW`/500, a klient błędnie utrwalał zmianę instancji API.
Commit `852b5c353b3f7c8649c80cbaabb9e3adaa084db0` skraca ETag przez SHA256
pełnego serializowanego body; zachowuje conditional 304 i rygor identyfikacji
instancji. Headerless proxy 5xx pozostaje błędem 5xx, nie trwałym fencingiem.

GitHub Actions `37832383619`: całość SUCCESS, w tym frontend typecheck,
contracts, lint, React Doctor, regresje oraz Rust resource/native contracts.
Lokalnie nie kompilowano unit tests. Managed Windows backend build zakończony
exit 0; wersja `0.1.0-dev.20261008.g852b5c353b3f+9777`.
Powtórny browser proof wymaga wdrożenia tego backendu; poprzednia nieudana
próba nie jest traktowana jako pozytywny dowód UI.

## Odbiór browser — rzeczywista sesja siedmiopunktowa

Wdrożono backend `852b5c353b3f7c8649c80cbaabb9e3adaa084db0` i odtworzono
**ten sam** FMS joba #241 w trybie visualization_only. Nowa instancja API
`04b93eba-4173-4940-a873-b71b5844de49`, UI 3199, API 8081.
Sprawdzono proxy katalogu artefaktów: GET 200, ETag 83 znaki,
If-None-Match 304. Nie zwiększano limitu nagłówków proxy.

Receipty pod kanonicznym storage:
`runs/dispersion-mode-ui-20261008-9aae306a4b5f5e7d/dispersion-ui-browser/`:

- `ui-seven-etag-fixed-negative/verification.json`: PASS, próbka 0, ky=-25.
- `ui-seven-etag-fixed-gamma/verification.json`: PASS, próbka 3, ky=0;
  odrębna tożsamość Eq poprawnie powiązana z własnym polem Gamma.
- `ui-seven-final-polish-positive/verification.json`: PASS, próbka 6, ky=+25;
  końcowy wykres z osią Frequency, zakresem danych i większymi symbolami.

Każda próba klika rzeczywiście namalowany znacznik ECharts i sprawdza
run/stage/sample/mode/field oraz Eq w posiadanym artefakcie modu. Brak
fixtures, uploadu w verifierze, podmiany odpowiedzi lub seeding localStorage.
Sprawdzono real/imag/abs/phase, składową, zmianę fazy, Play/Pause i powrót
phase-rotated real do fazy zero. Binarne pole jest rzeczywistym zespolonym
XYZ FMVP v3 (6 składowych), WebGL2 nieutracony, buffer 703×515.
Focus: odległość Frame All 8.91 µm; Focus filmu 0.128 µm, wyznaczone z granic
modelu, bez ręcznego/hardkodowanego ustawienia kamery.
Brak uncaught page errors. Root ręcznie obejrzał wykres i screenshot 3D.

Ostatni fragment prezentacji jest opcjonalny: tylko wartości frequency lub
analytic_frequency w rozpoznanych jednostkach częstotliwości otrzymują
zakres z finite plotted values i padding 5% rozpiętości (obsługa singletonów).
Inne osie zachowują dotychczasowe zachowanie. Referencja analityczna nadal
używa kreski przerywanej i rombów; numeryczne znaczniki są okrągłe.

U7 pozostaje **blocked**: branch odziedziczył dużą niezintegrowaną pracę
solvera, nieukończone bramki S00–S12 i ma aktywną instancję UI. Nie utworzono
PR przedstawiającego całą tę pracę jako zweryfikowaną zmianę UI i nie wykonano
merge/cleanup. Następny krok integracji: review zakresu względem mastera oraz
zamknięcie/oddzielenie bramek bazowego solvera. Wyniki i działające UI zachowane.

Kontrola remote 08.10.2026: master `2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`.
Istniejący PR bazowego solvera [#97](https://github.com/MateuszZelent/fullmag/pull/97)
jest OPEN/CONFLICTING, HEAD `d7a68f28e63ef18f393710cae3f414da03201c8f`.
To zależność integracyjna, a nie PR bieżącego UI. Nie aktualizowano obcego
brancha i nie dublowano szerokiego PR. Po integracji uzgodnionej bazy solvera
trzeba przenieść/uzgodnić różnicę UI, uruchomić bramki integracyjne i PR UI do mastera.

Końcowy production-source receipt `7695205af9a84f27a410b15cfd5a6478`:
PASS/exit 0, tsc exit 0, źródła nie zmieniły się w trakcie sprawdzenia.
Scope nie obejmuje unit tests. Root przejrzał diff, przypadki singleton/signed,
exact-unit guard, dziedziczenie jednostek i zachowanie analitycznych symboli;
nie stwierdził blokującego problemu. Scopowany diff/whitespace PASS.
Regresje ostatniego fragmentu prezentacji pozostają do wykonania wyłącznie CI.
