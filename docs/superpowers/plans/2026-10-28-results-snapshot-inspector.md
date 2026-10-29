# Results: ukończony run, snapshoty i powrót do live

## Cel i uzgodnienia

Użytkownik otwiera Explorer → Results dla ukończonego runu. Katalog pokazuje rzeczywiście zapisany output: pola i wszystkie quantity zapisane przez autosave, próbki czasu/accepted step, tabele, mody/eigensolve i pozostałe artefakty. Kliknięcie pozycji otwiera Inspector; zapisane pole ma akcję załadowania do wspólnego viewportu 3D. Każdy snapshot ma własne ustawienia Visualization w Inspectorze; nie tworzymy osobnych okien 3D. Jawna akcja Wróć do live usuwa wybór źródła historycznego, zachowuje ustawienia snapshotów i wraca do bieżących danych bez nowego Solve.

Baza: f875c8fac982d1f3f735679e147bbd28eba4f21f. Worktree results-snapshot-inspector-20261028, właściciel codex-current-chat-results-output; grupa fullmag-worktree-results-snapshot-inspector-20261-aeb868db9dd9674f, port 3298. Główna stara grupa ma brakującą sieć fullmag-master_fullmag i zachowaną obcą sesję; nie zastępować jej dla tego testu. Natywne narzędzie tworzenia worktree odrzuciło właściwy sourceRoot ze względu na nieaktualną listę workspace; zastosowano zarejestrowany git fallback.

## Rozpoznane luki

- ObservationFrameInspectorPanel publikuje Pin source, nie załadowanie snapshotu do viewportu i sterowanie czasem.
- Explorer ogranicza wiele katalogów do current run i pokazuje jawny kontrakt gap dla wcześniejszego runu.
- Stage autosave manifest opisuje zapisane quantity i liczby próbek; trzeba powiązać je z faktycznym odczytem payloadu, geometrii i współrzędnych, a nie z aktualnym polem solvera.
- MaterializedDataset Inspector pokazuje metadane i wartości, nie automatycznie podgląd 3D; istniejące typed dataset/mode/table paths należy wykorzystać.

## Granice

Jedna warstwa API v2/OpenAPI → generowany transport → facade → zasoby → adaptery → wspólny Canvas. Status nie transportuje pól. Źródło historyczne wiąże run/stage/quantity/próbkę/rewizję oraz zapisaną geometrię i wsparcie. FEM wymaga dowodu mapy nodalnej; nie zgadywać na podstawie liczby węzłów lub obecnej siatki. Błędny/brakujący zapis ma widoczny stan, nie fallback do live. Nie uruchamiać cudzych grup ani usuwać danych.

## Kryteria odbioru

- [ ] Katalog faktycznie zapisanych produktów runu, z obsługą stron/limitów, quantity, czasu i tabel.
- [x] Inspector: wybór próbki, load to 3D, osobne ustawienia Visualization dla snapshotu.
- [x] Jawny powrót live bez utraty ustawień; ochrona przed spóźnionym historycznym payloadem.
- [x] Krótka rzeczywista symulacja w tej samej grupie: ukończenie → Results → przewinięcie próbek → live → ponowny snapshot; bez ponownego Solve.
- [x] Prawdziwy WebGL: widoczny Canvas, niezerowy drawing buffer, brak utraty kontekstu, zmiana wyświetlanych danych i stabilna geometria/kamera.
- [ ] Testy adekwatnych kontraktów i UI, niezależne review, wymagane CI, integracja.

Wcześniejszy fixture FEM był syntetyczny; nie przedstawiać go jako testu ukończonej symulacji. Bieżący etap musi zachować to rozróżnienie.

## Checkpoint implementacji 2026-10-28

- `6a28c950204fbc7c7566a5b6545e8aba092bec6a`: naprawa projekcji Run do ścisłego study pipeline, bez zmiany walidatora Rust. W stałym backendzie grupy: 56 testów Pythona i 4 subtesty przeszły (study stages + scene execution config).
- Testy frontendu w stałym frontendzie: adapter prezentacji 6/6, legacy controller 3/3, Inspector 3/3, identyfikacja/dekoder nowego API 2/2. Kontroler snapshotów jest dalej rozszerzany, więc jego wcześniejszy wynik nie jest jeszcze końcową bramką.
- Testy interpretera zarządzanego browser QA 30/30; harness rozszerzany o Explorer Results, ustawienia i Return to live. Nie jest to jeszcze dowód wykonania tej ścieżki w przeglądarce.
- Wcześniejsza aktywacja została odrzucona przed runem, ale API zachowało sesję `startup_failed` z `run:null`. Restart ma użyć istniejącego `_terminal_session_restart_probe` i receiptów; nie usuwać jej ręcznie.
- Bieżący backend nadal korzysta z poprzedniego snapshotu źródeł. Nowe czytniki, API i publikacja FEM wymagają zarządzanego przechwycenia oraz buildu przed testem runtime. Implementacja i integracja pozostają w toku.

## Checkpoint: blokada współdzielonego runtime’u

Źródła obejmują teraz katalog logicznych tablic Zarr, wszystkie pozostałe pliki, rewizje z hashem treści krytycznych metadanych, kontrolę zgodności trwałych markerów runu, wspólny budżet odczytu i zachowany uchwyt/tożsamość katalogu playback. API ma wspólne endpointy geometrii dla bieżącego runu i folderu workspace; FEM zachowuje metadane także przy przekroczeniu limitów transportu. Explorer → Inspector → wspólny viewport oraz Return to live są połączone. Nie oznacza to zakończonej kwalifikacji runtime.

- Pierwszy zarządzany build nowych źródeł: iteracja `3351b18735054d3d9e5a760a85a4b906`, snapshot `9b2d23baf1dd33a2f9c8a110576ae4018dc0801e4afe24e350858e84ff44717b`, API gotowe. Ten snapshot poprzedza końcowe poprawki review.
- Testy publikacji `fem_autosave_playback`: 3/3 przeszły w stałym backendzie.
- Pierwszy test całego workspace-inspect nie skompilował testu `Read::by_ref` (E0034); poprawka jest w źródłach i wymaga ponownego capture/testu.
- Pełny przebieg Vitest: 8965 passed, 3 failed, 1 skipped. Dwa błędy środowiskowe przeszły po ustawieniu `FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source` (35/35). Test shell ujawnił brak SelectionController w mocku oraz literówkę `stableSource`; po poprawkach shell 12/12. Nowy test Return to live bez dostępu do solver API: 1/1. Nie przedstawiać pierwszego pełnego przebiegu jako zielonego.
- Typecheck uruchomiony: pozostały brakujące generowane schematy/ścieżki Results i wynikające z nich typy callbacków. Generator nie opublikował artefaktów, ponieważ wykrył zmianę źródeł podczas operacji. Wymagane ponowne uruchomienie po świeżym buildzie i przy niezmiennych źródłach; nie dopisywać wygenerowanych typów ręcznie.

Ponowny restart **nie został wykonany**: w grupie zadania pojawiła się obca aktywacja CoFeB ring z czatu „Uruchom Fullmaga z CoFeB ring” (`01a18238-cee8-7a52-a6d9-6d856134fe77`). Jej operacja `39d89f614b43494381b490f373d12b7b` zachowuje aktywny lease. Receipt aktywacji: `backend/script-activation-321e73383cbd05b5bf675c6a674a055b70d57f49917149381af5d44cabca2312/activation.json`, request `docker-volume-0e080905a3464b3392d603fac873e90d`, skrypt `examples/permalloy_layer_cofeb_rings_relax_300nm.py`. Nie usuwać tego lease, nie odtwarzać usługi i nie przerywać cudzej pracy.

Wysłano do użytkownika asynchroniczne pytanie o zgodę na wiadomość do tego czatu i uzgodnienie zwolnienia grupy. Bez tej zgody nie wysyłać wiadomości. Dalsze kroki po zwolnieniu runtime’u: managed restart z **bazowym** receiptem development `e421b47bf9734f4baed4da39caceee55` (nie receiptem iteracji), config `4f236dae62e08f85f764d58095677db07a5e5bfe285ca9ad884a21b7a3b1cbae`, capture → codegen bez edycji źródeł → testy reader/API/pozostałych producer markerów → typecheck → rzeczywisty run FEM → browser QA/YIG regresja → review/CI/integracja. PR dla tego zadania jeszcze nie powstał; scalanie i cleanup pozostają niewykonane.

Końcowy checkpoint źródłowy tej części: niezależny recheck nie ma otwartych Required/Blocker. Pełny ESLint zakończył się kodem 0. Trzy testy nieudane w pełnym przebiegu zostały sprawdzone ponownie: 35/35 po poprawnym wskazaniu readonly source root oraz shell 12/12 po poprawce Explorera/mocku. Nowy test Return to live 1/1 przeszły. Ostatnie poprawki czytnika i API pozostają nieprzechwycone przez backend. Generowane pliki API nadal wymagają zarządzanego codegen; typecheck nie jest zielony. Żaden nowy run FEM ani browser/WebGL QA tej funkcji nie został wykonany. Zachowano cudzą aktywację i wszystkie dane.


## Zweryfikowany checkpoint 2026-10-29

Grupa 3298 została zwolniona przez właściciela poprzedniego zadania i wykorzystana do audytu. Końcowa próba `b44b61e4299740ce8253c140e36c18ba` przeszła cały scenariusz na rzeczywistym ukończonym FEM CPU double: snapshoty m 0/2/5, opóźniona próbka, ustawienia per snapshot, tabela, wspólna nawigacja, folder Saved i powrót do Live 101 kroków / 100 ps. WebGL działał przez SwiftShader. Zaznaczone kryteria dotyczą tego zakresu; nie stanowią kwalifikacji fizyki ani sprzętowego GPU. Dowody i przebiegi testów: [audyt](../../audits/2026-10-28-results-browser-ux-audit.md) oraz [końcowy JSON](../../audits/2026-10-29-results-browser-final-evidence.json).

Katalog i odczyt są zaimplementowane, ale pierwsze kryterium pozostaje częściowo otwarte: H_eff FEM nie ma jeszcze producer-owned per-quantity geometry binding, wszystkie semantyczne formaty modów/eigensolve oraz monitoring podczas managed runu nie zostały zakwalifikowane. Pozostają również wskazane w audycie regresje i pełne bramki integracji. Nie scalać całej funkcji na podstawie samego zielonego scenariusza m. Zachować worktree, grupę i wyniki do dalszej pracy.

Commit backendu i wygenerowanego API: `c91aef48182f3cce2646392bc5aac77658cc8286`. Obejmuje czytnik katalogu/próbek, limity i rewizje, znaczniki producenta oraz nazwy kolumn. Czytnik Results 24/24, wcześniejsze bramki reader/API i zarządzany codegen opisano w audycie.
