# P8-53AE — zakończenie cold handoffu przez nowe API

Data: 04.10.2026. Zakres: natywny Windows dev, prywatny kanał ownera.
P8-53 i cały plan pozostają w realizacji.

## Zachowanie

Nowe API przyjmuje `complete_cold` wyłącznie w aktualnym przejęciu ownera.
Sprawdza przypięte raw commit/snapshot/manifest, target i rzeczywisty binding
accepted store. Wymaga wykonania z dokładnego sealed candidate EXE, zgodności
z własnym buildem i prywatnego dowodu prelisten restore. Owner musi wcześniej
odebrać własny proces starego API; same pliki nie dowodzą jego zakończenia.

Kanoniczny loader kapsuły waliduje assets oraz porównuje scenę po rebazowaniu
ich ścieżek z rzeczywistą sceną trzymaną przez guard nowego API. Oryginalna scena
snapshotu pozostaje osobno sprawdzana; kontrola nie pomija ścieżek ani innych pól.
Review wykryło, że wcześniejsze porównanie do surowego snapshotu odrzucałoby
poprawne odtworzenie sceny z plikami. Regresja obejmuje taki przypadek.

Przed prepare/finish dziennika completion API utrwala zamknięcie admission
i zachowuje freeze oraz transition guard. Po potwierdzonym finish zwalnia
freeze przed wysłaniem ACK; błąd po uzbrojeniu pozostawia admission zamknięte.
Nie uruchamia shutdown nowego API. Historia zapisuje nowy session ID/epoch 1
albo jawny null/epoch 0 dla pustego workspace. Zastane uszkodzone zapisy nadal
blokują admission.

## Weryfikacja

`just windows-workspace-build dev dev 3197 auto`: produkcyjne EXE, exit 0.
Log `windows-native-fdm-cpu-dev/windows-runtime/live-completion-build.log`.
Nie kompilowano testów jednostkowych.

`just verify-windows-development-handoff`: **124 kontrole, exit 0**, bez skip.
Receipt `development-handoff-checks/checks/bea668595539487e9bdb9bcd44a437be/receipt.json`.
Source SHA-256: `88c22aec34c2210b3cc267ca7dcca73d592b2bfef615db93a08d59db9cec989f`.

`just verify-windows-development-backend-api`: **215 kontroli, exit 0**.
Receipt `development-backend-api-checks/checks/906e572bec674dfa85e256555facfa38/receipt.json`.
Backend source SHA-256: `156ccb71e0ccb3578de57f2d963e8e5db4fc4c93febbe4103424eea7424abca2`;
build snapshot: `8285d3e59412e1503cb213a1f097a79640bbd12494406f0aa47b712a17438926`;
tożsamość źródeł przed i po sondzie zgodna. Ścieżki receipt i logów są względem
`storage/builds/fullmag-0950f4dca4ffe38f`.

Sonda użyła własnych scoped accepted stores i procesów. W obu wariantach,
zwykłym ACK i lost-ACK starego API, odtworzyła scenę z jednowęzłowym OVF.
Ścieżki oryginalnego i odtworzonego zasobu różnią się, bajty są identyczne.
Cztery błędne piny completion zostały jawnie odrzucone bez zmiany commit/fence
i bez pending. Poprawny completion zapisał dokładną historię, usunął active
markers i dopuścił przypiętą mutację HTTP PUT sceny. ACK scene SHA-256 zgadza
się z wcześniejszym prywatnym przejęciem nowego API. Kapsuła pozostała `staged`.

Wszystkie 60 zarejestrowanych procesów odebrano (`waited=true`). Dwa nowe API
zostały zatrzymane przez sondę po zakończeniu własnej próby, exit 1 jest wynikiem
tego cleanup, nie dowodem graceful shutdown nowego API. Stare owned API miały
potwierdzony graceful exit. Nie zlecono Compute. UI użytkownika zachowano;
końcowy odczyt `http://localhost:3197/workspace` zwrócił HTTP 200.
Review poprawki nie wykazało kolejnych problemów produkcyjnych.

## Pozostały zakres

Produkcyjny koordynator launchera, powtórny rzeczywisty restart tego samego
workspace, warm service/drain, przyjęcie Compute i hydration UI ze szkicami
Inspectora pozostają otwarte. Live completion pustej kapsuły oraz Windows
power-loss pozostają NOT VERIFIED. `restart_available` pozostaje `false`.
Ta bramka nie zamyka P8-C ani kwalifikacji solverów lub wydania.
