# Start Docker DEV — koszt filesystemu Windows/9P

Stan na 21.10.2026. Audyt dotyczy grupy
`fullmag-worktree-docker-volume-only-implementatio-670653a9f4702651`,
źródeł `7c16297b1d100c7c95b2d839f774bf8fb79e3709` oraz poprawki statusu
Git opisanej poniżej. Nie stanowi kwalifikacji runtime ani fizyki.

## Potwierdzony problem

Próba development `b0aa3b4d1975403d8c4e7a13241cec07` utworzyła dwie usługi.
Backend `124a4f50062a…` zakończył się kodem 2 podczas capture źródeł:
`status-runtime` przekroczył 300 s; cały pierwszy capture trwał 437 s.
Make, pakietowanie, API i rotacja konfiguracji native nie zostały osiągnięte.
Frontend `11900ad149d2…` pozostał uruchomiony na porcie 32871, lecz żądanie
`/workspace` przekroczyło 180 s podczas kompilacji. Stan procesu `healthy`
nie dowodzi gotowości HTML ani połączenia z API.

Natywny Windows Git odczytał drzewo w 0,297 s i status w 0,187 s.
Probe kontenerowy z limitem 2 CPU odczytał identyczne drzewo w 19,655 s
(SHA256 `18fd282dc5bf36b16ee2c7a51f0ffaa45ad99176222ef1306931cba8015cb11e`).
Status z ignorowaniem submodułów i bez tej opcji przekroczył po 45 s.
To nie jest dowód, że poprawiona kwerenda przekroczy pełny budżet 300 s.

Trace2 oraz próbki własnych procesów potomnych wskazały odświeżanie indeksu
Git i wywołania filesystemu czekające w `p9_client_rpc`. Wyłączenie samego
`core.preloadIndex` nie zmieściło kwerendy w 45 s. Pierwszy probe z limitem
0,25 CPU nie nadaje się do porównania z backendem mającym 4 CPU.

Próbki własnych wątków Node przez wewnętrzny inspector wykazały
`statx → p9_client_rpc`. Stabilny odczyt pathname dla 15 wywołań wskazał
rzeczywiste pliki `apps/control-room/src`, również pliki testowe. Nie były
to ścieżki cache ani `node_modules`. Same otwarte pliki `.pack.gz_` nie
dowodzą, że kompresja cache jest przyczyną zawieszenia.

Pomiar maszyny Docker i cgroup frontendu wykluczył aktywne swapowanie oraz
presję pamięci: PSI memory/IO bliskie zeru, brak OOM, bez przyrostu swap I/O.
Brak dowodu, że samo zwiększenie RAM lub usunięcie cache rozwiąże problem.

Dowody w grupowym control volume:

- `verification/source-git-probes/86a5b9f11bfa4246959053420bb26825.json`;
- `verification/source-git-probes/218922a1b1a14980935c74b01a0d578a.json`;
- `verification/vm-pressure/5d596f1ecb44465ba74a7b5b73287713.json`.

## Poprawka o sprawdzonym zakresie

Backendowy live capture i oba tryby kanonicznego helpera źródeł przekazują
`--ignore-submodules=all` do statusu Git. Wnętrza gitlinków są wyłączone
z wejść aplikacji i native dirty identity; ich skanowanie było zbędne.
Backendowy manifest nadal wiąże przypięte commity gitlinków z HEAD/index
w polu `excluded`.

Regresja używa rzeczywistego `external_solvers/3`: zmiana plików wewnątrz
nie zmienia digestu aplikacji, natomiast zmiana przypiętego commita w indeksie
zmienia manifest. Sprawdza też rzeczywisty capture kanonicznego helpera
w obu trybach. Baseline: 13 testów, 1 oczekiwany błąd braku flagi; po poprawce:
13/13 zaliczonych. Źródła readonly i stabilne, dane testowe wyłącznie
w control volume; bez kompilacji testów Rust.

Receipty regresji:

- `verification/interpreted-attempts/ece6ac564cae47f1aec83ea6828f00f7.json`;
- `verification/interpreted-attempts/9859ede07f754bdb9e13dc6d35045304.json`.

## Wynik dalszego odczytu na tym checkoutcie

Poprawiona kwerenda ze źródeł, z limitem 4 CPU jak backend, zakończyła się
poprawnie w 195,296 s; drzewo odczytano w 14,071 s. Receipt:
`verification/source-git-probes/6ec560053ea746bfaf4ba90bf5138b52.json`.
Dowodzi to zakończenia tej kwerendy w budżecie 300 s, lecz nie pełnego capture,
buildu ani gotowości API.

Osobny probe `fs.watch` na bindzie Windows zobaczył nowy własny plik wejściowy,
ale przez 12 s nie dostał żadnego zdarzenia. Po kontroli bajtów usunięto
wyłącznie ten plik. Receipt:
`verification/native-watch/b5376eebebef4b8f8405fa5aeb00868e.json`.
Samo wyłączenie globalnego pollingu mogłoby więc zgubić wykrywanie nowych tras.
Nie zostało zastosowane jako rzekoma naprawa HMR.

## Granice i dalszy odbiór

Poprawka submodułów nie jest dowodem naprawy kosztu wszystkich plików
śledzonych. Wymagane pozostają: pełny capture na checkoutcie Windows,
start API/native, odpowiedź Home, HMR, restart z cache i wykonanie skryptu.
Zmiana obrazu wrappera wymaga właściwej zarządzanej ścieżki odtworzenia;
sam restart starego obrazu nie wdroży zmienionego `backend_source.py`.

Zachowano wolumeny, cache, konfigurację ownera i held run `run-live-9f453e3a…`.
Nie ponawiano Solve, nie zwalniano zasobów bez dowodu ani nie przenoszono
źródeł do archiwum. Optymalizacja musi zachować live bind, pełne hashe
wejść i wykrywanie zmian HEAD, indeksu oraz bajtów plików.


## Kontynuacja po błędzie capture

Nowy validator zachowuje istniejący pending binding po błędzie capture przed
Make. Przypina kanoniczne current/terminal, zapisany Compose, failure log,
źródła, accepted-run oraz historyczny owner/process/config. Bieżący kontener
przechodzi odrębny pre-admission proof; historyczne metadata nie są wiązane
ponownie z jego inkarnacją. Zachowano zwykłą ścieżkę natywną i jawny fresh-state.
Kontrakt: ADR 0066, moduł `docker_volume_pending_continuation.py`.

Odczytowy preflight rzeczywistej próby `b0aa3b4d1975403d8c4e7a13241cec07`
przeszedł bez operacji lifecycle. Potwierdził `restart_verified=false`,
niezużyty binding, zachowane accepted-run i nieobecność historycznych kontenerów.
Właściwy pin Compose to SHA kanonicznego dokumentu
`1a27bcdfd85dd17de22d7523239befe84a23e3984ae0d4f412b88695b3546f64`.
SHA surowego pliku z końcowym LF (`670b398c…`) jest innym pinem. Hash konfiguracji
natywnej pozostał `7555da771595cf28af13bbe618e24dc67ea34d92ef1213da57403245a4df78a8`.

Regresje źródeł i callera, z readonly bindem i stabilnymi wejściami:

- `verification/interpreted-attempts/0c860ca80fc54121801c83e07e456165.json`;
- `verification/interpreted-attempts/61e106a7d4f84d4ba06df27d134bcc1b.json`.

Końcowe regresje błędnych receiptów i wznowienia:
`verification/interpreted-attempts/2744f7b78d474014b1c4a124f644021e.json`.

Oddzielnie 87 testów publikacji backendu przeszło po dostosowaniu istniejącej
regresji do retencji odłożonej poza startup:
`verification/interpreted-attempts/8a6ff1e7d4a147cbb44e053b7e1a97bf.json`.

Odczyt debuggera pokazał zakończone kompilacje trzech compilerów Next, bez
błędów i aktywnego przebiegu `Watching`. Kolejny GET `/workspace` zwrócił HTTP
200 po 0,235 s i pierwszy 1 KiB HTML po 0,25 s. Nie jest to dowód wyrenderowanego
Home ani pełnego UI; browser QA nadal wymaga zdrowego backendu. Backend tej
próby pozostaje zakończony kodem 2 do właściwej operacji odtworzenia i nowego
pełnego capture/build/start.


## Nowa inkarnacja i fixture CI

Zarządzane odtworzenie `edbe6a54154345ff94bfdae66e139536` zakończyło się
poprawnie, zachowując wolumeny build/package i dane użytkownika. Toolchain
oraz development-base wykorzystano z cache. Nowy backend `ed56b7ba…` i frontend
`35705f36…` należą do tej samej grupy Compose; wrapper ma obraz `sha256:c9299404…`.

Próba development `43ab21e7c6d349a6922d72ca5d7995b2`, z zamrożonym HEAD
`08c0c810ab8750399415eda73e7f57ddb3df14fe`, zakończyła oba odczyty capture:
105,013 s i 110,939 s, łącznie 216,140 s dla 9185 plików. Synchronizacja
spójnej kopii źródeł trwała 1155,787 s, po czym rozpoczęło się
`make install-cli-dev` w tym samym kontenerze backendu. Nie jest to dowód
ukończenia kompilacji ani startu API. Odczyty `/proc` potwierdziły rzeczywisty
postęp od dokumentacji do skryptów i danych referencyjnych testów; brak OOM,
swap i presji pamięci. Nie zmieniono limitów ani nie usunięto cache.

Dwie kontrole CI na HEAD `08c0c810…` wymagają naprawy samych fixture:

- `python-contracts`, job `118952520802`: test oczekuje błędu wyjścia poza root,
  lecz tworzy absolutny symlink, odrzucany wcześniej przez właściwą politykę.
  Commit `4dc0ffcd012315c165bfa89b26eea5bada4474fe` używa względnego celu
  `../outside`. Walidacja produkcyjna pozostaje bez zmian. Diff i składnia AST
  zostały sprawdzone; pełny moduł pytest pozostaje do potwierdzenia w CI.
- `browser-fixture-smoke`, job `118952520626`: audyt FDM nie podawał sceny
  ani zasobu membership wymaganego przez renderer. Fixture uzupełniono o
  zgodne scene/regions, FMRM v2, support 320 aktywnych i 448 nieaktywnych
  komórek siatki 24×16×2, bounds i nagłówki FMVP v2. Zachowano istniejące
  bramki podpisów obrazu, pamięci, lifecycle i idle. Nie zmieniono renderera,
  solvera ani nie zastosowano odrębnego draftu ACK/capture-settle.

Sprawdzenie `node --check` rzeczywistego pliku po zmianie przeszło w zarządzanym
helperze tej samej grupy Compose, z readonly source i stabilnym SHA
`3556d2c2bff3753dd387af9d4c6c8b2372bdd01436e0c75360c35f591653151c`.
Receipt: `verification/syntax-attempts/84a5a64f47804bc5a413417c0611ab5d.json`.
Wynik dotyczy składni; właściwy browser gate pozostaje NOT VERIFIED.

Zmiany fixture wykonano dopiero po `sync complete`; bieżący Make nadal
korzysta z niezmienionego shadow HEAD `08c0c810…`. Nowy frontend rozpoczął
kompilację `/workspace`; probe HTTP przekroczył 30 s. Sam health procesu Next
nie dowodzi wyrenderowanego Home. Native/API, browser, HMR, cache restart,
wykonanie skryptów oraz kwalifikacja czterech realizacji pozostają odrębnymi,
nieukończonymi bramkami. Held run `run-live-9f453e3a…` zachowano bez Solve replay.


## Odbiór buildu i rozdzielenie locatorów reattach

Make w backendzie `ed56b7ba…` zakończył się kodem 0 po 1971,620 s.
Pierwsze wywołanie Cargo trwało 21 min 30 s, a budowa modułu Python
`fullmag-py-core` 10 min 14 s. Publikacja 24 plików pakietu trwała 2,397 s,
a jego weryfikacja 1,606 s. Bramki `windows-folder-v1` i `worker-cgroup`
przeszły. API używało spójnego snapshotu HEAD `08c0c810…`.

Start API ujawnił błąd walidatora Rust: porównywał źródłowy locator w
stopped-namespace attestation z lokalizacją późniejszej kopii archiwalnej
z reattach proof. Producent attestation zapisuje przed archiwizacją
`runtime-control/runtime-service/process-tree.json` i
`runtime-control/runtime-services/OWNER.json`. Reattach proof wskazuje kopie
`accepted-run-reattach/<key>/terminal-process.json` i `terminal-owner.json`.
Są to różne role; historycznych bajtów nie należy przepisywać.

Odczyt rzeczywistego wolumenu potwierdził proof SHA
`6538d8e984c21573c0810dc226341988ed8f512594ff9313cf26b74bf4787d0f`
i attestation SHA
`8af2632b7718e0a37bd79e229225e70ede61781c83052e44527b2d5ae0ad7ed5`.
Wszystkie przypięte hashe archiwum były zgodne; obie zagnieżdżone treści
attestation były równe archiwom. Dane nie były uszkodzone. Rust sprawdza
teraz dokładne kanoniczne locatory źródłowe attestation, zachowując osobną
walidację archiwów, hashy, treści, ownera i inkarnacji kontenera. Regresja
odrzuca locator archiwalny, obcy i wychodzący poza root dla obu pól.
Test Rust jest przeznaczony do istniejącego CI; nie kompilowano go lokalnie.
Ponowny build/start z tą poprawką pozostaje NOT VERIFIED.

## Audyt pamięci frontendu po fixture FDM

Na HEAD `f8345cec…` kontrakty Rust/Python, typecheck/lint/test/build Control
Room, deterministyczność API, smoke fizyki FDM CPU i Inspector browser przeszły.
Browser fixture pre-proof job `118965121849` nie przeszedł: po stresie było
390 żywych buforów wobec baseline 334. Ten pomiar sam nie rozróżnia wycieku
od zimnych alokacji i przedwczesnego pomiaru.

Poprawka `07d72b02cb4c78c637ed62deaccfb59963e6708c` zwalnia stary atrybut
`instanceColor` przez publiczne `InstancedMesh.dispose()` przed jego usunięciem
lub zastąpieniem. Bufor tej samej długości nadal jest aktualizowany w miejscu.
Rzeczywiste Three.js r186 udostępnia tę metodę; nie dodano ręcznych eventów
ani redundantnego cleanupu React. Regresja używa rzeczywistego `WebGLObjects`
z kontrolowanym właścicielem atrybutów i 120 cyklami. Jest przeznaczona do CI.

Audyt rozgrzewa maski warstw przed pomiarem, oddzielnie zapisuje cold baseline,
unmount oraz steady baseline po remount. Czeka na `rendered` ACK przypięty do
rewizji, klienta i viewportu, adopcję pola i zakończenie pracy workerów.
Końcowy pomiar również czeka na adopcję; unmount ma ograniczony czas zamiast
stałego sleep. Zachowano limity `baseline + 16` i `liveBuffers <= 4`, kanoniczne
nagłówki FMRM/FMVP oraz niezależny dowód zwolnienia zasobów. Kontrola fidelity
wymaga aktywnego kontekstu WebGL i niezerowego drawing buffer. Odpowiedź fixture
ACK zawiera wymagane `received_at_unix_ms`.

Niezależne review potwierdziło zakres i wskazało brak timestampu w odpowiedzi
fixture; został uzupełniony. Wynik nowego browser gate pozostaje NOT VERIFIED.
Lokalnego Vitest nie uruchomiono: kontrola uprawnień odrzuciła kompilację testów
poza wyjątkiem CI. Nie zastosowano obejścia. Hook commita przeskanował zmienione
pliki React Doctor i zgłosił istniejące wcześniej `array.find()` poza poprawką.
Nie jest to dowód wykonania testów ani WebGL.

Kontrola składni audytu po zmianie przeszła w helperze grupy; receipt
`verification/syntax-attempts/e15b169fae07492693f8e05ae002a53c.json`,
SHA źródła `f992cf146efa6f8d63dc30b08b34a55885517ebff03bde9e2d5e2a5c7734404a`.


## Powtarzalna iteracja i porównywalny pomiar GPU

Następna próba `ab140d52dd0a4be5b198429241a505bf` użyła z cache tych samych
obrazów toolchain, development-base i backend wrapper. Capture trwał 171,327 s,
a synchronizacja 9185 plików na zachowanym wolumenie 3,358 s. Make zakończył
się kodem 0 po 133,899 s; drugie Cargo dla modułu Python trwało 13,50 s.
Pakiet 24 plików opublikowano w 1,974 s i zweryfikowano w 1,550 s.
To dowód przyrostowej iteracji z zachowanym cache, nie gwarancja czasu dla
dowolnej zmiany ani pominięcia wszystkich zależnych konsumentów. Pełny odbiór
API/native i restart bez zmian pozostają oddzielnymi bramkami.

Na HEAD `e7e2bf00…` CI zakończyło Control Room typecheck/lint/tests/build i
Python contracts sukcesem. Regresja `development_accepted_restore::tests`
również przeszła. Browser fixture `118978631813` doszedł do końcowej kontroli
subskrypcji: baseline 379, po unmount 400. Artefakt `12313401509` ma SHA
`a937ed79311f4b65e693ff58e3df55cccd6b1e0c4bb90ceaebd417d1597a9f87`.

GPU checkpointy wynosiły cold 332, pierwszy unmount 2, steady 334, po stresie
264 i końcowy unmount 4. Samo zaliczenie progu nie dowodzi braku wycieku:
baseline miał `H_ex` i widoczne punkty, a końcowy stan `m/component-x` bez
punktów. Większy początkowy footprint mógłby zamaskować wzrost. Audyt po pełnym
warmupie ustawia teraz baseline na ten sam stan co końcowy shader pass,
oczekuje ACK/adopcji i zapisuje oba footprinty; odrzuca ich niezgodność przed
porównaniem `baseline + 16`. Stress 120 i niezależny unmount `<=4` pozostają.
Przyczynę wzrostu subskrypcji nadal badamy; nie podniesiono limitów.

Kontrola składni po dopasowaniu footprintu przeszła; receipt
`verification/syntax-attempts/38233f759d3f4c4d9806e6fe43b5d4b5.json`,
SHA audytu `fc312364daba11a193d9d1b6e5d8571960ecdaa016b913dbd62d4badde5afcc9`.


## Odtworzenie bieżącego runu przed projekcją preparation

API próby `ab140d52dd0a4be5b198429241a505bf` przeszło walidację
locatorów i wczytanie proof, a następnie zakończyło się kodem 101:
`accepted preparation requires the current durable live run`.
Odczyt receipt potwierdził `failed_outcome_retained`, brak procesu native
i SHA `a33a58aad9281450616e6c243d91914f115fdda21afedf628c1829b2588a98f1`.
Kontrolowane `docker_volume_stop_failed.py` zatrzymało dokładnie backend
`68a4849d…` ze stanem `stopped-confirmed`; model i historia pozostają.

Przyczyna leży w konstrukcji mirroru: `default_current_live_state` tworzy
pusty workspace i celowo nie zachowuje opcjonalnych `run` ani `metadata`.
Prywatny adapter reattach przekazywał je w request, ale nie przenosił do
wyniku. Teraz zachowuje obie wartości z wcześniej zweryfikowanego RunIntent
i proof przed istniejącą walidacją frontier. Nie zmieniono wspólnego
inicjalizatora, kontroli tożsamości ani kolejności publikacji authority.
Operacja nie tworzy tasku, ownera, lease ani Solve.

Trzy regresje obejmują Held, terminalny Consumed i odtworzenie zapisanej
awarii preparation. Przegląd źródeł i diff-check wykonano; kompilację testów
Rust pozostawiono istniejącemu CI zgodnie z wyjątkiem użytkownika.
Start API i native runtime po tej poprawce pozostają NOT VERIFIED.


## Początkowy nadzór zakończonego procesu API

Po nieudanym probe `wait_for_api` sprawdza opcjonalny callback `api.poll`.
Jeżeli proces API już się zakończył, przerywa oczekiwanie od razu zamiast
czekać do końca budżetu 300 s. Proces nadal działający zachowuje retry.
Przekazanie callbacku dotyczy wyłącznie początkowego oczekiwania; późniejszy
liveness, owner, drain i recovery pozostają bez zmian. Błąd zachowuje
rzeczywisty tekst ostatniego probe, więc znany connection-refused zachowuje
kanoniczną postać, a inne przyczyny nadal wymagają osobnej kwalifikacji.

Cały moduł interpretowanych regresji `test_fullmag_docker_runtime` przeszedł
w ograniczonym helperze tej samej grupy Docker, z readonly source i stabilnymi
wejściami. Receipt: `verification/interpreted-attempts/99251e33bac84b4cbb7192d4ed897ab0.json`,
exit code 0. Nowe przypadki obejmują exit 101 bez sleep, retry żywego API,
wyjątek obserwatora i przekazanie callbacku wyłącznie do początkowego wait.
Niezależne review nie wykazało blokera. To kontrola Pythona, nie dowód
zdrowego API ani kompilacja testów Rust/TypeScript.


## Zbieżność subskrypcji po odmontowaniu viewportu

Końcowa bramka audytu nadal wymaga identycznych aktywnych subskrypcji jak
po pierwszym odmontowaniu. Teraz bounded wait obejmuje także ich stabilizację: trzy
kolejne identyczne próbki po zwolnieniu GPU/workerów, a przy ostatnim unmount
dodatkowo powrót do dokładnego baseline. Limit 10 s, limit czterech buforów,
120 publikacji i końcowy assert subskrypcji pozostają bez zmian. Produkcyjny
ResourceRuntimeStore liczy aktywne listenery; zero jest brakiem klucza.

Niezależne review potwierdziło zakres. Nie dowiedziono jeszcze, czy wynik
379 → 400 z wcześniejszego CI był opóźnionym unsubscribe czy trwałym wzrostem;
nowa bramka ma to rozróżnić, zachowując błąd i ostatnią próbkę po timeout.
Referencja po pierwszym unmount nie dowodzi zera pozostałości przed pierwszym
mountem. Kontrola Node --check przeszła w helperze grupy, stable source SHA
`ad4e371bbe92708f5ab1b5f6290674e58014d1114e5bfa0e3c7edc67a5e37d19`,
receipt `verification/syntax-attempts/418d2e6aab294815bd75a6f1aa9507e1.json`.
Pełny browser gate pozostaje NOT VERIFIED; lokalnie nie kompilowano testów JS.


## Działający backend i porównywalny moduł 2D

Kontrolowane odtworzenie `6f973d8effb14fd7920459b64c6169c6` i development
`eb982e6ce4c2404fbca89de0cc3d5b29` zakończyły się sukcesem. Config SHA:
`5d55ac959260403281a78ba43ba302950aae9e5e2aa530de03899a771b6471ab`.
Backend `177b9c65…` i frontend `3144d222…` są healthy, port frontendu 32871,
obraz wrappera `sha256:af482bc37e762c45fb189a21d183ad17e62a2d649da8bd6591d275f87ba5ab82`.
Obraz zmieniono dla poprawki Pythona; toolchain i oba wolumeny cache/package
`fullmag-backend-v2-edd94a86dd242c865f0e0210-*` zachowano. Capture trwał
172,041 s, sync 3,492 s, Make 117,283 s, publikacja 24 plików 2,775 s, verify 1,597 s.

API czystego HEAD `2d32e83b8d55dea774925167fb0ffa85a12414aa` i snapshotu
`d05f908d59f8e2e5201e5ef445ffc0bfdbe39465c314bf2698ed287e6ed32e1b`
odtworzyło run bez Solve: frontier projection 5,085 s, cały restore z ACK 9,947 s.
Od 01:46:00 UTC nadzorca zgłasza Ready API/native. Status HTTP200 pokazuje
`fdm_cpu_relax_smoke`, connected/awaiting_command; domain/meta HTTP200 ma siatkę
16×32×2. Receipt: `verification/api-readiness-observation-fe9142ad76b74dd6a3cc3fcbb1b9eacd.json`.
Compute nodes HTTP200 zgłasza aktualną próbkę i RTX4080SUPER; receipt
`verification/compute-readiness-observation-b454da5560cb4350a92ed822d4121cda.json`.
To nie dowód wykonania symulacji ani kwalifikacji wszystkich realizacji GPU.

Frontend po kompilacji odpowiada HTTP200 na /workspace (0,594 s). Zarządzana
próba browser QA `c8edbbc85567407ba88348531b53d52a` przekroczyła obserwację
klienta 180 s; dokładny helper `8e010bd7…` zakończył się później kodem 0 po
282,637 s, lecz wynik stdout jest utracony. Nie kwalifikujemy browser proof
z samego exit code; zasoby i fence zachowano do kontrolowanej rekoncyliacji.

CI `39528186129` zaliczyło Rust restore oraz Control Room typecheck/lint/test/build.
Browser fixture zachowało stabilne +21 listenerów przez 189 próbek; analiza dwóch
niezależnych ścieżek wykazała dokładny fingerprint jednej generacji FieldMapModule.
Pierwszy baseline mógł powstać podczas lazy Suspense przed montażem 2D. Audyt
czeka teraz na dokładnie jeden istniejący moduł field-map w oczekiwanym układzie,
bez companion/loading; zapisuje oba układy i diagnostykę błędu, po czym stosuje
dotychczasową konwergencję i limity. Dowodzi montażu właścicieli, nie renderingu
danych 2D. Node --check zaliczone, receipt
`verification/syntax-attempts/db10e02d1f3b413fa4601dc0b45f7982.json`, stable SHA
`41ded1c3a5d59362c367dc068b18956be52201b452fa76cd93e6761a870fcf3e`.
Nowy browser gate, HMR/restart bez zmian, wykonanie wskazanych skryptów i merge
pozostają NOT VERIFIED.

Review uzupełniono o rzeczywisty zapis obu układów w failure artifact oraz
diagnostykę status/alert także na root FieldMapStatus. Status danych pozostaje
poza porównaniem tożsamości montażu; pełna gotowość planaru nie jest tu deklarowana.


## Rekoncyliacja zakończonego QA z utraconym stdout

Rekoncyliacja nie kwalifikuje sukcesu z exit code. Po timeout klienta exact
stopped helper z kodem 0 musi również dać się zamknąć technicznie jako
`failed-confirmed`, `output_lost=true`, `verification=NOT VERIFIED`. Usunięto
wyłącznie odrzucenie terminalnego ExitCode0; pozostają kontrole CAS receipt/
Compose, source/image/helper identity, command, stopped/OOM/restart, trwały
zapis dowodów przed usunięciem dokładnego browsera oraz potwierdzenie absence
i zwolnienia oryginalnego helper fence. Żywy browser nadal jest odrzucany.

Cały moduł interpretowanych regresji `test_docker_dev_browser_qa` przeszedł
z readonly/stable source w helperze grupy. Receipt
`verification/interpreted-attempts/2a81a9e5d08544a4883e5af05f6d2888.json`, exit0.
Niezależne review potwierdziło fail-closed semantykę. Nowa regresja wymaga
wyniku NOT VERIFIED także dla ExitCode0 i jawnie odrzuca `succeeded`.
Domyślnego timeoutu nie zmieniono. Powtórzenie rzeczywistego harnessu może
użyć istniejącego parametru `--timeout 600`, ponieważ zmierzony przebieg
trwał 282,637 s; limity pojedynczych operacji i bramki dowodu pozostają.


## Odbiór Home i Workspace

Zarządzana kontrola przeglądarkowa zakończyła się sukcesem z zachowanym
wynikiem i terminalnym receiptem w control volume grupy. Potwierdziła Home,
przejście do Workspace i z powrotem, komunikację z API, stabilny canvas DOM,
niezerowy drawing buffer WebGL2 i zachowany kontekst. Kontrole kamery,
układu i eksportu również przeszły. Browser używał software WebGL;
ten wynik nie kwalifikuje CUDA ani wykonania symulacji. Nie wywołano Compute,
nie anulowano istniejącego runu i nie ponowiono Solve.

Wcześniejsza próba z utraconym stdout pozostaje NOT VERIFIED mimo exit code 0.
Zamknięto ją kontrolowaną rekoncyliacją; poprawny dowód pochodzi z osobnego,
ukończonego przebiegu z zachowanym wynikiem.

Publiczne CI zaliczyło kontrole Control Room, Pythona, Windows storage i CPU
FDM smoke. Audyt memory churn przeszedł. Kolejny audyt FEM topology upload
wykrył, że licznik opisany jako pozycje obejmuje wszystkie ARRAY_BUFFER,
w tym generowane per-part normal attributes. Nie dowodzi to wzrostu uploadu
współdzielonych pozycji. Bramka pozostaje niezaliczona do rozdzielenia metryk,
bez podnoszenia progów ani zmiany oświetlenia sceny.

HMR po edycji Windows, restart bez zmian, nowa aktywacja skryptu, rzeczywiste
CPU/GPU Solve, trwałość po restarcie, izolacja dwóch grup i końcowe CI/merge
nadal wymagają odrębnych dowodów. Retencja pakietów pozostaje odłożona poza
start API; samo umieszczenie ich w named volume nie ogranicza liczby kopii.


## Dokładny pomiar uploadów pozycji FEM

Probe WebGL rozpoznaje aktywny atrybut `position` z programu shaderowego
i przypisuje uploady do konkretnego WebGLBuffer przy vertexAttribPointer.
Uwzględnia upload przed pierwszym pointerem oraz kolejne aktualizacje tego
samego bufora. Całkowite ARRAY_BUFFER pozostaje osobną metryką diagnostyczną;
normalne nie są zaliczane jako pozycje. Zakres sceny, oświetlenie i dotychczasowy
próg plateau pozostają bez zmian. Brak rozpoznanych pozycji kończy próbkę błędem.

Poprawiono również zliczanie przeciążeń bufferData/bufferSubData: offset celu
nie jest rozmiarem uploadu; source offset i length są liczone w elementach,
a length=0 obejmuje pozostałe elementy źródła. Regresja Node VM jest podpięta
do istniejącego browser fixture CI. Niezależny przegląd nie wykazał P1.
Managed Node --check obu plików przeszedł ze stabilnymi wejściami; lokalnie
nie uruchamiano testu jednostkowego. Rzeczywisty browser gate po tej zmianie
pozostaje do potwierdzenia w CI.
