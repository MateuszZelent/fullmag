# P8-53Y — ponowny odczyt kapsuły przed zatwierdzeniem restartu

## Zachowanie

Launcher przechowuje prywatnie ścieżkę kandydata i oryginalne dane frontendowe
przejęcia. Ponowna kontrola wymaga tego samego nonce i UUID API, potwierdza
guard przed odczytem i po nim oraz unieważnia połączenie po każdym błędzie.
Nie przyjmuje nowej ścieżki pakietu ani payloadu UI podczas tej kontroli.

Prywatny helper ponownie odczytuje kapsułę i weryfikuje pakiet kandydata.
Porównuje binding ze źródłem ownera i oryginalnym przejęciem, a zapisany model
i szkice z przejętymi danymi. Wymaga dokładnego hash kapsuły oraz nadal
oczekującego receipt. Zwraca wyłącznie ten sam mały ACK w stanie `staged`.
Token ownera nie trafia do helpera ani frontendu.

Kontrola nie tworzy nowej kapsuły, nie ustawia `restored`, nie zwalnia fence
i nie zatwierdza shutdown. Jest częścią przygotowania przyszłego atomowego
commit; potrzebne są nadal aktualny guard i pełny dowód globalnego idle.

## Weryfikacja

`just verify-windows-development-handoff`: **110 kontroli**, exit 0, bez
skipów. Receipt `development-handoff-checks/checks/59c177c15e1f40d78bb74588855b8cf9/receipt.json`;
digest źródeł przed/po
`7af346ae04f08ab65574854598f44f766a3099d59a1199ebb5c8733dc0f4df50`.
Obejmuje odczyt pustej kapsuły i modelu, obcy nonce/binding, zmianę oryginalnej
sceny lub szkiców między odczytami, zmieniony snapshot/kandydata i terminalny
receipt. Konsument stdin odrzuca błędny nonce bez ujawniania payloadu.

Zarządzany natywny build dev zakończył się exit 0. Pierwsza równoległa próba
builda została odrzucona przez blokadę storage podczas kontroli interpretowanej;
build uruchomiono po jej zakończeniu, bez zmiany targetu i bez obejścia blokady.

`just verify-windows-development-backend-api`: **113 kontroli**, exit 0,
**26 procesów** z potwierdzonym wait. Receipt
`development-backend-api-checks/checks/66baef6f9ef04f01a2fc15aaf3dcdd33/receipt.json`.
Digest backendu przed/po
`47fe3184519f970a4c9aa5d2b7fb1a78f63e97615b3dbabd9413dc4582895c5f`;
snapshot buildu
`a22a9f193326c0d8234277c9d257f3ef9249f3356bb9a1dcf9745c9ccd2187b3`.
Rzeczywisty natywny CLI uruchomił cztery zakończone helpery: staging i ponowny
odczyt pustej kapsuły oraz kapsuły modelu. ACK pozostały identyczne i staged.
Obce przejęcie zostało odrzucone przed odczytem i straciło swój kanał.
Review nie znalazł actionable findings. Nie kompilowano testów jednostkowych
Rust. Bieżący UI na 3197 pozostał bez restartu i odpowiadał HTTP 200.

## Pozostałe bramki

Obecny verifier celowo pomija `FULLMAG_RUNS_ROOT` dla własnego API i sprawdza
odmowę bindingu do osobnego service. Profile resolvera izolują buildy; magazyn
zaakceptowanych zadań należy do rzeczywistego worktree. Nie przypisujemy
testowego API do danych aktywnego UI i nie tworzymy fikcyjnej tożsamości
worktree ani storage. Pozytywny przebieg przejęcie + staging + właściwy binding
API + cold/warm idle pozostaje **NOT VERIFIED** do zapewnienia legalnej izolacji.

Atomowy commit, graceful shutdown, replacement, nowy pin i hydration UI
pozostają otwarte. Procenty całego planu bez awansu.
