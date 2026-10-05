# P8-54 — natywny build backendu na żądanie

## Cel i decyzja użytkownika

05.10.2026: użytkownik zastąpił wcześniejszą decyzję o automatycznym watcherze
(120 sekund ciszy) kompilacją wyłącznie na żądanie. Współbieżne zmiany agentów
nie mogą odrzucać wyniku już rozpoczętej kompilacji. Frontend zachowuje HMR.
Budowa nie restartuje API ani symulacji; kontrolowany restart pozostaje osobną
bramką P8-53.

## Zakres implementacji

1. Proces developerski oczekuje na jawny intent. Przycisk **Build backend**
   używa typowanej fasady API, identyfikatora żądania, przypięcia instancji API
   oraz dokładnego Origin. Powtórzenie tego samego intentu nie uruchamia
   kolejnej kompilacji; nieznany wynik HTTP wymaga odczytu tego intentu.
2. Zarządzana trasa Windows zachowuje resolver, blokadę ciężkich prac,
   wyłączną blokadę buildu i terminalny receipt. Polecenie użytkownika
   `just windows-workspace-build dev dev 3197 auto` nadal jest jawnym żądaniem.
   Uruchomienie `just windows-ui dev` przygotowuje brakujący/nieaktualny pakiet.
3. Przed kompilacją powstaje utrwalona kopia plików. Manifest rozróżnia
   checkout pochodzenia, tożsamość źródeł i hash inventory kopii. Kopiowanie
   wykrywa zmiany podczas przechwytywania; po jego zakończeniu sprawdzane są
   wyłącznie utrwalone pliki, niezależnie od dalszych zapisów w checkoutcie.
4. Cargo kompiluje tę kopię, korzystając z dotychczasowego target/cache.
   Python korzysta z utrwalonych źródeł; instalacja metadanych nie może
   modyfikować kopii. Działające zależności zachowują obecną blokadę zmian.
5. Gotowy pakiet i wybór kandydata są przypięte do manifestu buildu,
   nie do aktualnego stanu edytowanego checkoutu. Pełny log kompilatora jest
   zachowany w storage i wskazany przez receipt, również po błędzie.

Kopia zachowuje dwa zakresy dowodu: `source_identity` opisuje runtime Git
z jawnym `ignore_non_runtime_dirty`, natomiast `inventory_sha256` opisuje
wszystkie faktycznie skopiowane bajty. Edycje React/dokumentacji podczas
kopiowania nie wymuszają ponowienia capture. Źródła natywne oraz zależności
(w tym Python, `package.json` i lockfile) nadal muszą być spójne w całym
krótkim etapie kopiowania. Tylko wyścig capture można ponowić, najwyżej trzy
razy; błąd kompilacji nie uruchamia automatycznej kolejnej próby.

Jedyny zapisywalny wyjątek w drzewie kompilatora obejmuje cztery standardowe
pliki JSON generowane przez Tauri w `apps/desktop/src-tauri/gen/schemas`.
Są ograniczone nazwą, rozmiarem i formatem, oznaczone jako wyniki kompilatora
i nie stanowią dowodu utrwalonych źródeł. Python i Next otrzymują osobne
zapisywalne kopie robocze; nie modyfikują utrwalonych plików.

## Kryteria weryfikacji

- Edycje bez żądania nie uruchamiają żadnego buildu.
- Jeden intent powoduje najwyżej jedną próbę; błąd nie tworzy pętli ponowień.
- Edycja checkoutu po capture nie unieważnia kopii; modyfikacja kopii jest
  odrzucana. Zachowane są surowe bajty CRLF i kontrola ścieżek/linków.
- Kompilacja produkcyjnych binariów Windows kończy się z pełnym logiem
  i terminalnym receiptem; zakaz kompilowania testów jednostkowych obowiązuje.
- Przeglądarka wyświetla akcję, przyjmuje intent i obserwuje jego wynik.
- Build nie zatrzymuje działającego API ani obliczeń.

## Stan

W toku. 05.10.2026: 11 interpretowanych regresji snapshotu PASS, w tym
surowe CRLF, późniejsze zmiany origin, zmiany frontendu/dokumentacji podczas
capture, odmowa zmiany zależności, modyfikacja kopii oraz ograniczony wyjątek
Tauri. Focused review tej granicy nie wykazał wymaganych poprawek.
Samodzielny etap snapshotu zapisano lokalnie w commicie
`91d0788bd6b7c63327b45fab1770a44720176689` (helper i jego 11 regresji).

Próba natywna wykryła starą kontrolę stagingu frontendu, która odrzucała
źródła położone wewnątrz build root. Wyjątek obejmuje teraz wyłącznie pełny,
zweryfikowany snapshot wskazujący dokładnie przekazane źródło. Kopie Next
pozostają zapisywalne, a HMR wskazuje żywy checkout. **11 kontroli stagingu
PASS**, w tym odmowa brakującego, niedopasowanego i zmodyfikowanego snapshotu;
focused review bez wymaganych poprawek. Helper i regresje zapisano w commicie
`b5d6c1d08b7760fa77e06111a647ee5b47a41868`.

Kontrole `test_fullmag_storage.py`, `test_windows_backend_watch.py` i
`test_windows_development_status.py`: **48 passed, 2 skipped, 16 subtests
passed**. Weryfikują m.in. brak kompilacji bez intentu, jednokrotne zużycie
żądania, trwały log błędu oraz odrzucenie manifestu B przy receipcie buildu A.
Każdy dopuszczony do wykonania request UI ma osobny terminalny receipt pod pochodną ścieżką
`build-requests/<request_id>.json`; wynik obserwowany z CLI również wymaga
zgodności z hashem manifestu zapisanym pod blokadą jego własnego wykonania.
Odmowa przed uzyskaniem blokady jest zapisana jako prywatny wynik intentu;
nie stanowi wykonania kompilatora ani receipt zakończonego buildu.

Interpretowany check `check-development-backend-build-action.mjs` zakończył
się exit 0. Przegląd API/UI potwierdził poprawki monotonicznego wyniku intentu,
kontrolowanego ponowienia tego samego żądania po nieznanym wyniku oraz blokady
restartu przy aktywnym lub nierozstrzygniętym buildzie. To dowody źródłowe,
uzupełnione niżej dowodem działania akcji w natywnym workspace.

Zarządzane kontrole UI 05.10.2026 zakończyły się PASS:

- typy źródeł produkcyjnych: `production-source/91df80ee7e7745cab4657ce37fe00b4f`;
- jawny intent buildu: `development-backend-build-action-check/5007f8a59e2649eab7e7b834e2b85087`;
- lint sterowania buildem/restartem: `development-restart-action-lint/3248e517f0b944d9bf2679a845b728b2`;
- React Doctor: `react-doctor/5644fb1c384e4ffcb78c17b865e99ed7`.

Każdy wpis ma terminalny `receipt.json` w profilu
`windows-control-room-source-check` głównego checkoutu. Nowa recepta
`just verify-control-room-development-backend-build-action` uruchamia
interpretowany harness z kontrolą źródeł i receiptem, bez kompilacji testów.

Próba `native-build-7d101a266ec74b53ac9a7f2a30adb93f.log` z 05.10.2026
utrwaliła źródła i przeszła staging, lecz kompilator zakończył się błędem
`rustc-LLVM ERROR: IO failure on output stream: no space on device`.
Receipt ma stan `failed`, exit 1; to brak miejsca, nie odrzucenie zmian
checkoutu. Nie stanowi dowodu gotowego pakietu. Po zmianie stanu dysku
na około 35 GiB wolnego miejsca rozpoczęto kolejną zarządzaną próbę.

Natywny pakiet został następnie zbudowany i uruchomiony na porcie 3197.
Odczyt działającego API 05.10.2026 potwierdził commit
`3ea4ad3ce94ca4733529b8bf5b4293a0320f7328`, source snapshot
`22ca876ecde3169a97e40e7cbd910da29546de396a9599d5c29e9b95c2c8d77d`
i obecność trasy jawnego żądania buildu w OpenAPI. Terminalny build receipt
ma stan `completed`, exit 0, manifest
`29a5d14c11a40a4cbaab5726e15aa9df9607ef7365a34801a95923439eea85cf`.
Workspace otworzył pustą scenę bez modalu wymagającego buildu meshu.

Test akcji w działającym UI wykrył nieaktualną obserwację odbiornika:
proces był obecny, lecz status nie był odświeżany. Poprawka izoluje jego
stdin/stdout/stderr od terminala; log trafia do pochodnej ścieżki
`runtimes/<worktree-id>/logs/backend-watch-<generation-id>.log`, wskazanej
w owner record. Błąd heartbeat zatrzymuje odbiornik przed czytaniem
kolejnego intentu. Kontrole Python: **51 passed, 4 subtests passed**,
plus nowa regresja awarii heartbeat **1 passed**. Zastosowanie poprawki
do sesji potwierdzono po jej zamknięciu i ponownym uruchomieniu za zgodą
użytkownika. Odbiornik odświeża status, a jego osobny log jest dostępny.

### Rzeczywisty build z UI — 05.10.2026

Przycisk **Build backend** zakończył żądanie
`584e9cff-8802-4f81-90ea-d88284600c7d` stanem `ready`. Osobny receipt
`build-requests/584e9cff-8802-4f81-90ea-d88284600c7d.json` ma stan
`completed`, exit 0, manifest
`87f9290d18885505768872e89f2780a93a3776bbbf585991cd555faf1d98e679`
i source identity
`a67cffa13fe36def14d0c74287ddfa15ca473ad837ea27a317dbec11a32c347d`.
Wykonanie trwało od 08:04:36Z do 08:12:28Z. Pełny log:
`logs/native-build-0d0810e2b2174f22b4ca0e5d5192b3b3.log`.

Podczas kompilacji utworzono przez UI pusty model FDM
„Backend build smoke 2026-10-05 1008”, session
`session-18db93cbb12a1d2c0000f3a4`. Po zakończeniu przeglądarka nadal
wyświetla ten model i połączoną sesję. API instance pozostał
`a41515ea-341f-42e2-9bb8-3e67b9e510be`, a działający runtime zachował
wersję `0.1.0-dev.20261005.gc168dc5ff1c5.dirty.scee8e8472732+9774`.
Build nie zastąpił działającego backendu. Banner potwierdza gotowy build
oraz niedostępny restart (`restart_integration_pending`). Nie uruchamiano
obliczeń; ten dowód nie potwierdza zachowania aktywnej symulacji.

Pierwsza próba UI została odrzucona przed kompilacją przez blokadę innego
zadania. Natywne żądanie może teraz czekać najwyżej 120 sekund na zasób,
bez ponawiania kompilatora. Limit jest sprawdzany przed każdą próbą
uzyskania blokady i po jej uzyskaniu. Zamknięcie właściciela workspace
anuluje oczekiwanie oraz uniemożliwia start kompilatora. Łączne kontrole
storage, lease, statusu i odbiornika: **90 passed, 2 skipped,
16 subtests passed**. Są to testy interpretowane, bez kompilacji testów
jednostkowych Rust.

Snapshot zachowuje teraz czasy modyfikacji źródeł; increment zapisano
w commicie `fe6584e441f6985b3a3b99b2662c5abb25c031a9`, z 12 zaliczonymi
kontrolami snapshotu. Rzeczywista próba nadal kompilowała szeroki zestaw
lokalnych crate: CLI/API 4 min 02 s, desktop 2 min. Samo zachowanie
timestampów nie potwierdziło szybkiego przyrostowego buildu. Dalsza praca
nad stabilną ścieżką wejść kompilatora pozostaje otwarta; target/cache
nie usuwano.

Dalsze review wskazało kontrolę anulowania przed samym `Popen`, po otwarciu
logu; poprawkę potwierdza regresja bez uruchomienia procesu. Aktualny zestaw
storage: **39 passed, 2 skipped, 12 subtests passed**. Review tego przyrostu
nie pozostawiło wymaganych poprawek. Kontrole launchera po aktualizacji
starych oczekiwań stałych ścieżek release dały **57 passed,
1 skipped, 12 deselected**. Wykluczone 12 przypadków korzysta z kompilowanego
probe URL Rust. Pierwsza szersza próba objęła ten probe; nie opisujemy jej
jako w całości interpretowanej i nie ponawiamy jego kompilacji podczas
obowiązywania zakazu. Pełny build produkcyjny oraz działający UI pozostają
odrębnymi dowodami opisanymi wyżej.

Review wykryło dodatkowo niespójność domyślnego portu generycznej recepty:
Windows FDM otrzymywał `0`, którego jego launcher nie dopuszcza. Recepta
wybiera teraz `3100` tylko dla natywnego Windows bez jawnego portu;
FEM zachowuje `0`, a jawne porty są zachowane. Cztery rzeczywiste kontrole
dispatchu bez uruchamiania buildu PASS. `windows-ui dev` nadal używa `3197`.

### Następny przyrost: stałe wejścia kompilatora

Stały katalog `compiler-inputs/source` w tym samym build root ma służyć
wyłącznie jako robocze wejście Cargo. Niezmienny snapshot pozostaje źródłem
provenance, Python, stagingu Next i wersjonowania. Synchronizacja odbywa się
pod istniejącymi blokadami, pomija zapis identycznych plików i usuwa jedynie
uprzednio zarejestrowane, nieobecne już wejścia. Pełna kontrola bajtów przed
i po kompilacji dopuszcza tylko dotychczasowe cztery wyniki JSON Tauri.
Nieznany plik, link, uszkodzony binding lub niedokończona synchronizacja
mają blokować build; bez automatycznego czyszczenia lub przejęcia katalogu.

Drugą potwierdzoną zależnością jest compile-time stamp w
`crates/fullmag-build-info/build.rs`: reaguje na wersję, czas i tożsamość
snapshotu. Zależności w Cargo.toml obejmują również `fullmag-runner` oraz
`fullmag-runtime-control`, więc aktualizacja provenance może pociągać ich
rekompilację nawet przy stałych ścieżkach i niezmienionych solverach.
Nie wolno wyłączyć aktualizacji wersji ani raportować starej tożsamości jako
nowego buildu. Ewentualne oddzielenie stampu binariów od ciężkich bibliotek
wymaga osobnego przyrostu z zachowaniem tożsamości artefaktów i kontroli
zgodności usług. Stały katalog sam w sobie nie dowodzi rozwiązania tego
drugiego kosztu; wymagany pozostaje rzeczywisty pomiar kolejnych buildów.

Helper stałego katalogu ma 10 zaliczonych regresji interpretowanych oraz
nową zaliczoną regresję odmowy niekanonicznego rekordu snapshotu. Launcher
materializuje wejścia przed Cargo i weryfikuje je po udanej kompilacji,
przed publikacją manifestu. Parser PowerShell oraz trzy fokusowane kontrole
kontraktu launchera PASS. Integrację potwierdziła niżej opisana pierwsza
próba natywna. Pomiar kolejnego buildu opisano poniżej; nie kwalifikuje
wszystkich rodzajów zmian backendu.

### Stałe wejścia — pierwsza próba natywna i dalsza optymalizacja

Helper zapisano w commicie `bf32fda48868f5bda4a0aa3a314c0f680307257d`.
Usunięcie powtórnych skanów w ramach jednej operacji ma pełny zestaw
**12/12 PASS** i commit `be87c55061e346029536596d3190f719716c490d`.
Nie ma cache weryfikacji między wywołaniami: binding i bajty są nadal
sprawdzane przy każdym buildzie. Publikacja bindingu wymaga dokładnego
odczytu zwrotnego. Test odrzuca jego zmianę podczas publikacji.

Pierwszy `just windows-ui dev` ze stałym katalogiem Cargo zakończył build
stanem `completed`, exit 0. Log
`logs/native-build-3c036de9b4dd4c8da7373e50e17dc8b0.log`, manifest
`65851fe704eb603678252bef9d9788fa9d631ca86ac9865079179f4f4d9367e8`,
utrwalone źródła
`7898239fb9a54984601e580d248ac94e87326f055233ed7efc20845868f3e667`.
Receipt: od 12:04:11 do 12:18:32 czasu lokalnego. CLI/API: 4 min 25 s;
desktop: 2 min 08 s. Pierwsza kopia obejmowała 7494 pliki, 307072773 bajty.
Łączny czas wyniósł około 14 min 20 s; to nie jest dowód szybkiego buildu.
Commit optymalizujący helper wykonano po capture, a build nadal poprawnie
zakończył pracę na poprzedniej, utrwalonej wersji narzędzi.

Pakiet uruchomiono na 3197, bundle `3b1de31747fb4fe7b5275b8cfdec42cd`,
API instance `dd582f13-cad8-43f8-8d6b-2ec957551fc0`. Przeglądarka pokazała
pusty Start bez modalu meshu, dostępny przycisk Build backend i stan waiting.
Uruchomiona przez ten przycisk kolejna próba ma request
`4428c9b0-f1b1-4855-8c17-e4d56c087f31` i log
`logs/native-build-ee10e20005e443e492c9c90b1c31f9a5.log`.
Próba zakończyła się `completed`, exit 0, manifest
`44137ba584458288cd57110696133e7bb06dcb8fc19f06c45a42ea1e5b9342fb`,
source snapshot
`f1085c07e58d30c48bb5b660f8dc9ae36be498dd4dbe050e33200bb4e50b48e1`,
backend source SHA
`950da5b653aae50208d162bd1f2ad4637740c5191195b88771a45b3ce4d2ea3d`.
Receipt: od 10:22:26Z do 10:27:56Z, czyli **5 min 30 s**. Cargo CLI/API:
**32,46 s**, desktop: **45,93 s**. Dokładne porównanie par
ścieżka/hash w obu inventories potwierdziło brak zmian plików `.rs`;
zmieniały się narzędzia buildu i stamp. Jest to dowód ponownego użycia
kompilacji w tym scenariuszu, nie ogólny benchmark każdej zmiany Rust/CUDA.
Pozostały czas przygotowania i weryfikacji źródeł nadal wymaga poprawy.
Przeglądarka pokazała „The requested backend build is ready”, ten sam
API instance i niezmieniony działający build A. Odbiornik nadal był aktywny.

### Odporność statusu na blokadę pliku Windows

Po wcześniejszym udanym buildzie odbiornik rzeczywiście zakończył się wskutek
`WinError 5` podczas atomowej podmiany `backend-watch-status.json`.
Osobny log umożliwił rozpoznanie przyczyny. Zapis statusu ponawia teraz tylko
końcowe `os.replace`, tylko na Windows dla kodów 5/32/33, przez maksymalnie
sekundę. Tworzenie pliku, inne błędy oraz domyślny zapis pozostałych metadanych
nie są ponawiane. Trwała odmowa nadal zatruwa publisher i zatrzymuje odbiornik.
Zestawy statusu/storage: **50 passed, 2 skipped, 19 subtests passed**;
review tego przyrostu bez wymaganych poprawek.
Poprzedni zapis właściciela zachowano przez zarządzane recovery, archive
`native-runtime-prior-f3b5301823544c98af1025005f96e76f.json`, SHA
`575790a64add74d73b7b687dfe71d48d68db5ed92e8f7f1b1a8ac20fe6d677f2`.
Nowy odbiornik pracuje w ponownie uruchomionym workspace i przetrwał cały
powyższy rzeczywisty build. Dłuższa obserwacja stabilności pozostaje otwarta.

Ten dokument nie potwierdza gotowości kontrolowanego restartu z odtworzeniem
modelu, kwalifikacji FEM ani ukończenia P0–P8.
