# P8-53K — instalacja authoring przed listenerem API

Data: 03.10.2026. Etap kontrolowanego restartu z ADR 0050.

## Zmiana

Nowy prywatny konstruktor otrzymuje pełny kanoniczny `SceneDocument`, a nie
projekcję ScriptBuilder. Zachowuje model ID i rewizję oraz tworzy nową sesję
authoring. Requested backend/device/precision/mode/threads pozostają zgodne
ze sceną. Poprzednie resolved execution, run, preparation, siatka, pola i wyniki
nie są przenoszone do nowego procesu. Niekompletny model z legalnym szkicem
geometrii pozostaje edytowalny; restore nie wymaga gotowości solvera.

Startup API wywołuje prywatny konsument przed budową routera i związaniem
listenera. Wyłącznie jawne `FULLMAG_DEVELOPMENT_RESTORE_STDIN=1` w konfiguracji
managed development włącza odczyt odziedziczonego stdin. Zwykły start nie czyta
stdin. Dokument musi mieć schemat `fullmag.development-prelisten-restore.v1`,
target build ID i target source SHA256 zgodne z konfiguracją procesu,
`old_session_id` oraz `scene_document`. Limit to 64 MiB i 10 sekund; niepoprawne,
niekompletne albo obce dane kończą startup przed udostępnieniem API.

Konsument wymaga świeżego stanu API, instaluje scenę i podnosi epoch do 1.
Nowy API UUID nadal powstaje w zwykłym startupie. Nie zapisuje terminalnego
receipt `restored` przed listenerem.

## Granica zaufania i pozostała integracja

Ten prywatny stdin jest kanałem zaufanego launchera, nie publicznym importem
ani endpointem HTTP. Zgodność targetu nie jest uwierzytelnieniem kapsuły.
Manager musi wywołać `load_scene_handoff` i zweryfikować pełny source binding,
receipt oraz assety przed przekazaniem sceny. Samodzielne przekazanie JSON
nie jest dowodem integralności kapsuły i nie kwalifikuje restartu produktu.

Osobne payloady `editor`, `workspace`, `project_document` kapsuły wymagają
konsumentów UI. Pole `SceneDocument.editor` jest zachowane, ale nie zastępuje
tych odrębnych payloadów. Guard ponownego restartu musi otrzymać jawny marker
zaufanego restored-authoring; nie wolno szeroko poluzować wymagania tożsamości
zwykłego scratch. Globalna kontrola accepted work, potwierdzony drain,
przekazanie ownera, nowy browser pin i końcowy receipt pozostają otwarte.
`restart_available` pozostaje false.

## Weryfikacja

Produkcja Windows, `just windows-workspace-build dev dev 3197 auto`: exit 0,
20:36:12–20:37:44 UTC. Source identity passed. Snapshot:
`2e7add08c66a7a4e370bc7255a929f77e0d799d84b388c85371da7ad6cd55501`.
Backend SHA256:
`76329bc2c34e7c00dbb7be3da63fc27ac61278e12c1d26f19146880ef287b0ec`.
Wcześniejszą kompilację odrzucono przez kontrolę zmiany źródeł podczas buildu;
nie jest ona pozytywnym dowodem.

`just verify-windows-development-backend-api`: exit 0, **43 checks**, receipt
`0056e64334794f3b8d042af06dcaec25`, profil `development-backend-api-checks`.
Backend digest przed i po pozostaje taki sam jak wyżej. Verified build ID:
`b0a2c68e1e528cb30b6982d5179f547bb3645be9fe6fe66ba3a2404ba1b2172c`.
Verifier SHA256:
`c185852eee51c9cd66a01d39f48bd2adbf8ed9d1f77d41346358fb4b96b74738`.

Pierwszy odczyt osobnego nowego API potwierdził model ID i revision 17,
niepusty box, wybór obiektu i gizmo, auto/GPU/single/extended/3 threads oraz
nową sesję i request scope epoch 1. Run i preparation nie istniały. Rzeczywisty
PUT sceny zmienił nazwę i revision do 18: restore pozostał edytowalny.
Nonmanaged, obcy target, niepoprawna scena, puste wejście, niezamknięty pipe
przekraczający 10 s oraz wejście przekraczające 64 MiB zakończyły proces
kodem 101 bez dostępnego listenera. Fixture nie restartował sesji użytkownika.

Wszystkie 11 własnych procesów zostały waitowane: 6 odmów startupu exit 101,
4 API zakończone przez verifier exit 1 po obserwacjach, pusty resident service
po potwierdzonym drain exit 0. Nie było wykonania solve ani kwalifikacji GPU.
Pierwszy przebieg fixture (`9331065445284432b440c4bb0b7089ab`) zatrzymał się
na oczekiwanym HTTP 404; poprawiono obsługę tego wyjątku w sprawdzaczu.

Scoped rustfmt i Python AST parser: PASS. Source regression tests Rust
pozostają NOT COMPILED / NOT RUN zgodnie z zakazem użytkownika. Nie przeprowadzono
pełnego przebiegu manager–capsule–restart–browser, więc P8-53 nadal pozostaje otwarty.

## Review

Niezależny bounded review wskazał dwa błędy, poprawione przed końcowym buildem:
`explicit_selection` uwzględnia teraz cały predykat kanonicznego adaptera
(backend/device/precision/mode/threads), a brak adaptera jest dopuszczalny tylko
przy unresolved solve prerequisites. Inny błąd projekcji odrzuca restore.
Review tych poprawek nie znalazł kolejnego blokera w zakresie tego przyrostu.
Nie rozszerza to dowodu na cały restart ani kwalifikację produktu.