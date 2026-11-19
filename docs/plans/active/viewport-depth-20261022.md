# Naprawa głębokości i podglądu primitive 3D

Cel: usunąć artefakty powierzchni przy zbliżeniu do ringu i zapewnić czytelny
wireframe geometrii przed zbudowaniem siatki, bez zmiany fizyki i solver mesh.

- Checkout: `/home/kkingstoun/git/fullmag/worktrees/viewport-depth-20261022`.
- Branch: `codex/viewport-depth-20261022`.
- Baza: `e19ee0664173b5d0dafe281b402c0b088a11b3d5`.
- Owner: `codex:01a16521-315c-78a3-bf99-15e1b8af74c4`.
- Grupa: `fullmag-worktree-viewport-depth-20261022-d13d8cf2842d9225`.

## Zakres i odbiór

1. Polityka near/far: zachować geometrię przy zmianach FOV, wyeliminować
   załamanie near przy wejściu kamery w globalną sferę bounds, dobrać far do
   rzeczywistej skali sceny. Odbiór: odróżnianie cienkich warstw, perspektywa
   i ortho, zoom/orbit i cel poza modelem.
2. Primitive wireframe: krawędzie opisujące bryłę, bez przekątnych triangulacji
   kapsli ringu. Zachować pole powierzchni, pozycję, picking, bounds i cleanup;
   nie zmieniać wyświetlania właściwej siatki FEM/FDM.
3. Weryfikacja: diagnostyka funkcji, typecheck/lint, React Doctor w zakresie
   zmian, zarządzany browser/WebGL z canvas visibility, kontekstem i buforem.
   Zakaz kompilacji testów jednostkowych pozostaje w mocy. Dowód pikseli musi
   obejmować primitive i gotową siatkę; test obliczeń nie zastępuje obrazu.
4. Review, scoped commit/push/PR, wymagane kontrole, merge i integracja do
   lokalnego mastera z zachowaniem równoległych zmian, cleanup wyłącznie
   zasobów tego zadania. Każda blokada otrzymuje konkretny checkpoint.

## Stan

- Utworzono i zarejestrowano izolację; rejestr w rozwiązanym `storage/index`.
- W masterze pozostaje wcześniejszy audyt i cudze zmiany. Nie skopiowano ich
  do implementacji. Grupa zadania używa portu 3212; master 3198 pozostaje aktywny.
- Zaimplementowano skalowany zakres głębokości, wspólny dla Fit, projekcji
  i bieżącej kamery podczas gestów OrbitControls. Review wykrył i skorygowano
  dodatkowy przypadek środka bounds w płaszczyźnie oka.
- Primitive ma osobny generator krawędzi prezentacyjnych. Diagnostyka
  rzeczywistych deklaracji i Three r186 sprawdza 27 wariantów geometrii.
  Pierwszy przebieg wykrył po cztery rozbieżności na zamknięciach CSG;
  ekstrakcja obrzeży z rzeczywistych trójkątów usunęła rozbieżności.
  Końcowy probe: 27/27 przypadków, zero odcinków poza krawędziami powierzchni.
  Siatka obliczeniowa nie korzysta z tego generatora.
- Lint produkcyjnych zmian i parsery MJS: PASS. Typecheck aplikacji: PASS
  (po poprawieniu zmiennej środowiskowej wywołania na istniejący cache root).
  React Doctor: częściowy wynik, brak findingów w zmienianych plikach;
  pełny skan shadow checkoutu i błąd dead-code ograniczają dowód.
- Obliczenie dla zapisanej kamery: modelowy krok 24-bitowego depth buffer
  23,96 nm → 0,0378 nm; film 1,6 nm: 0 → 42 poziomy. To dowód obliczeń,
  nie pikseli WebGL. Dodano źródła regresji; zgodnie z zakazem nie kompilowano
  ani nie uruchamiano testów jednostkowych.
- Toolchain i obrazy grupy zadania gotowe. Frontend healthy; trwa pierwszy
  przyrostowy build aplikacji backendowej w stałym kontenerze backend.
  Przygotowano fixture odtwarzający istniejący przykład z oczekiwaniem na
  Compute oraz kontrolowane ujęcia z bliska; browser/WebGL: NOT VERIFIED.
- PR uruchamia automatycznie `bootstrap.yml`, w tym kompilację testów C++
  i `cargo test`. Przed otwarciem PR trzeba rozstrzygnąć ten konflikt
  z tymczasowym zakazem kompilacji testów; nie wyłączamy kontroli CI.
- Wolne miejsce WSL przed pracą: około 27 GiB; przestrzeń Docker wymaga
  odrębnego preflightu. Nie ma zgody na czyszczenie cudzych cache.

## Checkpoint 23.10.2026

- Commity: kamera `5e12f782c4d5be861078b092917db26b9a922699`, Primitive
  `fded49ec104eeed75a60dd9be77ae5567df8bf09`, integracja mastera
  `5ac7eae523e5fc117eab9195f62ecda404841601`, regresje/QA
  `b098a82ea0887729228b9c1041b9c64957438678`.
- Aktualny master/origin master: `ae8e570f2aa9655cb9fd8321c716b8d49a87e084`.
  Merge bez konfliktów, zachowano poprawki transferu Primitive→mesh.
- Po merge: lint, tsc bez kompilacji unit tests, parsery MJS i geometria27/27
  PASS. Wykonywalna asercja precyzji przechodzi; kontrola starej polityki
  prawidłowo kończy się exit1. Niezależne review źródeł bez findingów.
- 3 kontrolowane kamery × 3 tryby renderowania, z przywróceniem ustawień
  przez widoczne UI. Browser jeszcze nie uruchomiony; backend buduje
  przyrostowo zmiany bieżącego mastera w tej samej grupie3212.
- Bieżący raport: `docs/diagnostics/viewport-depth-fix-2026-10-23.md`.

## Checkpoint odbioru runtime

- Zarządzana archiwizacja starego stanu i start46515f12...: PASS; istniejąca
  grupa3212 jest healthy. Błąd foreign-host writera zachowano w control volume.
- Fixture wymagała przeniesienia do `examples/qa/viewport_depth_preview.py`
  ze względu na canonical output mapping; nowa aktywacja nadal trwa.
- Weryfikacja źródeł obejmuje36 geometrii, kontrolę negatywną głębokości
  i pełnej triangulacji. Unit tests niekompilowane.
- Browser preflight: timeout60s w odczycie control volume, przed browserem.
  Eksporter konfiguracji czeka na I/O; nie przerywano ani nie powtarzano jego
  żądania. Canvas/PNG/mesh acceptance nadal NOT VERIFIED.
- PR/merge/cleanup pozostają do wykonania po bramce WebGL i rozstrzygnięciu
  automatycznej kompilacji unit tests w CI. Zachować worktree i jego zasoby.

## Blokady potwierdzone 2026-10-23T09:03:55.470209+00:00

- Użytkownik: zakaz kompilacji unit tests obejmuje CI; PR uruchamiający bootstrap.yml zablokowany.
- Aktywacja a97f47244fc0451c86f846fb9aff5e0a: outcome unknown, zasoby zachowane, bez replay.
- Odczyt Docker: daemon niedostępny; WebGL NOT VERIFIED.
- Master ae8e570f2aa9655cb9fd8321c716b8d49a87e084 nadal ma starą politykę near/far; poprawki nie są zintegrowane.
- Zachować worktree i zasoby, wznowić odbiór po ustąpieniu blokad.

## Rozszerzenie zatwierdzone przez użytkownika: odzyskanie pustego namespace

Polecenie „no to zrob co trzeba” obejmuje usunięcie blokady runtime przed
odbieraniem obrazu. Nie obejmuje danych ani usług innych grup.

Dowody: dokładna para usług zadania jest stopped/Pid0/exit255 po przerwaniu
Dockera; helper aktywacji nie istnieje. Sesja zawiera jedynie WRITER.lock,
WRITER.owner.json i dwa deskryptory scheduler_pools. Brak RunIntent, katalogu
runu i wyników. Grupowy ledger v4 ma reservations=[]. Owner i process-tree
pozostają ready; nie są dowodem działających procesów ani terminalnego drain.

Wybrana ścieżka: nowy, jawny tryb zarządzanej kwarantanny pustej sesji,
wykorzystujący istniejący rejestr namespace i ten sam inode operation.lock.
Nie udajemy managed native stopu i nie wpisujemy stanu failed/drained do
starego ownera. Nie usuwamy aktywnego markera ani starego receipt. Zwykłe
resume pozostaje fail-closed. Obecna kwarantanna przyjętego/anulowanego runu
nie pasuje; rozszerzenie dotyczy tylko pustego store i pustego ledgera.

Warunki i kolejność:
1. Dry-run przypina checkout/projekt, attempt/config/image, dokładne ID
   backendu i frontendu, timestamps, prywatny PID namespace, mounty/etykiety,
   nieobecność dokładnego helpera i brak cudzych żywych konsumentów.
2. Dopuszczalny store ma zamkniętą allowlistę technicznych plików, bez runów,
   obiektów, aktywnych zadań lub wyników. Ledger musi mieć pustą listę
   rezerwacji, a kontenery korzystać wyłącznie z grupowego ledgera.
3. Jeden ograniczony helper bez sieci/socketu i bez zapisu do hosta trzyma
   operation.lock oraz dotychczasowe locki ownera, launchera, store i ledgera.
   Ponownie sprawdza control pins, snapshot store i pusty ledger.
4. Trwały intent z inspekcjami pary powstaje przed usuwaniem kontenerów.
   Host ponownie sprawdza inkarnacje i konsumentów pod blokadami, usuwa
   tylko dwa zatrzymane kontenery, bez force. Awaria po częściowym usunięciu
   wymaga tego samego intentu i autorytatywnego dowodu nieobecności ID.
5. Po ponownej kontroli helper atomowo publikuje niezmienny receipt oraz
   rejestr świeżego namespace. Stare control/state/ledger pozostają w miejscu.
   Stary request_id nie może być odtworzony. Nowy namespace wybiera nowy
   klucz ledgera grupy po recovery_id, zachowując oba stare wolumeny.
6. Normalny launcher buduje/startuje dwie usługi tej samej grupy. Nowe
   żądanie fixture oczekuje na Compute. Bez automatycznego Solve.

Weryfikacja: interpretowane regresje fail-closed (bez kompilacji unit tests),
review kontraktu, rzeczywisty dry-run/apply, zachowane hashe i receipty,
readiness nowego API, test WebGL ringu i Primitive→mesh. Standardowe CI PR252
jest dozwolone. Dopiero potem merge i dokładny cleanup zadania.

## Checkpoint końcowego odbioru 24.10

- Standardowe CI jest jawnie dozwolone; c550d91658feb1d5bd76ba5b15f256b3aacf5fbd: wszystkie trzy workflow SUCCESS. Lokalnie unit tests niekompilowane.
- Kamera i ring: browser ee82204eafb142d8bc4786027c323d49 PASS w zakresie viewport_camera, 26 captures; eksport dużej siatki przekroczył limit20s.
- Primitive przed siatką: browser8fda5f6f37384bfdb0a8a11359d1a18c, viewport_camera PASS, eksport/DPR/lifecycle PASS. Ogólny harness FAIL przez planar-default HTTP422 pustej domeny; bez wyciszania.
- mesh_build0333b7f51c5b053c92eaff9b completed, ta sama sesja, domena0→1087250, rewizje3, Compute niewykonane. Observer wykrył niezgodny effective CPU wobec authoredGPU; kwalifikacjaGPU NOT VERIFIED, źródłowy guard odmawia przed kolejną mutacją.
- Końcowa próba po publikacji siatki trwa. Audyt zawiera dokładne identyfikatory i ograniczenia; PR pozostaje draft do ostatniej kontroli renderowania i CI końcowego HEAD.

## Końcowy checkpoint renderowania

- Commit guardów diagnostyki:2332a0ee5e526f9dbaed6644b697e2b436c9ae15.
- Dodatkowy problem:45,6MB topologii potrzebowało31,343s; lokalny limit15s przerywał adoption. Budżet topologii60s, pola bez zmian.
- Browserc977c79890474c259d316495730ec82a: camera26/ring9, export,DPR1/2,lifecycle zakończone. Pixel guard odrzuca6pustychPNG; źródła lint/typecheck PASS.
- Ogólny harness nadal FAIL przez analysis404 i planar422. ImportGPU/effectiveCPU poza naprawą; Compute niewykonane. Audyt nie przedstawia tego jako kwalifikacji całej aplikacji.
- Dalsze kroki: commit końcowego etapu, push, CI bieżącegoHEAD, mergePR252, fast-forward bez ingerencji w cudze zmiany, drain i cleanup dokładnego worktree.
