# P8-53BM — kamera po development restart

## Status

Potwierdzony wcześniej błąd P1 odtworzenia kamery ma poprawkę ownera
oraz dodatni dowód natywnego restartu Windows/FDM CPU z Grid/Compute.
Terminalna bramka `2998926363e84fd5b32569767c9a44b0`: **10 PASS, exit 0,
27/27 procesów odebranych**, wszystkie sześć pól kamery preserved=true.
Guard capture kamery także ma regresję z rzeczywistego UI.
Integracja PR #160 i odrębna poprawka korelacji modalu Grid pozostają
otwarte. Nie zamyka to P8-53, pozostałych lane ani całego planu.

## Dowód przed poprawką

Prywatna próba przeglądarkowa na 3258, z rzeczywistymi procesami Windows:
receipt `4db8d035170f4d5799d7d89443e7eed1` w profilu
`development-backend-api-checks`, worktree-id `fullmag-0950f4dca4ffe38f`.
Katalog receipt zawiera `camera-before-restart.json`,
`camera-after-restart.json` i `camera-after-mounted-kernel.json`.

Normalny przycisk View → Ortho ustawił projekcję `orthographic`.
Po normalnym Restart backend oraz zamontowaniu nowego kernela API zwróciło
`perspective`. Pozostałe pola zachowały wartości: position
`[2e-6, 1.4e-6, 2e-6]`, target `[0,0,0]`, up `[0,0,1]`,
fov_degrees `45`, orthographic_scale `null`.

Stary API instance: `602ba5cb-44f9-4cc1-8a37-8580031cbdb3`;
nowy: `38fab2c2-7269-44b6-a368-29157c037a57`. Nowy kernel osiągnął
generation 1, paused=false, publication_error=null. Model próby był
odtworzonym przez API wejściem testowym; nie jest to dowód ręcznego
autoringu całej sceny w UI. Projekcję zmieniono rzeczywistym przyciskiem UI.

Próbę świadomie zakończono po wykryciu błędu, przed pełnym Grid/Compute/Finish.
Receipt jest terminalny `failed`, exit 1; wszystkie 24 zapisane procesy
mają waited=true. Nie kwalifikować tej próby jako PASS restartu.
Sesji użytkownika na 3197 nie zatrzymano.

![Workspace po restarcie przed poprawką](53bm-camera-reset-before-fix.jpg)

## Wzmocnienie weryfikatora

`scripts/windows/verify_workspace_browser.py` zapisuje kamerę przed restartem
i porównuje po nim wszystkie sześć pól: projection, position, target, up,
fov_degrees oraz orthographic_scale. Brak pola, obce pole, niepoprawna
projekcja, niefinitywna liczba lub niepoprawny parametr blokują pozytywny
wynik; weryfikator nie zastępuje danych wartościami domyślnymi.

Nowy interpretowany regression check sprawdza każdy utracony parametr,
niepoprawne dane, izolację kopii i zachowanie null scale.
`just verify-windows-development-handoff`: **165 testów, 0 skipów, exit 0**.
Receipt `57d5fc8a660e4eaf8c2c1b71ecd30201`; tożsamość źródeł przed/po:
`cc5c085cdc0d1ebbb370170d7b2067a6034891c661705133700a3d41b5314e31`.
Nie kompilowano testów jednostkowych. Te testy dowodzą kontroli dowodu,
a nie naprawienia produkcyjnego odtworzenia kamery.

Ponowna seria po dopasowaniu FOV do backendowego zakresu `[1,179]`:
165 testów, 0 skipów, exit 0, receipt `ba44d7f6f0b74f0daf205dfefa272c3e`.
Źródła przed/po: `03458c10c461ad9f80e2b4e785a0f4c28620b140cac0d595644b2a29b21e70f2`.
Regresja odrzuca także 0,5 oraz 179,5 stopnia.

## Odbiór poprawki

Owner musi przenosić ścisły snapshot kamery, wykrywać jego zmianę podczas
handoffu i odtworzyć go przez istniejący typowany visualization API nowego
procesu. ACK oraz odczyt z nowego pinned API muszą zgadzać się przed
publikacją kernela. Wymagane są także jawny odczyt starszego payloadu,
obsługa pustego workspace i odmowa publikacji przy błędzie.

Pozostają: konkretne regresje ownera, kontrole produkcyjnego frontendu,
nowy zamrożony pakiet oraz rzeczywista próba restartu z porównaniem kamery.

## Checkpoint implementacji ownera

Owner zapisuje teraz workspace v2 z kamerą; starszy v1 ma jawny reader.
Przygotowanie replacement odrzuca brak session_id i niepoprawny session_epoch.
Kamera sesji jest odtwarzana przez typowane PATCH/GET visualization; brak
zgodnego ACK lub odczytu blokuje publikację. Sessionless workspace ma
camera=null i nie wywołuje niedostępnego endpointu sesji.

Scoped lint przeszedł: receipt `3062fa8c0afe40fb8d889dd7da5f440e`.
Pierwsza kontrola produkcyjnych typów (`2e488dd351ef44f894f6ef1da915d1b4`)
wykryła niewężony opcjonalny session_id ownera, poprawiony następnie jawną
walidacją. Wykryła także niezależny błąd nullable snapshot w równolegle
zmienianym computeNodeInventory.ts; nie należy do tej poprawki.

Pierwsza próba konkretnych ownerów w Chrome na 3251 zakończyła się failed:
receipt `6547c409dfec427eb67bedb64aa8a01d`. Istniejący mock NewProblem
nie udostępniał resources.getRevision wymaganego przez useResource;
wykonanie przerwano przed nowymi regresjami kamery. Naprawa adaptera próby
jest w toku. To nie jest PASS ani dowód poprawności produkcyjnego restartu.

## Wyniki review

- P1 owner: świeży rejestr kamery ma lastRemoteRevision=null i kamerę
  domyślną. Dla aktywnej sesji capture musi odmówić przed przyjęciem takiego
  stanu. Wymagane są potwierdzona remoteCamera oraz lastRemoteRevision,
  oprócz braku dirty/sync/error. Dla sessionless workspace pozostaje jawne
  camera=null. Regresja tej odmowy jest w realizacji.
- Wycofany P1 backend (ponowny audyt 13.10.2026): camera-only PATCH
  zwiększa `selection.revision`. `patch_visualization_state` zawsze
  wywołuje `apply_display_patch_to_state`, także dla pustego display patch;
  ta funkcja bezwarunkowo zwiększa rewizję. Następnie handler publikuje ją
  w realtime i odpowiedzi. Pełny przepływ w `display.rs:261`, `:352`,
  `:409`, `:1819`, `:2020` potwierdziło niezależne review źródeł.
  Wcześniejszy finding pomijał to wywołanie; nie wymaga poprawki backendu.
  Rzeczywista synchronizacja kilku klientów nadal NOT VERIFIED.
- P2 backend: orthographic_scale=null w PATCH jest interpretowane jak brak
  pola przez Option<f64>. Świeży backend ma domyślnie null, ale ACK/readback
  musi odmówić publikacji, jeśli docelowy stan nie zgadza się z capture.
  Pełne czyszczenie skali pozostaje osobnym otwartym kontraktem.

Review nie znalazło automatycznego PATCH nowego rejestru przy montażu:
hydracja wykonuje zapis/odczyt przed publikacją, a świeży namespace zasobów
po montażu pobiera backend. To dowód źródłowy; runtime po poprawce pozostaje
NOT VERIFIED. Nie zamykać punktu na podstawie samego review.

Weryfikator odrzuca także position==target i zerowy up, zgodnie z backendem.
Seria `5a42876f577b4d3fbfded703698d7637` wykryła brak importu sys w tej
nowej kontroli. Po dodaniu importu receipt `d812db40be7c49efaf800c74c26e8da3`
potwierdził ponownie 165 testów, 0 skipów i exit 0. Nie jest to dowód
runtime ownera kamery.

## Końcowe dowody konkretnych ownerów

Managed Chrome na 3251: receipt `98aedd887c6d41a3a2370c19dde2fdc2`,
**34/34 PASS**, exit 0, brak page_errors i console_errors, własny serwer
terminalny. Fingerprint przed/po:
`53809fd60c1431074c2dcdb44475cc6d86f84921e2635da4726dafad1c83b7dd`.
Rzeczywiste kontrolery projektu, registry i typowana fasada API wykonały
przenoszenie sześciu pól, odmowę przy niezgodnym ACK/readback, mutation guard,
odmowę niezaobserwowanej kamery ze zwolnieniem guardów, odmowę współdzielenia
starego rejestru, v1 compatibility i sessionless null. Odpowiedzi API są
fixtures: nie jest to restart procesu Windows ani kwalifikacja solvera.

Finalny scoped lint ownera: receipt `42269c36ee83410fabfa7125319f353f`, PASS.
Kontrola produkcyjnych typów `1d0f5dcc0766432b9bfe1f19a0c86fb2` nie zgłaszała
już błędów ownera ani fixture; pozostał obcy błąd computeNodeInventory.ts:260
(`snapshot` possibly null). Cała kontrola ma zatem FAILED, nie PASS.

Próby pośrednie zachowano: `17fb3745c0e8451585f52d4f4e9f9b9c` miała
32/33 PASS, bo asercja canSave wymagała otwartego projektu zamiast pustego
dokumentu; `b7c55c20283949fe8844cba3ef9840cb` miała 33/33 kontrole ownerów,
ale stary selektor dialogu New Problem zatrzymał dodatkową kontrolę UI.
Aktualizacja smoke do etykiet New simulation/Create simulation i nazwanej
zgody zastąpienia zachowuje asercje Cancel/pending/failure. Receipt
`609f4f48ce6d4b809e145c8e76e39455` potwierdził 34/34 przed dodaniem ostatniej
regresji odmowy współdzielenia rejestru. Końcowy receipt jest podany powyżej.

Natywny restart po poprawce oraz dwa restarty A→B→C w jednej sesji
przeglądarki pozostają NOT VERIFIED. Status P8-53 pozostaje otwarty.

API hygiene: receipt `cea917eb274649e1b65aa5c876c9c68a`, PASS.
Końcowa kontrola produkcyjnych typów po guardzie świeżości rejestru:
`e5ec865c017d4184a73eabeb2ee3a7f1`, FAILED wyłącznie na
computeNodeInventory.ts:260. Własne pliki poprawki nie zgłosiły diagnoz.
Nie promować tego checkpointu do pełnej kwalifikacji frontendu ani wydania.

## Natywny pakiet po poprawce — 13.10.2026

Zarządzany `just windows-workspace-build dev dev 3258 true` zakończył się
kodem 0; wrapper zapisał `state=completed` o
`2026-10-13T19:03:41.476902+00:00`. API/CLI i launcher desktopowy skompilowano
w profilu `backend-dev`; integralność utrwalonej kopii źródeł przeszła kontrolę.
Build nie kompilował testów jednostkowych i nie restartował workspace na 3197.

- Commit: `1c0c35dcf8a4d7dcb0cbde10f3c723c83b729a22`; snapshot obejmuje
  także zastane zmiany równoległej pracy, zatem `source_dirty=true`.
- Snapshot źródeł:
  `8d236794af8bfcd0b9a78f4fe64767990fb0cffde33410ee63b3cf1b94bdc038`.
- Kapsuła:
  `ff37087d52de092122c8621425b9e5c3f57469841e4017252e4fee344fc50310`.
- SHA-256 manifestu pakietu:
  `e14f2a96f55b69177b979543095dc7d1006ca28a6493f0b1b48d8f72daee14b7`.
- SHA-256 API:
  `053b19f3e144befeff29f8afeb7cad435757a3c43c0c08daf3883b4b32049c65`.
- Manifest zamrożonych źródeł frontendu:
  `cef3504337a530d4f0b117762bb6718df1fbf1d6565d83e5f68af46c490038d1`.

Dowody znajdują się pod rozwiązaną ścieżką
`storage/builds/fullmag-0950f4dca4ffe38f/windows-native-fdm-cpu-dev/`:
`build-status.json`, `windows-runtime/build-manifest.json` oraz
`logs/native-build-1c9664e56d224fd3a67e8158d6a65db7.log`.
Sukces kompilacji nie zamyka bramki kamery, solvera ani wydania.

Wykonano odrębną natywną próbę przeglądarkową na 3258:
receipt `fa2d27b2689b434785b39a3c28374623`, source binding
`verified_frozen_native_package`. Próba zakończyła się FAILED, exit 1,
przed udostępnieniem strony: zamrożony frontend zawierał błąd
`computeNodeInventory.ts:260`, TS18047 (`snapshot` possibly null).
Wszystkie 18 procesów ma terminalne `waited=true`; nie wykonano restartu
ani porównania kamery. Workspace 3197 pozostał nietknięty.

W bieżącym checkoutcie dodano jedną linię `!snapshot ||` do istniejącej
walidacji parsera compute inventory. Pozostała równoległa implementacja
tego nieśledzonego pliku została zachowana i nie jest przejmowana do
commita kamery. Zarządzana kontrola całych produkcyjnych typów po tej
poprawce przeszła: `4d5cb65a806c4521b49ef378bd4803d8`, exit 0, PASS.
Nie poprawiano zamrożonej kapsuły ani nie pomijano jej kontroli.
Próba restartu wymaga nowego pakietu zawierającego poprawiony frontend;
wynik natywnego restartu z zachowaniem kamery nadal NOT VERIFIED.

### Kolejny pakiet i próba przeglądarkowa

Równoległy build workspace zakończył się `completed`, exit 0,
`2026-10-13T19:18:23.012310+00:00`. Jego kapsuła
`b7717905b6f3ccd0f9a77a36a2f1f7c0a0b3bbd016d938e3e3a455e00d4eb6ac`
zawiera poprawiony guard compute inventory i poprawkę ownera kamery.
SHA-256 manifestu:
`f72044f8f8ecb465504db38eec79850e1fb32564e23b73716cc088cc478d286b`;
snapshot źródeł:
`30ad419872263b72330c5d54f6c6d72007453ef5b64d88c5ff1df37637a23aef`.
API SHA-256:
`d40f262ac4e29e5e75d9511ac4c710cbed227da21df1b94605984c84872e24e5`.

Próba `7b9184b3b1a4452dbe359867c0d98245` przeszła typecheck i lint
zamrożonego frontendu (oba exit 0) i udostępniła prywatny browser-ready.
Przez Chrome utworzono projekt i pudełko; canvas był widoczny,
`context_lost=false`, drawing buffer 1183×518 oraz 1183×565.
Nie wykonano restartu ani capture kamery. Odczyty gotowości następnie
utraciły potwierdzenie (`readiness_observation_unconfirmed`), a sterowanie
Chrome kończyło się timeoutem. Nie ustalono wspólnej przyczyny tych zdarzeń.

Próba jest terminalnie FAILED, exit 1; wszystkie 19 procesów ma
`waited=true`. Nie należy ponawiać jej jako żywego procesu ani uznawać za
PASS. Diagnoza obserwacji gotowości i rzeczywisty restart kamery pozostają
otwarte; żadna sesja użytkownika na 3197 nie została zatrzymana.

### Diagnoza utraty obserwacji gotowości — 13.10.2026

Prześledzono `readiness_frame` w
`crates/fullmag-cli/src/control_room/development_workspace_probe.rs`.
Wyjątek może pochodzić z odczytu consumer status przez prywatny kanał
ownera API, odczytu pending restart slot albo zegara. Niezgodność
`require_ready_identity` sama zwraca `Ok(None)` i nie tłumaczy terminalnego
`readiness_observation_unconfirmed`. Consumer status nie używa HTTP:
`OwnedDevelopmentApi::consumer_control` wysyła uwierzytelnione żądanie TCP
na loopback, z limitem odpowiedzi 2 sekundy. Nie ustalono jeszcze, która
z tych granic zawiodła w próbie `7b9184b3b1a4452dbe359867c0d98245`.

Dodano do lokalnego kodu konteksty tych trzech granic i zapis łańcucha
błędu na stderr. Zachowano terminalny wynik `unknown`, protokół stdout,
warunki dopuszczenia restartu oraz istniejące timeouty. Statyczne review
nie wykazało P0/P1 ani logowania owner tokenu/payloadu żądania.
To diagnostyka, nie potwierdzona naprawa ani dowód zachowania kamery.

Zarządzany build diagnostyki zakończył się przed kompilacją: exit 1,
`2026-10-13T19:44:11.321932+00:00`, log
`native-build-923110612a3a42899917c3770a8bafe6.log` w istniejącym profilu
`windows-native-fdm-cpu-dev`. Przyczyna:
`Source inventory differs from request fingerprints` podczas capture.
Istniejący `capture_for_build` ponawia wyłącznie wyścigi źródeł do trzech
prób; nie zwiększano limitu ani nie omijano kontroli. Sam komunikat nie
rozstrzyga jeszcze przyczyny rozbieżności. Diagnostyka Rust pozostaje
niezweryfikowana przez kompilację i rzeczywisty odczyt błędu.

Następne żądanie buildu zakończyło oczekiwanie na slot ciężkiej pracy
po 120 sekundach, exit 2, przed rozpoczęciem kompilacji
(`Bounded wait expired before starting`). Oba nasze żądania są terminalne;
nie uruchomiono równoległego wykonawcy i nie zatrzymywano obcych procesów.
Następny krok: odróżnić zmiany plików od deterministycznej rozbieżności
inventory/fingerprint, a po uzyskaniu slotu zbudować diagnostykę i ponowić
prywatną próbę kamery. P8-53 i cały plan pozostają otwarte.

Odczytowa kontrola inventory w kolejnym kroku zakończyła się exit 0:
backend i dependencies miały odpowiednio zgodne pary hashów
`d98cca6bbc0717e3b8412092871102cd3168d77801041deeaf289807f1f45049`
oraz `e329a2b68344dbbec936f25fea9fc436fc9aee42183ace12644bb309a53386b6`,
bez zmienionych/brakujących plików między tymi odczytami. To chwilowa
obserwacja checkoutu, bez zapisu snapshotu, a nie dowód wcześniejszej
przyczyny ani udanego buildu. Nie znaleziono deterministycznej rozbieżności
filtrów przy tych wejściach. Slot ciężkiej pracy zajmował w tym czasie
aktywny managed FEM GPU build-only z worktree `fem-script-launch-20261013`;
jego procesów ani blokad nie zmieniano.

### Jawne wyczyszczenie skali kamery — implementacja w toku

Istniejący wygenerowany kontrakt `VisualizationCameraPatch` dopuszcza
opcjonalne `orthographic_scale` jako `number | null` (format `double`,
brak w `required`). Lokalna poprawka parsera używa istniejącego w module
`deserialize_double_option` i rozróżnia brak pola (`None`), jawne null
(`Some(None)`) oraz liczbę (`Some(Some(value))`). Aplikacja PATCH przypisuje
wewnętrzny Option; walidacja nadal odrzuca wartości niedodatnie i niefinitywne.
Jawny `schema(value_type = Option<f64>)` ma zachować istniejący kontrakt.

Dodano dwie regresje Rust: serde round-trip, set/preserve/clear bez zmiany
pozostałych pól kamery oraz odmowę 0, -1, infinity i NaN. Nie kompilowano
ich ani nie uruchamiano — zgodnie z obowiązującym zakazem kompilacji testów.
W istniejącym zarządzanym weryfikatorze API dodano odrębną regresję HTTP
na jego prywatnej odtworzonej sesji: set → absent → null, nowe rewizje
i identyczny GET readback; po odmowie 0/-1 kamera i rewizja mają pozostać
bez zmian. Parser AST tego weryfikatora przeszedł, lecz to nie wykonanie HTTP.

Po zakończeniu obcego procesu uruchomiono następny managed build-only:
log `native-build-687f97a99f144ac6b1899e7ec86f77d5.log` w istniejącym
profilu. W momencie tego wpisu trwa capture. Wymagane są terminalny
build receipt, regresja HTTP, porównanie eksportu OpenAPI oraz rzeczywisty
restart kamery. Punktu P2 i P8-53 nie oznaczono jako zamkniętych.

Capture następnie zakończył się poprawnie: kapsuła
`4eae0210c3641894aac49629c7dff458e8fdb97f13e36f84f213e74cbe901525`,
snapshot źródeł
`e45a260b2dde7cd57ec3cfa162ccd05e970ed492a4b2f328ace4180998119e0d`,
backend fingerprint
`c17ea5cd5bc142136d8021c3bfcec32d630aba2018b280a78dbabf52b03345ca`,
HEAD `29ca31c72dd1d4d7901f88843c0e87e639372956`, dirty.
Hashy trzech zmienionych plików Rust w kapsule i checkoutcie są identyczne.
Build przeszedł przygotowanie wersji Python; brak jeszcze terminalnego
wyniku produkcyjnej kompilacji i żadna regresja HTTP nie ma jeszcze PASS.

Review poprawki Rust i regresji HTTP nie wykazało P0/P1. Wykryto P2
w fixture `project-document-handoff-page.tsx`: operator `??` nadal
ignorował null. Poprawiono fixture i rozszerzono istniejący scenariusz
rzeczywistych ownerów o hydrację kamery perspective/null do replacement API
z początkową skalą `2.75e-6`. Wymagane są typowany PATCH ACK oraz GET
readback przed publikacją; poprzednia semantyka fixture nie przechodziłaby
tego scenariusza. Managed próba fixture zakończyła się odmową storage lock
przed testami, ponieważ ten sam checkout jest zablokowany przez nasz
aktywny build. Nie ma nowego fixture PASS. Bieżący build zakończył instalację
zależności Python i pnpm; dalszy wynik należy odczytać z tego samego
uchwytu procesu, bez uruchamiania kolejnej kompilacji.

### Terminalny build poprawki — 13.10.2026

Ten sam build zakończył się `completed`, exit 0,
`2026-10-13T20:15:06.792704+00:00`. Receipt profilu
`windows-native-fdm-cpu-dev/build-status.json` potwierdza tożsamość checkoutu,
profilu i logu powyżej. API/CLI skompilowały się w 3m24s, launcher desktopowy
w 1m32s; są to czasy faz Cargo, nie całego przygotowania pakietu.
Digest opublikowanego `windows-runtime/build-manifest.json`:
`1626bd35933b27d1edc6cbdb812c81429a6f5a8a21819e092b6c86e40fed872b`.
Powstały produkcyjne `fullmag.exe`, `fullmag-api.exe` i `fullmag-ui.exe`
w profilu `backend-dev`. Nie kompilowano testów jednostkowych.

Uruchomiono na tym przypiętym manifeście
`just verify-windows-frozen-development-backend-api
1626bd35933b27d1edc6cbdb812c81429a6f5a8a21819e092b6c86e40fed872b`.
Próba `1995c74607ba4a4a852388b1a854447a` jest w toku; nie ma jeszcze
terminalnego PASS regresji HTTP ani eksportu OpenAPI. Użytkowy workspace
na 3197 pozostaje poza zakresem tej próby. Sam sukces kompilacji nie
zamyka P8-53, weryfikacji restartu kamery ani kwalifikacji wydania.

### Regresja natywnego API — PASS

Próba `1995c74607ba4a4a852388b1a854447a` zakończyła się `completed`,
exit 0, `2026-10-13T20:26:41.494384+00:00`: 301 kontroli, 98 procesów,
wszystkie z `waited=true`. Receipt znajduje się w profilu
`development-backend-api-checks/checks/1995c74607ba4a4a852388b1a854447a/receipt.json`.
API SHA256: `a8cfabccf09595b6da4582a584531b1319c892f87f74903be390d621f0f6e4d8`;
weryfikator: `931ebdb1afedab11dd41b63b437f5038ccc44301f86a6ab60c4cacc2c94934ef`.

Potwierdzone na prywatnym odtworzonym API:

- `camera-scale-patch-set-revision-and-readback`;
- `camera-scale-patch-absent-revision-and-readback`;
- `camera-scale-patch-clear-revision-and-readback`;
- `camera-scale-invalid-patch-preserves-state-and-revision`;
- `camera-scale-openapi-optional-nullable-double`.

Kanoniczny eksport OpenAPI ma digest
`885325f890e91ea5ded348dbf05dbdc4169400753915c7a556b610d767b919c6`.
Brak pola nadal zachowuje skalę; jawne null ją usuwa; 0/-1 są odrzucane
bez mutacji stanu i rewizji. Pozostałe pola kamery są porównywane dokładnie
w odpowiedzi PATCH i GET. Publiczny kształt opcjonalnego `number | null`
pozostał zgodny z istniejącym klientem. Pełna próba obejmowała także
kontrole właściciela runtime-service — frozen manifest nie pomija tej fazy.

Po zwolnieniu blokady uruchomiono `just verify-project-document-handoff-browser`
na prywatnym porcie 3251. Jej wynik i rzeczywisty restart przeglądarkowy
pozostają na tym etapie otwarte; testy Rust nadal `NOT RUN`.

### Regresja ownerów w przeglądarce — PASS 35/35

Próba `2d8e25fdfbfb48aabf04169b00d72ebc` zakończyła się `passed`, exit 0,
`2026-10-13T20:27:52.218911+00:00`, serwer fixture zakończony i port zamknięty.
Receipt oraz raport i screenshot są w profilu
`windows-control-room-browser-fixture/project-document-handoff-browser/2d8e25fdfbfb48aabf04169b00d72ebc/`.
Digest źródeł przed i po:
`54fe203a0d74c0b55f224f5f81f2a8b3842001b094784d9a305defada3eeae9f`.
Raport potwierdza 35/35 scenariuszy, zero `page_errors` i `console_errors`,
w tym `concrete owner clears the replacement camera scale through typed patch and readback`.
Poprawka parsera null i odpowiadająca jej semantyka fixture mają już dowód
natywnego HTTP i przeglądarkowy dowód ownerów. Ten ostatni używa fixture API:
nie jest dowodem rzeczywistego restartu procesu ani zachowania WebGL.
P8-53 nadal wymaga osobnej prywatnej próby restartu z natywnym backendem.

### Checkpoint integracji i następna bramka

Zweryfikowany fragment zapisano i wysłano na `origin/master`:
`6b4fceba3379d5944c3f16f5329291ca9b6cafef`
(`fix: clear nullable camera scale during development handoff`). Zakres:
parser/aplikacja PATCH, regresje HTTP i fixture ownerów, bezpieczna
diagnostyka granicy readiness oraz powyższe dowody. Po push HEAD i
origin/master są zgodne; staging jest pusty. Obce zmiany pozostawiono.

Uruchomiono `just verify-windows-development-workspace-browser
12984ba740244e5e86d8878814069155`; prywatna próba
`4f50176b319c458f87e9f8b6459c85be` korzysta z zachowanego pakietu A
i nowego natywnego pakietu B, port 3258. Przy ostatniej obserwacji
proces weryfikatora PID 87376 i uchwyt 24903 są aktywne. Nie ma jeszcze
terminalnego wyniku tej próby. Kontynuować obserwację tego samego uchwytu;
nie rozpoczynać drugiej próby wskutek samego upływu czasu. Sesji użytkownika
na 3197 nie zatrzymywano. P8-53 i cały plan pozostają otwarte.

### Prywatna próba 4f501 — capture odmówiony, bez restartu

Frontend przeszedł przygotowanie i ogłosił gotowość API
`141988c5-0839-46be-9aed-5be4307c5517`. Sterowanie rozszerzeniem Chrome
przekroczyło limit czasu na `Page.navigate` i `Emulation.setFocusEmulationEnabled`.
Odrębna karta przeglądarki aplikacji działała prawidłowo; nie restartowano
procesu próby z powodu tych timeoutów.

Przez produkcyjne UI utworzono projekt `project-8e053dfdd5734d4386be5d91f14ae938`,
sesję `session-18de3127063b9ea80002219c`, obiekt
`camera-proof-film-mv755onz` (Box 100 × 100 × 10 nm), materiał
`mat:camera-proof-film` (`Ms=800000 A/m`, `Aex=1.3e-11 J/m`, `alpha=0.01`)
oraz region `camera-proof-film-mv755onz:r1` o nazwie `film region`.
Są to faktyczne definicje sceny, potwierdzone w `workspace_browser_before`,
nie tylko tekstowe etykiety draftu. Scene revision 4, po jednym obiekcie,
regionie i materiale. Przed przygotowaniem obiektu odświeżenie Explorera
było potrzebne do pokazania jego podwęzłów; przyczyny nie kwalifikowano.

Przełączono kamerę na orthographic. Receipt przed restartem zapisuje
pozycję `[2e-6,1.4e-6,2e-6]`, target `[0,0,0]`, up `[0,0,1]`, FOV 45,
skalę null. Canvas był widoczny, kontekst niezagubiony, drawing buffer
679 × 281 (następnie 679 × 297). Projekt pozostawał dirty.

Normalny przycisk **Restart backend** zakończył się komunikatem
`Workspace capture failed; no restart was submitted.` Model pozostał
dostępny. Nowa diagnostyka natywnej granicy readiness nie zarejestrowała
błędu w stderr; nie utożsamiamy tego przypadku z wcześniejszym
`readiness_observation_unconfirmed`. Dokładny etap błędu frontendowego
capture pozostaje nieustalony, ponieważ obecny wrapper odrzuca szczegóły.
Nie wykonano restartu ani porównania kamery po restarcie.

Próbę zakończono jej istniejącym, nonce-bound protokołem `cancel`:
terminalny receipt `failed`, exit 1, 19 procesów, wszystkie `waited=true`.
Powód receiptu to `Private browser proof cancelled; collecting terminal custody`;
nie jest to PASS ani diagnoza przyczyny capture. Użytkowego workspace 3197
nie zmieniano. [Screenshot odmowy](53bm-native-capture-refusal.png).

Lokalny następny przyrost rozróżnia stałe, bezpieczne przyczyny capture:
ochrona projektu, pauza workspace, obserwacja kamery, tożsamość i layout.
Nie propaguje arbitralnej treści wyjątków, nie osłabia guardów, nie dodaje
ponawiania. Niepotwierdzony cleanup nadal ma pierwszeństwo przed tymi
komunikatami. Nowa regresja używa konkretnych ownerów i kontrolera dla
pauzy, nieobserwowanej kamery, obcego API i awarii resume; sprawdza brak
POST restartu, zachowanie dokumentu, cleanup i brak wycieku treści błędu.
Jej managed wynik oraz kolejna natywna próba są jeszcze otwarte.

Managed regresja diagnostyki zakończyła się PASS 36/36, exit 0:
`477ccbcbe0e540f5bc9614c3ee0f7ca6`, profil
`windows-control-room-browser-fixture/project-document-handoff-browser`.
Digest źródeł przed i po
`4a66bd74e9d4326735789a87b17b1cd1e5e82108a8c7f7f1e7f3f1ee83275212`,
serwer zakończony, brak błędów strony i konsoli. Jest to dowód konkretnych
ownerów/kontrolera przeciw fixture API, bez natywnego restartu. Aktualna
przyczyna odmowy w 4f501 wymaga ponownej rzeczywistej próby z tymi nowymi
komunikatami, bez wyłączania kontroli spójności ani powtórzenia żądania
o nieznanym wyniku. Testów jednostkowych nie kompilowano.

Scoped lint ownerów/kontrolera: PASS, exit 0,
`4b7dfee40d1a4f76b8098a75a632901b`, profil
`windows-control-room-source-check/development-restart-action-lint`.
Niezależny read-only review trzech plików nie znalazł P0/P1/P2.
Screenshot odmowy ma SHA256
`9ece6a4f798a2fa9e5dec5671f3e85b9ea300310040cd8df369721a50a2b746b`.

Przyrost zapisano i wysłano na `origin/master`:
`48d3893cca7d7f7fdd0b7408051d3955039318ac`
(`fix: identify safe workspace capture refusal boundaries`), pięć własnych
plików. HEAD i origin/master zgodne, staging pusty. Hook React Doctor
wskazał `position.every(...target[index])` bez lokalnego sprawdzenia długości.
Po odczycie kontekstu: false positive, high confidence — oba wektory
przechodzą `validateCameraVector`, która odrzuca długość różną od 3 i zwraca
nową trójelementową krotkę przed porównaniem. Nie dodano suppression ani
nie zmieniono walidacji kamery.

Następny `just windows-workspace-build dev dev 3258 true` jest uruchomiony
jako build-only; uchwyt 40022 oczekuje na istniejącą blokadę ciężkiej pracy
(limit 120s). Przy ostatniej obserwacji jest aktywny; nie ma jeszcze wyniku
ani nowego manifestu. Nie zatrzymywano obcych prac i nie uruchamiano
równoległego wykonawcy. Po terminalnym sukcesie przypiąć nowy manifest,
ponowić prywatną próbę restartu i odczytać nowy komunikat odmowy lub dowód
odtworzenia. Ta diagnostyka nie zamyka bramki P8-53.

Uchwyt 40022 następnie zakończył się terminalnie: recipe exit 2,
`Bounded wait expired before starting`, po 120 sekundach. Nie rozpoczął
kompilacji, nie utworzył nowego snapshotu ani manifestu. Odczyt procesów
potwierdził aktywnego managed FEM GPU build-only z worktree
`fem-script-launch-20261013`, wrapper PID 159104. Nie zatrzymywano tej pracy.
Kolejne żądanie ma sens po potwierdzeniu zwolnienia zasobu, nie po samym
upływie kolejnego timeoutu. W międzyczasie uzupełniono read-only ocenę Z:
o odrębne bramki lokalnego writera sesji, publikacji FMS i volatile TEMP
w [ocenie storage](55-network-storage-assessment-20261013.md).

### Potwierdzenie kandydata po capture — odrębna diagnostyka

Odczyt `DevelopmentRestartActionService.confirmAndStart` wykazał drugi
wrapper odrzucający szczegóły: po udanym capture ownerów ponownie sprawdza
sesję, gotowy pakiet, chroniony host i własność operacji. Dopiero po
potwierdzonym release zwraca teraz stały powód `candidate_confirmation`.
Awaria cleanupu nadal zwraca `cleanupConfirmed=false` i zachowuje
pierwszeństwo komunikatu o niepewnej ochronie. Nie zmieniono kryteriów
tożsamości, czasu ważności proof ani reguł dopuszczania restartu.

Rozszerzono istniejący fixture bannera o zmianę pakietu przy trzecim
odczycie statusu w operacji capture, bez równoczesnej awarii cleanupu.
Scenariusz używa produkcyjnego KernelProvider, ownerów, action service,
kontrolera i typowanego klienta; odpowiedzi HTTP są kontrolowane.
Potwierdza osobny komunikat, null requestId, confirmed cleanup, wznowiony
host, brak nowego POST i brak ponowienia po remount bannera. Następna
jawna próba nadal przechodzi istniejący test niepotwierdzonego cleanupu.

`just verify-development-restart-action-browser`: PASS 13 kontroli, exit 0,
receipt `c00a743dd0d9464f836fe8300837fe52`, profil
`windows-control-room-browser-fixture/development-restart-action-browser`.
Digest przed i po `55cf83e4451475dbdac7de45202567671ccae6b340b6a5f14e1712f734f5fb20`;
serwer terminalny, brak błędów strony/konsoli. Jest to fixture-only,
bez natywnego consumera i bez niepustego dokumentu.
Scoped lint PASS, exit 0, `0c39a4a0de25403ebe26a99dae50f580`.
Przyczyna odmowy rzeczywistej próby 4f501 nadal nie jest potwierdzona:
ten przyrost usuwa lukę diagnostyczną, nie kwalifikuje restartu.

### Pakiet diagnostyki i odmowa produkcyjnego typechecku

Przyrost diagnostyki kandydata zapisano na remote master:
`279b634ea57f0d6383d58793c9e065e58ad45eea`
(`fix: distinguish candidate confirmation capture refusals`). Niezależny
review nie znalazł P0/P1/P2. Managed build-only
`native-build-a491c62a9cb84fa8aaf9d7c0cdbd92aa.log` zakończył się
`completed`, exit 0, `2026-10-13T23:21:49.195357+02:00`.
API/CLI: 1m05s, desktop: 1m10s (fazy Cargo, nie całe przygotowanie).
Manifest SHA256 `3ab4d4ca2feb2a3fee1ab859e70992c8d0838d86c8f6ca65eccd0c252532b0d4`;
API SHA256 `7ebef7b8d249453af53c18aa3a9c3ebad3682716ed05dfd6c4ce73f13e231865`.
Kapsuła `c51d4a7f9fd00d76be469846f3a42040262bb403a14315c260270454cbc8c04a`,
source snapshot `81f4edbc50b611424f0aa6ff2dc17c6c0bae3c51e4da79b7565a242f5c767b0f`,
inventory `4d9a8e59b7d197250d3dd9d2f1b86a59e6a18b1dea4189622099feca4ae3f105`.
Hashy ownerów, kontrolera i action service w kapsule i checkoutcie są zgodne.

Następna prywatna próba `2217069eff234263823106a5d37a1928` zakończyła się
przed otwarciem UI: `Staged frontend typecheck failed`, exit 1 (recipe 2),
17/17 procesów terminalnych. Nie wykonano restartu ani nowej próby capture.
Pełne diagnozy produkcyjnego TypeScript:

- `ComputeEnvironmentSettings.tsx(124,27) TS2322`: przekazanie
  `ComputeEnvironment | null` do panelu wymagającego niepustego odczytu;
- `ExecutionProfilesSettings.tsx(210,92) TS2339`: odwołanie do `kind`
  po wyczerpaniu zamkniętego union distributed/single_process.

W checkoutcie dodano tylko jawny warunek `compute !== null` do gałęzi
szczegółów oraz usunięto niemożliwe odwołanie do `parallelism?.kind`
w końcowej gałęzi; brak konfiguracji nadal jest prezentowany jako Inherit.
Obie linie znajdują się w cudzych nowych, niezacommitowanych sekcjach,
nieobecnych w HEAD. Nie stage'owano całych plików ani nie przypisano sobie
tych implementacji. Nowy snapshot musi zawierać te poprawki; istniejącej
kapsuły nie modyfikowano.

`just check-control-room-production-source`: PASS, exit 0,
`f49b7b793a844873a05e7a0bc9e91a21`, digest przed i po
`83605d27af259a3c64e9144e11f5dfce29c84398a126fdb394c9aaa113d397b9`.
Nie kompilowano testów jednostkowych. Ten dowód usuwa blokadę typów bieżącego
checkoutu, lecz nie zmienia wyniku próby 221706 ani nie potwierdza restartu.

### Kontrola pakietu diagnostyki podczas oczekiwania na slot

Niezależny review dwóch lokalnych poprawek TypeScript zakończył się bez
P0/P1/P2. Wcześniejsze zgłoszenie dotyczące końcowego `parallelism?.kind`
wycofano jako false positive: poprawiona gałąź kończy się `undefined`,
zachowując etykietę Single process dla właściwego wariantu.

`just verify-windows-frozen-development-backend-api` z manifestem
`3ab4d4ca2feb2a3fee1ab859e70992c8d0838d86c8f6ca65eccd0c252532b0d4`
zakończył się niepowodzeniem, exit 1 (recipe 2), receipt
`caab51c039de43a38d93fc3d93c830d2`, po 7 kontrolach. Timeout 10 sekund
wystąpił w końcowym `child.wait` dla własnego API `owner-empty`, po żądaniu
zatrzymania przez weryfikator. Receipt ma 4/5 procesów z `waited=true`;
PID 158332 nie występował już w późniejszym odczycie procesów, ale brak
terminalnego wait w receipt pozostaje luką dowodową. Nie przedstawiać
tej próby jako pełnej regresji API ani jako potwierdzonego błędu restartu.
Nie uruchomiono UI, nie restartowano sesji użytkownika.
Hash weryfikatora `931ebdb1afedab11dd41b63b437f5038ccc44301f86a6ab60c4cacc2c94934ef`.

Główny checkout został w międzyczasie zaktualizowany przez inną pracę do
`7224c257b36ca1ed6dc6c54290ddedbf14caf73d`. Lokalne poprawki TypeScript
pozostają obecne, cudze pliki pozostają poza stagingiem tego zadania.
Po potwierdzeniu zakończenia obcego buildu FEM zlecono nowy
`just windows-workspace-build dev dev 3258 true`. Wynik tego buildu i
rzeczywisty restart z kamerą wymagają odrębnego terminalnego dowodu.

### Kontynuacja 14.10.2026 — utrwalony snapshot i integracja

Checkpoint powyżej zapisano w commicie
`e1ff1a7af12b7077bc6f5f6043fc061ceab4ce35`. Bezpośredni push do master
odmówił fast-forward przez równoległe aktualizacje remote. Commit jest
na `codex/camera-handoff-checkpoint-20261014`, PR
[160](https://github.com/MateuszZelent/fullmag/pull/160): tylko trzy pliki
dokumentacji, bez konfliktów, lecz CI nie pozwala uznać integracji za gotową.
Główny dirty checkout pozostaje na master; nie scalano do niego szerokiej
aktualizacji ani nie zmieniano cudzych plików.

Build `native-build-9a26cabc0ca14011ac32330ca4c90ab7.log` utrwalił snapshot
`acfc1505daeb0eb07850aea7179aeee0c452f95f277d307bf7e1236ab43d5630`.
Fingerprint backendu `ae78a1a5fe3109786cfb6933dc4c6c7fc5be2230b5cdf69e9b8f5c262c2506d2`,
inventory `02f10c90e35bcc5fd417176c66127542c9f10bdc4ece39042e96b14fcd65096f`.
Bezpośredni odczyt obu plików ze snapshotu potwierdza warunek `compute !== null`
oraz końcową gałąź `undefined`, z zachowaną etykietą Single process.
Wersja pakietu `0.1.0-dev.20261013.ge1ff1a7af12b.dirty.s6137d856bd99+9782`.
pnpm odtworzył 771 pakietów z cache, bez pobrań, w 3m 59,5s;
to koszt przygotowania zależności, nie czas kompilacji Cargo.
W chwili tego checkpointu build ma `running`; nie jest to PASS pakietu.

Logi CI PR160 wskazują odrębne problemy w testowanym drzewie merge:

- [generated-api-determinism](https://github.com/MateuszZelent/fullmag/actions/runs/38477816344/job/115572761459)
  oraz [rust-contracts](https://github.com/MateuszZelent/fullmag/actions/runs/38477816344/job/115572760912):
  `E0063`, `crates/fullmag-authoring/src/scene.rs:75`. `SceneDocument::default()`
  nie inicjalizuje `antenna_port_modes`, `antenna_field_solve_stages`,
  `antenna_target_projections`, `solved_antenna_drives`, `antenna_spectrum_requests`.
  Odczyt źródła base `911902d6d545d1471c77290eedef1a1b6937fb62` potwierdza
  deklaracje pięciu wektorów i brak ich inicjalizacji w Default.
- [control-room-contracts](https://github.com/MateuszZelent/fullmag/actions/runs/38477816344/job/115572761308):
  `ERR_PACKAGE_PATH_NOT_EXPORTED` dla `typescript/bin/tsc`,
  `apps/control-room/scripts/typecheck-control-room.mjs:21`. Odczyt tego samego
  base potwierdza odwołanie do nieeksportowanej ścieżki. Nie jest to wynik
  sprawdzenia typów ani dowód naprawienia go przez lokalny f49.

Nie uruchamiano ponownie CI ani kompilacji testów jednostkowych. Diagnozy
nie oznaczają poprawienia źródeł remote; PR i rzeczywisty restart pozostają otwarte.

Niezależny read-only audyt czterech dalszych jobów tego samego workflow
potwierdził następujące granice:

- `python-contracts` (job `115572761655`): dwie odrębne niespójności
  oczekiwań `scripts/test_bootstrap_workflow_contract.py:246,299` względem
  YAML. Test zakłada bezpośrednią kolejność kroku quantity po poprzedniku,
  pomijając dodany krok session reachability, oraz równość liczby wystąpień
  checkout@v7 z krokami nazwanymi Checkout (`6 != 5`). Nie naprawiono testu.
- `checkpoint-windows-contracts` (job `115572761660`) oraz
  `fdm-relaxation-qualification` (job `115572761217`): wspólny E0063
  zatrzymuje kompilację. Walidator Python relaksacji ma 16 PASS, lecz test
  Rust nie wystartował. Nie wnioskować z tego o błędzie fizyki relaksacji.
- `browser-fixture-smoke` (job `115572761782`): build TypeScript kończy się
  przed próbą aplikacji. Pierwsze błędy dotyczą `BufferSource` w
  `fdmRegionMembershipCodec.ts:482` i `BlobPart` w
  `ProjectDocumentController.ts:938`. Dalej są niespójne fixture'y scope
  oraz brak symboli AST (`createSourceFile`, `Node`, `SyntaxKind`) w użytej
  wersji TypeScript. Base ma 7.0.2, a HEAD dokumentacyjnego PR ma 5.8.3;
  lokalny typecheck f49 nie kwalifikuje tego nowego toolchainu.

To diagnoza logów i źródeł, bez ponowienia jobów i bez zmian zależności.
Nie zmienia wyniku ani zakresu natywnego pakietu z snapshotu acfc.

### Pakiet 94fc, desynchronizacja typów i blokada writera fixture

Build acfc zakończył się `completed`, exit 0. Manifest
`94fc81b9c323e28f93fa8549bea299ad5c380075a07714d1e71cb0fecd09d45f`,
API `deac8a4a07a5ec128d4cd53d775ce9a4a750b34f6d1c958a1e865d3e1724a7b3`,
CLI `8799d7b22531eef75d342dff57d8b8da628977266a59a39d6c290749c5207a83`,
desktop `09f17b743276933323bc9bc15613d484747085717d3ce43fa8cd79773cc8c0ce`.
Source snapshot `6137d856bd9995b4b75cf6a41d4ead7bade7b090198ba26110df6a97897a627b`.
Fazy Cargo: API/CLI 4m 28s, desktop 1m 30s; to nie cały koszt przygotowania.

Próba browser `57e2b855f74948a9bf510fb5f3ca326b`: failed przed UI,
18/18 procesów odebranych. Nowa diagnoza:
`computeNodeInventory.ts(382,40) TS2339`, brak `node_policy` w wygenerowanym
typie odpowiedzi. Poprzednie dwie poprawki były obecne w snapshocie.
Wynik nie obejmuje capture ani restartu.

Pełna bramka API `9467e0693243475491737c29e57b778e` wykonała 290 kontroli,
po czym zakończyła się failed przez WinError 10054. Wszystkie 97 procesów
ma waited=true. Przyczyna źródłowa w `preparation.stderr.log`:
`preparation resource lease file name must end in .json`.
Fixture publikował lease przez Python `atomic_json` bez natywnej blokady;
scheduler mógł zobaczyć tymczasowy `.<name>.<uuid>.tmp`. Nie jest to dowód
naprawienia lub awarii fizyki ani PASS całej bramki.

Poprawiono tylko publikację własnych fixture w weryfikatorze: istniejący
`WRITER.lock`, `r+b`, bounded retry, 1 bajt od offsetu 0; odczyt dokładnego
deskryptora `fullmag.writer.lock.v1\n`. `mkdir` i zapisy active/released są
pod blokadą, release następuje przed zapytaniem `drain_idle_confirmed`.
Nie tworzono ani nie naprawiano deskryptora i nie zmieniono walidatora Rust.
Review potwierdził, że legacy scheduler i idle fence skanują lease'y pod
`write_transaction()`; nie znalazł P0/P1/P2 w poprawce i jej regresjach.

`just verify-windows-development-handoff`: PASS, exit 0, 186 kontroli,
receipt `900fb3ed7e7e4659b95a51210d70c635`. Fingerprint before/after
`78d8bb0cf05b61ea73302cc76a3af343e431bbc62d4595c3a89304542da3a8dc`.
Pięć nowych kontroli używa rzeczywistych Windows locks i sprawdza blokadę
podczas publikacji, oczekiwanie na konkurenta, cleanup po błędzie,
odmowę brakującego/niepoprawnego deskryptora i ścieżki spoza własnego store.
Nie kompilowano testów natywnych. Pełna bramka API po poprawce zakończyła
się PASS: receipt `ee9dc8ae88c840b09716322aba936a9c`, exit 0,
301 kontroli i 98/98 procesów z waited=true (0 nieodebranych).
Wynik dotyczy zamrożonego pakietu 94fc i poprawionego weryfikatora;
nie zastępuje dowodu odtworzenia kamery w rzeczywistej przeglądarce.

Odrębna bramka `verify-windows-project-document-frozen` na 94fc: PASS,
33 kontrole, 6/6 procesów odebranych, receipt
`26329c681a074c8294d2a1685d1d90ce`. Kanoniczny eksport OpenAPI exit 0,
SHA256 `75f4aba5570a6edc7955cd651d839d77b381721f2d17c7d71240d22289770687`.
Zakres runtime-free archive i eksportu nie zastępuje pełnego service gate.

Importowano kontrakt przez `generate-openapi-v2.mjs --input --native-receipt`,
z jawnym e1ff i snapshotem 6137, bez Cargo fallbacku. Poprzednie cztery
artefakty zachowano w `contracts-before-sync` pod receipt 26329.
Nie zmieniono zestawu endpointów; różnice schematów dotyczą
ComputeNodeResource/ComputeNodePolicyResource. `just generate-control-room-client`
PASS (`adbccec0f42745918811aa2094077c20`). `node_policy` jest teraz
optional/nullable w wygenerowanym typie. Artefakty pozostają częścią
cudzej niezacommitowanej implementacji; nie stage'owano całych tych plików.

Production typecheck PASS, exit 0, `13d3c33c7a3643ec8f9b3719e05a04c8`,
before/after `7160cc932c63c402d90b5472cc6dd80562501fed7c27e7145c209544946f49cf`.
Nie zmienia to wyniku próby 57e2 ani nie kwalifikuje TypeScript 7 z remote.
Nowy snapshot frontendu i rzeczywiste odtworzenie kamery nadal są wymagane.

### Kolejny pakiet z synchronizowanym frontendem

`just windows-workspace-build dev dev 3258 auto` zakończył się exit 0.
Log: `native-build-7fa6330d12054c53a66c3efdaa1aa91c.log` w profilu
`windows-native-fdm-cpu-dev`. Manifest SHA256
`cd7fe207b6bc615ddc4e4b0fd7c07ba90c724ed199d0c5aff410996dd8c7be3f`.
Kopia źródeł `e89a8bd16bc6dc3a571f5de9d5fa19a8aa4a5c9678ba96292af080d276b689a1`
zawiera optional/nullable `node_policy` w typach wygenerowanych.
Tożsamość źródeł `bd1ad70a52633a30e1ab2bb89f7db2dcd51c878e606695606dcc41f5912e1400`,
backend `64b1cff84bd247a20ea3a831bedf057d6a2642e91049307e2aae88b2ad4f5184`.
EXE API `fd4a83bde75610f41abf2f5126e6ae022058d59c3b6d71ffde8710ac88b5332f`,
CLI `ff286708557fccb0bd692a05acb97183982f2b7f26f7d2cb8c123f8338cc4fbc`,
desktop `1255b7bb9112090cc68219fda7b538ccf2f078b532ba05606e5f5d05ff5d1ba0`.
`source_identity_check=passed`. Cargo API/CLI 59.48 s, desktop 1 min;
przygotowanie źródeł i publikacja są odrębnymi kosztami. pnpm ponownie
użył 771 pakietów, 0 pobranych, 49.8 s.

Uruchomiono prywatny browser gate z bazowym owner bundle
`12984ba740244e5e86d8878814069155`. Sukces buildu nie zamyka P8-53BM:
wynik odtworzenia modelu i kamery po restarcie pozostaje do potwierdzenia.

Próba `14152bbfe6a44c23a485176a4c0ff127` dotarła do rzeczywistego UI:
1 obiekt, 1 region, 1 materiał, dirty document revision 2. Restart przez
normalny przycisk, następnie Check restart, zmienił API instance
`9e748fd2-c2f2-4f5f-878d-40149e15092e` na
`9c0b447e-fd00-45f4-b334-f1bafd3dd955`; stary API exit 0.
Nowy workspace zachował hash archiwum
`a883afeee8f8dab12ec46b6b9b4f743f8c0d5f355920fc6e3e656f406efa3393`,
dirty flag oraz authored scene hash
`1fe9c88901466a2490c24995ca9d2030352155d6d027d53a1cad92214ec9a2f6`.
Canvas po odtworzeniu: 700×297, context_lost=false.

Uzupełniający odczyt `/visualization/state` z nowego API, z kontrolą
response pin, porównał sześć pól kamery: projection, position, target,
up, fov_degrees, orthographic_scale. Wszystkie identyczne, projection
orthographic, scale null. Odczyt zapisano jako `camera-observation.json`
pod receipt tej próby; nie jest to zamiennik pełnego browser gate.
[Obraz odtworzonego workspace](evidence/53bm-camera-preserved-partial-20261014.png).

Normalny Build Grid odmówił: obiekt nie miał `magnetization_ref`.
Command log: `Object 'camera-proof-film-mv7bu6go' must reference a
magnetization asset before mesh/compute.` Jest to brak wejścia mojego
modelu kontrolnego. Próba została anulowana przez prywatny, uwierzytelniony
protokół: failed exit 1, 24/24 procesów odebranych i frontend waited=true.
Nie zaliczono Grid/Compute ani całego P8-53BM.

Korekta wejścia następnej próby: jeszcze **przed Setup draft i restartem**
w Inspectorze obiektu Magnetic Texture utworzyć oraz przypisać Uniform
texture, zatwierdzić Save Texture/Apply i odczytać niepusty
`magnetization_ref` z committed scene. Dopiero wtedy przechwycić scenę,
dirty document i kamerę. Bieżący `ObjectMagneticTexturePanel.tsx` posiada
`saveTexture()`, które buduje asset i zatwierdza transakcję authoring;
`scene_after_successful_grid()` pozwala tylko usunąć tag mesh:dirty,
więc dodawanie magnetyzacji dopiero po restarcie nie spełni bramki.
Nie zmieniać walidatora ani oczekiwanych hashów, by akceptowały poprzednie
niekompletne wejście. Ponowna próba używa tego samego poprawnie zbudowanego
pakietu, lecz nowego, kompletnego modelu wejściowego.

### Próba z assetem Uniform: kolejka oraz timing punktu before

Próba `40e080f9a0af4c3d9e1cfb47f4de5f32` używa pakietu cd7fe207.
Przed capture odczyt zatwierdzonej sceny z kontrolą response pin potwierdził
`material_ref=mat:complete-proof-film` oraz
`magnetization_ref=mag:complete-proof-film-mv7cagtf:uniform`; odpowiadający
asset ma kind=preset_texture. Utworzono również authored region.
Restart zmienił API instance z `c1d7dde5-0a5d-4fa8-b029-53be97d9d5bb`
na `d28d631b-02a3-4536-a504-a7685d3446a7`, stary API exit 0;
nowy API zachował to samo przypisanie magnetyzacji, model i dirty document.

Normalny Build Grid został przyjęty do kolejki: command
`fm-6f9ffaa7-e555-4d4f-835c-34819bf6cc0d`, kind=fdm_grid_refresh,
seq=1, status=queued, created_at_unix_ms=1791935937616.
Odczyt szczegółów z przypiętego nowego API nadal pokazuje
started_at_unix_ms=null i completed_at_unix_ms=null; nie wysłano duplikatu.
Po utrwaleniu obserwacji próbę anulowano kontrolowanym protokołem:
failed exit 1, 24/24 procesów odebranych i frontend waited=true.
Native cleanup result także ma status=failed; nie oznaczono go PASS.
Diagnoza wykonawcy po restore trwa na zachowanych źródłach i logach.
[Obserwacja UI](evidence/53bm-grid-queued-after-restore-20261014.png).

Ten punkt before zapisał perspective, a odczyt po restore orthographic.
Zmianę projekcji i Setup draft wykonano bez oczekiwania na ACK; domyślny
idle flush w CameraRegistryController to 8000 ms. Produkcyjny capture
w DevelopmentKernelOwners wymaga czystego, zaobserwowanego registry,
natomiast diagnostyczny capture_before czyta API bez takiej bramki.
To wspiera hipotezę wyścigu punktu pomiaru; nie dowodzi nowego błędu
odtworzenia kamery. `pending-observation.json` pod receipt zachowuje oba
odczyty i kolejkę. Porównania ani receipt nie zmieniono dla uzyskania PASS.

WIP strony diagnostycznej: `assertConfirmedCameraForCapture` odmawia przy
dirty/syncInFlight/error, braku remote revision/camera lub różnicy między
camera i remoteCamera. Wywołania przed przygotowaniem oraz przed claim
zapobiegają utrwaleniu punktu before podczas oczekiwania na zapis.
Diff check PASS; staged-page typecheck/lint i rzeczywista regresja
toggle→odmowa Setup draft→potwierdzony zapis→ponowne Setup draft pozostają
NOT VERIFIED. Cały P8-53BM/P8-53 nadal IN PROGRESS.

### Przyczyna kolejki: potwierdzona niekompletna fizyka jako HTTP 500

Po terminalnym zamknięciu próby 40e08 log `native.stderr.log` zachował:
`model sync returned HTTP 500 Internal Server Error; helper shutdown is not confirmed`.
Scratch supervisor uruchamia sync przed solverem; na takim wyniku przechodzi
w synchronization_unknown i nie odtwarza write automatycznie.
Nowy scratch observer jest uruchamiany w CLI development_restart.rs;
queued Grid nie dowodzi braku przepięcia obserwatora ani błędu plannera.

Diagnostyka bez API POST, zapisu i solvera: renderer z zainstalowanego
zamrożonego pakietu cd7fe207 otrzymał dokładną captured scene z receipt.
Zgłosił `IncompletePhysicsError: Problem requires at least one interaction
or material anisotropy`. Study miał exchange_enabled=false,
demag_enabled=false i brak object physics_stack. Sam asset Uniform
i materiał nie aktywują modułów fizyki. To potwierdzona przyczyna błędu
renderowania; nie zmienia wymagań fizyki ani dowodów scientific qualification.

WIP poprawki: wejście CLI helpera przechwytuje wyłącznie typed
IncompletePhysicsError dla render-scene-document, emituje dwupolowy
`fullmag.scene-render-rejection.v1` / incomplete_physics i exit 2 przed
publikacją źródła. Direct helper.main/renderer oraz --allow-incomplete
zachowują dotychczasową semantykę. API uznaje za znaną odmowę tylko
dokładny exit 2 i envelope o dokładnie dwóch polach; zwraca HTTP 400,
code=scene_incomplete_physics. Unknown/malformed/timeout nadal 500.
Scratch klient odczytuje ograniczone body wyłącznie HTTP 400 i dla tego
kodu pokazuje stały komunikat o aktywacji interakcji/anizotropii;
pozostałe 4xx/5xx zachowują poprzednią klasyfikację.

Regresja red `b85bbc5fd93148cfbc0422322cbac854`: 189 kontroli, 3 błędy
wyłącznie brakującego _run_cli. Green po poprawce
`bf7a73ec129b490eb6d7de045d2529d4`: 189 PASS, exit 0, 0 skips;
before/after `115c0e96e8ee0ca4e1d2ffcd8720518bf9319b2638c7b9eb94f8684a17f6f76a`.
Pokrycie: zachowanie istniejącego pliku przy typed odmowie, brak połknięcia
nieznanego ValueError i niekompletna persistence z written=false.
Review podstawowego mapowania i guardu kamery: brak P0/P1, source only.

Dodano dwa native API assertions: odmowa 400/code oraz niezmieniona scena
i rewizja. Są NOT RUN do nowego buildu; nie kompilowano testów jednostkowych.
Nowy managed build z dirty snapshotem jest w toku, log
`native-build-996985fbff454e83847b2c2f88eed31e.log`.
Kolejne wymagane dowody: kompilacja API/CLI, kanoniczny OpenAPI/client,
frozen native API gate, regresja guardu kamery oraz pełny browser restart
z jawnie aktywną fizyką przed capture. Nie oznaczono poprawki ani P8-53BM
jako ukończonych na podstawie samego green Pythona.

### Ukończony build poprawki — 14.10.2026

Managed `just windows-workspace-build dev dev 3258 auto` zakończył się
exit 0. Zbudowano produkcyjne API, CLI i desktop w profilu backend-dev;
nie kompilowano testów jednostkowych. Manifest pakietu:
`1bcaf4c15c4acf4a813d172021c9b00c5ffdbe84ad7c2d8a2c16b41efdd10d0e`.
Commit bazowy `99d6be2f97976f5392b419f2ecd03b70b4fdaac1`, dirty source
`9f2473863cf9959f3cb163a9456398b53a4c126fda2d6a921e4751f0f3bcb9f1`,
backend `a79bc49d271115f57bbdee8c72f40dbcc452623888a954b54a78aa236cb7d46e`.
Log: `native-build-996985fbff454e83847b2c2f88eed31e.log`.

Przypięta do manifestu frozen API gate zakończyła się exit 0:
**303 PASS, 99/99 procesów odebranych**, receipt
`a6c4edb5665f46709d61fa5b535fd3d9`. Nowe kontrole
`incomplete-physics-render-is-confirmed-input-rejection` oraz
`incomplete-physics-render-preserves-scene-and-revision` potwierdzają
HTTP 400/code i brak zmiany sceny/revision. Końcowy backend source pozostał
`a79bc49d271115f57bbdee8c72f40dbcc452623888a954b54a78aa236cb7d46e`.
Kanoniczny OpenAPI SHA-256:
`54c16a8be054a9eadeb034dc40f023e72e72e8249f6d25f3ce85a82482d9acdf`.
Import przypięty do terminalnego receipt oraz generate-client PASS,
receipt `9d12898d331f4be9a0218bcf070e6018`.
Istniejące cudze wygenerowane pliki zachowano przed importem w
`contracts-before-sync` pod receipt API; do commita zadania wolno włączyć
wyłącznie własne hunki odpowiedzi 400.

Te dowody nie potwierdzają jeszcze terminalnej obsługi Grid przez scratch
po odmowie ani pełnego Grid/Compute po restarcie. Regresja kamery i pełna
próba przeglądarkowa pozostają NOT VERIFIED; P8-53BM nadal IN PROGRESS.

### Regresja capture kamery i jawna odmowa Grid — 14.10.2026

Prywatna próba `a7e054cc1fb44299b8caf33a59877b11` użyła pakietu
`1bcaf4c15c4acf4a813d172021c9b00c5ffdbe84ad7c2d8a2c16b41efdd10d0e`.
Staged diagnostyczna strona przeszła typecheck i lint, oba exit 0.
Normalnymi kontrolkami UI utworzono box `film-mv7ehc2v`, region
`film-mv7ehc2v:r1`, materiał `mat:proof-film`, Uniform texture
`mag:film-mv7ehc2v:uniform`, jawną anizotropię Ku1=1000 J/m³ z osią
[0,0,1] oraz Run `run-1` do 1e-12 s. Wszystko przygotowano przed capture.

Regresja guardu: View → toggle projection i natychmiast Setup draft
zwróciły `Wait for camera synchronization before preparing the
before-capture. No before-capture was submitted.`. Po potwierdzonym
odczycie camera.projection=orthographic z przypiętego API ponowne
Setup draft utrwaliło punkt before. [Dowód odmowy](evidence/53bm-camera-capture-refused-20261014.png).

Restart zmienił API `d5a6b8f0-1725-4cd2-b28f-7dc375c9fe5c` na
`07e9ad04-190f-49f1-baa2-bb56fbd471a0`; stary API zakończył się exit 0.
Dirty document zachował revision=2 i archive SHA-256
`b0e09ad307e0fb81c72ce2e323868e79eac2e5318907b648f2cba9504ebdac04`.
Odczyt nowego API oraz before z terminalnego receipt mają identyczne
projection, position, target, up, fov_degrees i orthographic_scale.
Viewport po restore: 700×297, context_lost=false.

Build Grid `fm-00ef8ee5-d09b-4017-9833-acd1218f4f36` doszedł do nowego
scratch wykonawcy i zakończył się status=failed, pending_count=0.
Log materializacji wskazuje: `FDM discretization hints (cell size) are
required for Phase 1 execution`. To kolejna brakująca właściwość wejścia
kontrolnego: w Study nie ustawiono rozmiaru komórki przed capture.
Modal nadal pokazywał submitting mimo terminalnej odmowy w katalogu
komend; wymaga to odrębnego sprawdzenia obsługi terminalnego failure.
Nie wysłano duplikatu Grid i nie zmiękczono porównania sceny.

Odczyty kamery, sceny i komend zapisano osobno jako
`camera-and-grid-observation.json` pod receipt. Próba została świadomie
anulowana: terminalny failed/exit 1, 25/25 procesów waited=true.
Nie uznano jej za PASS całej bramki. [Stan po restore](evidence/53bm-camera-preserved-grid-cell-refusal-20261014.png).

Guard capture kamery ma dowód negatywny i pozytywny z rzeczywistego UI.
Pełne P8-53BM/P8-53 pozostaje IN PROGRESS: kolejna próba musi ustawić
FDM default cell (np. 5e-9 m dla tego małego boxu), jawne Ku1, Uniform
oraz skończony Run przed capture, a następnie wykonać Grid/Compute/Close
i Finish proof. Wynik tego małego scenariusza nie kwalifikuje naukowo
pozostałych lane ani wydania.

### Pełna bramka Windows/FDM CPU — PASS 14.10.2026

Receipt `2998926363e84fd5b32569767c9a44b0`: completed, exit 0,
10 kontroli i 27/27 procesów waited=true. Pakiet B to manifest
`1bcaf4c15c4acf4a813d172021c9b00c5ffdbe84ad7c2d8a2c16b41efdd10d0e`;
backend source before/after identyczny:
`a79bc49d271115f57bbdee8c72f40dbcc452623888a954b54a78aa236cb7d46e`.
Nie ponawiano kompilacji ani nie zmieniono weryfikatora, aby uzyskać PASS.

Model przed capture zawierał jawne default_cell=[5e-9,5e-9,5e-9] m,
Ku1=1000 J/m³, Uniform +X i Run do 1e-12 s. Dane API zapisano jako
`pre-capture-authoring-input.json` pod receipt. Kontrolka Apply Grid
wykonała też Grid w starym API przed capture; ten sukces nie zastąpił
wymaganej nowej komendy Grid po restarcie.

API zmieniło się z `1fc80b0b-e160-46e4-a511-0c2127127402` na
`7648c98c-cfc5-4e28-96ac-afd867748001`, z nową sesją i request scope.
Scena before/after ma hash dowodu
`5c28a2a69063f2720bd1e4cadd00f848903e707e11da967d45c5c6da319246cf`.
Dirty document zachował revision=2 i archive SHA-256
`1effe614c3cb7ccb42c38e636418a3abec654d1a8c53bb570bb33f182fe91c39`.
Kamera before/after: orthographic, position=[2e-6,1.4e-6,2e-6],
target=[0,0,0], up=[0,0,1], fov_degrees=45, orthographic_scale=null.
Receipt `workspace_browser_camera.preserved=true` porównuje sześć pól.
Canvas po restore/Compute pozostał 700×297, context_lost=false.

Nowy Grid `fm-1325a9f8-a33e-449a-884e-0ff826ad790b` oraz Compute
`fm-eae55ced-5114-4289-88ff-190a7ccf0fcd` zakończyły się completed.
Compute: etap stage-000, completed_step=10, total_stages=1.
Oba dzieci zakończone exit 0, kill_requested=false. Requested/resolved:
fdm/cpu/double/strict; runtime_family=cpu-reference,
engine_id=fdm_cpu_reference. Nie przedstawiać tego jako wykonania GPU
ani przyszłego compiled-native FDM CPU.

Normalne Close `fm-b7b0e542-9b15-47b2-9f6b-119708c31f0f` zakończyło
solver i opublikowało tombstone sesji; Finish proof zweryfikował ten
przepływ oraz niezmieniony dokument. Nie zamykano workspace3197.
[Dowód UI po Grid/Compute/Close](evidence/53bm-camera-grid-compute-completed-20261014.png).

Niezależnie potwierdzono problem prezentacji: modal Grid pozostał
submitting mimo status=completed z listy i szczegółu tej samej komendy.
Read-only diagnoza: grid.build-fdm gubi confirmation.requestId
(`mesh-confirm-*`), a runFdmGridRefreshOperation generuje inne
`fdm-grid-refresh-*`. Reducer modalu odrzuca niepasujące eventy.
Wymagana jest osobna korekta korelacji oraz browser proof modalu;
PASS natywnej bramki kamery nie dowodzi naprawy tego UI.
