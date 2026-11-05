# Wspólny przekrój 2D: demag i magnetyzacja

Cel: na jednej płaszczyźnie fizycznej pokazać H_demag w Universe/Airboxie oraz m w materiale ferromagnetycznym. Wspólny zoom, przesuwanie i przekrój; oddzielne jednostki, palety, maski oraz legendy. Nie zmieniamy solvera, materiałów, skryptu ani ProblemIR. Pracujemy bezpośrednio w wyraźnie wskazanym przez użytkownika lokalnym masterze i istniejącej grupie fullmag-master/3342. Zachowujemy wszystkie wcześniejsze i cudze zmiany.

Wybrana implementacja: addytywne `planar.field_overlays` (maksymalnie cztery profile z unikalnymi id), korzystające z istniejących typowanych zasobów planar. Główna warstwa pozostaje dotychczasowym profilem. Każdy overlay określa quantity, component, scope i prezentację; źródło, fizyczny przekrój, rozdzielczość i interakcja są wspólne. UI udostępni magnetyzację jako teksturę kierunku, wektory albo oba sposoby. Domyślna propozycja: tekstura m na tle mapy demag, zgodnie z pytaniem przedstawionym użytkownikowi. Alternatywa z dwoma oddzielnymi panelami nie realizuje wspólnego obrazu. Współdzielenie ustawień 3D naruszałoby istniejący kontrakt niezależnych profili 2D/3D.

## Tożsamość fizycznego przekroju

Dla źródła default opcjonalne `position_m` oznacza bezwzględną współrzędną SI na osi świata odpowiadającej przekrojowi (ujemna normalna Y nie zmienia znaku tej współrzędnej), bez przyciągania do środków komórek lub płaszczyzn węzłów. Nie może współistnieć z `position_fraction`. Istniejący sampler ocenia pole na tej płaszczyźnie; nie dodajemy interpolacji ani nowego algorytmu. FDM nadal korzysta z obecnej rekonstrukcji cell-constant, FEM z obecnego ewaluatora. To sterowanie odczytem, bez zmiany publicznego Python DSL i ProblemIR. Parametr wiąże się z tokenem próbki, linkami, maską, wektorami i metadanymi; brak obsługi nie może powodować powrotu do innej płaszczyzny.

Każda warstwa zachowuje swój raster i zakres UV. Współrzędne lokalne przeliczamy przez `frame.origin_m`, `u_axis`, `v_axis` do wspólnego układu głównej warstwy. Nie łączymy próbek według indeksów ani procentów dwóch różnych siatek. Weryfikujemy zgodność płaszczyzn, operatora, generacji domeny i pochodzenia próbki. Maska m pozwala rysować magnetyzację wyłącznie w ferromagnetyku. Brak przecięcia oznacza pustą warstwę, a nie przyciągnięcie do najbliższego obiektu. Nie przedstawiamy starej warstwy jako bieżącej po zmianie przekroju lub źródła.

Źródła semantyki: `crates/fullmag-api/src/planar_sampling/source.rs` (resolver źródła i snap); `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs` (build próbki i linki); istniejące FDM/FEM ewaluatory planar. Wsparcie i runtime każdej realizacji pozostają osobnymi dowodami; ta praca nie stanowi kwalifikacji parytetu czterech solverów.

## Kroki i odbiór

- [ ] Backend: profile overlay, walidacja i zgodność zapisu starszych sesji; bezwzględny przekrój i regresje tokenów/linków.
- [ ] Generacja OpenAPI/typowanego klienta w zarządzanej grupie; zasoby i klucze cache uwzględniają pozycję SI.
- [ ] Frontend: aktywne tylko na żądanie zasoby dodatkowych warstw, dopasowanie płaszczyzn/pochodzenia, osobne legendy i sterowanie.
- [ ] Renderer: jeden stos 2D, istniejące workery i maski; utrzymanie canvas przy aktualizacji oraz cleanup bez pętli bezczynnej.
- [ ] Weryfikacja: testy kontraktu/niezgodnych płaszczyzn/masek i regresje wcześniejszego trybu; managed typecheck/lint; przebudowa backendu w tej samej grupie z zachowaniem wyników; faktyczny test dwóch wielkości w przeglądarce na 3342. Osobno raportujemy source, runtime i render.


## Checkpoint 2026-11-05 — implementacja i blokada odbioru

Użytkownik doprecyzował: ustawienia są w oknie wizualizacji, osobno dla każdego obiektu i Airboxa, analogicznie do 3D. Kod obejmuje per-obiekt profile, niezależne rastry/wektory/palety/zakresy/style, osobne legendy oraz jawne scalanie touched profile IDs przy pending/inflight/remote ACK. Źródło, przekrój i nawigacja są wspólne. Loader korzysta z zaakceptowanych identities. Dwa stosy canvas przełączają się dopiero po ACK wszystkich warstw; niezmienione warstwy odtwarzają swoje aktualne ACK. Podczas pobierania wektorów pozostaje last-good frame oznaczony jako pending.

Review źródeł wykonane; znalezione błędy buforowania poprawione z regresjami. Managed backend build oraz OpenAPI codegen wykonane dla wcześniejszego stanu źródeł. Najnowsze frontend TSC/Vitest/lint i test wspólnego obrazu w przeglądarce: **NOT VERIFIED**. Scope `frontend-field-map` rozszerzono o nowe testy; bramka wymaga zdrowych usług, których obecnie nie ma. Nie przedstawiać review, buildu ani wcześniejszych dowodów kamery jako odbioru kompozycji 2D.

Runtime fullmag-master/3342: brak miejsca na WSL spowodował terminalnego Failed ownera. Bezpieczny diagnostic-stop potwierdzony attempt `39bf35fbb9ce4f988b1757b58c6b288c`. Dokładnie jeden niepodjęty przebieg weryfikacyjny `run-live-e7eba174b6ef917a50bdaa8f2e94451337449a1664823ba05b68f9de822130fa` został anulowany przez native maintenance; potwierdzenie `2f7a373921a441c5962d190e556beed1`, terminal SHA `69c75d59bbef735a2efda7fd273cfb2b53375c33dcdf609ae8055f89e00b3701`, request `c269c366-37bb-47e4-a723-1b9e37c3d925`. Backend maintenance zakończył się kodem 0, frontend działa; API nie zostało ponownie uruchomione. Zachowano stare wyniki i nie zmieniono skryptu fizycznego.

`recover-cancelled-volume` po naprawie odzyskania przypiętego archiwum nadal odmawia przed mutacją: pierwotny owner ma stan `failed`; ścieżka przyjmuje `ready/unknown`, a przypadek `failed` tylko jako replay wcześniejszego recovery receipt. Tego receipt nie ma. Nie zmieniać ownera, nie wymuszać Unknown, nie kasować markerów. Następny krok wymaga prawidłowej hostowej kontynuacji dla potwierdzonego cancellation + terminal Failed owner albo jawnie zaprojektowanego rozszerzenia protokołu native. Sama podmiana listy dozwolonych stanów jest niepoprawna. Odtwarzalny cache Cypress 15.9.0 (810 MB) przedstawiono użytkownikowi do usunięcia; zgoda oczekuje, nie usunięto go. WSL ma około 170 MB wolnego.

Lekkie testy procedur: 43 PASS (scope checks + diagnostic stop), 3 PASS dziedziczenia layoutu cancellation, 3 PASS przypiętego archiwum recovery. `git diff --check` i składnia harnessu JS PASS. Implementacja bezpośrednio na wskazanym lokalnym masterze, z zachowaniem obcych dirty zmian; bez commita ani publikacji. Odbiór całości pozostaje zablokowany.


### Kontynuacja po zgodzie użytkownika

Użytkownik zatwierdził usunięcie dokładnie `/home/kkingstoun/.cache/Cypress/15.9.0` oraz rozszerzenie bezpiecznej ścieżki odzyskiwania i dokończenie testów. Ponowny preflight wykazał brak procesów/open FD i mountów Docker korzystających z tego katalogu. Usunięto wyłącznie ten cache: available 114999296 → 963731456 bajtów; odzyskano 848732160 bajtów. Wyników symulacji i innych cache nie objęto operacją.

Projekt recovery korzysta z istniejącego `previous_config_sha256` i zwykłego `service-ensure`, który legalnie przejmuje terminal Failed pod owner lock. Wymaga wcześniejszego sprawdzenia całego cancellation/CAS/catalog/process/pair/lease; nie rozszerza generic Unknown recovery, nie przepisuje ownera i nie odtwarza anulowanego zadania. Weryfikacja źródłowa frontendu otrzyma odrębny jawny zakres source-only; nie zastępuje to testu działającego API i przeglądarki.


### Checkpoint runtime i testów — 2026-11-05 rano

Recovery zakończone powodzeniem: development `92eed314bb9946db9184c5b5fcda0140`, Compose SHA `23aca03913fdf48aea50e1d0cfd35f80e7ccd2e21bcc307060200384b7641990`. Backend `bf04e8150e763e39160290b363c56828dab7784b7bedf39eaa8c33f655f8d392`, frontend `cf5b8ffbefb4b2e41e2ecf36db299f2b0253c5a4c69a60253a40390af50a2808`, fullmag-master/3342. Health `ok`; Memory68719476736, NanoCpus8000000000. Recovery nie uruchomiło symulacji (active_session=false). Dowody starego cancellation i siedem terminalnych runów zachowane. Kontynuacja Failed używa ordinary service-ensure, bez zmiany generic Unknown/Rust. Naprawiono też przypięcie domyślnego budżetu z Compose oraz readonly ledger snapshot z właściwym volume-subpath.

Managed OpenAPI codegen PASS, receipt `backend/codegen/openapi-v2/bf0bb0dfc956b9bf51762b80c19ef8c0d9600d5ad55008fe9f508842e30a8144.json`. Managed `frontend-field-map` PASS: TSC,216/216Vitest,ESLint; receipt `verification/frontend-field-map-checks/receipt.json`. Naprawy po czerwonym przebiegu: poprawne wspólne typy profili, refs aktualizowane w layout effects, inline useMemo; raster wyłączany przed setViewport (bez dodatkowego rysowania starej tekstury); ukończone kontury zachowane w cache przy pan/zoom. Regresja korzysta z prawdziwego marchingSquares na2×2 i sprawdza zachowanie1konturu bez kolejnego kolorowania. Tymczasową diagnostykę usunięto.

Jawnie uruchomiono NIEZMIENIONY bieżący skrypt `examples/bimeron-cylinder-relax/relax.py`, którego aktualną konfiguracją jest sam walec; nie przywracano zakomentowanej warstwy/rDMI. Activation `0517b5a373c046459695f3a4b3b27a23`; run `run-live-89fd78b62e4c659aa44c957d26bdec8d34983d9d9ac217bb257afa17607ed226`, completed81steps, requested/resolved GPU, enginefdm_cuda. Sesja `docker-startup-b58491dc34a18670ecc769ebe38977faaef8199d8458a40cf295c0386750334d`. Ustawiono wspólny profil H_demag/Airbox/viridis + object:upper-cylinder/m/hsl_direction, rastry i wektory włączone osobno. HTTP meta H_demag i m mają tę samą accepted observation source_step81. Absolute m position_m=2.625e-8 daje dokładnie originZ2.625e-8 bez snap; domyślny lokalny przekrój m miał2.375e-8, więc to istotna weryfikacja wspólnej płaszczyzny. Pola pochodzą zGPU; dodatkowego Compute Fields nie wykonano.

Browser QA attempt `352e1c49661c434c99dc969b77c70134` został przerwany przy zmianie hosta narzędzi przed utworzeniem przeglądarki. Hostowego procesu QA brak (sprawdzenie poza sandboxem), wszystkie ExecIDs null, obraz reused. Pozostał dokładnie własny helper `fullmag-control-352e1c49661c434c99dc969b77c70134`, receipt starting, bez terminala/browser_id. Nie ponawiać QA i nie kasować active marker; najpierw kwalifikowane prestart reconciliation. Agent planar_runtime_recovery diagnozuje tę ograniczoną ścieżkę. API/backend/frontend pozostają zdrowe, symulacja zakończona. Browser/WebGL kompozycji nadal NOT VERIFIED do zakończenia tej kontroli.
