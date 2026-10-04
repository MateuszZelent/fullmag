# P8-53AF — natywny klient completion ownera

Data: 04.10.2026. Zakres: prywatny klient CLI natywnego Windows dev.
P8-53 i pełny plan pozostają w realizacji.

## Zachowanie

`AuthoringAcquisition` wysyła jednorazowe `complete_cold` dla nowego API.
Przed wysłaniem sprawdza piny commit/kandydata, brak skonfigurowanego resident
service i aktualną tożsamość przejętej sceny. Odpowiedź ma ścisły schema i musi
zgadzać się z nonce, starym/nowym API, commit, target, bindingiem magazynu,
session ID/epoch oraz hashem sceny. Potwierdza jawne otwarcie admission.
Kanał zostaje zużyty; błąd lub utrata odpowiedzi nie powoduje retry ani abort.
Nie wyprowadza dowodu zakończenia starego procesu z plików: to obowiązek
koordynatora, który jest właścicielem i odbiera dokładny proces.

Ukryty adapter diagnostyczny używa tego samego produkcyjnego klienta.
Proces nadrzędny sondy jest właścicielem replacement API i wcześniej odbiera stary API; adapter
potwierdza discovery record nowego API oraz przypiętą scenę. Probe-only override
tokenu jest dostępny wyłącznie z jawnym managed probe. Normalny launcher nadal
generuje nowy losowy sekret. Ten adapter nie dowodzi pełnego produkcyjnego
supervisora procesu ani restartu UI.

## Weryfikacja

`just windows-workspace-build dev dev 3197 auto`: produkcyjne EXE, exit 0.
Log `windows-native-fdm-cpu-dev/windows-runtime/native-completion-client-build.log`.
Nie kompilowano testów jednostkowych.

`just verify-windows-development-backend-api`: **227 kontroli, exit 0**.
Receipt `development-backend-api-checks/checks/0a6e1f69ef8d4f639ff79593f8c8aa1f/receipt.json`.
Backend source: `a738c13cb3e39792b6e23ea8f983297e5e2958003b78e7a144283a21a81c1b22`;
build snapshot: `273d37e3a9f7bf988cfdada8a10a3d148637066d9722eefe657ec9e905dccfaf`.
Tożsamość źródeł przed i po sondzie zgodna. Ścieżki receipt/logów są względem
`storage/builds/fullmag-0950f4dca4ffe38f`.

W obu wariantach ACK/lost-ACK starego API natywny klient poprawnie zakończył
handoff i odrzucił obcy PID, niezgodną scenę oraz fałszywy completion ACK.
Log fałszywego ACK wskazuje `acknowledgement mismatch`, a rozbieżnej sceny —
odmowę przed wysłaniem żądania. Wszystkie 68 zarejestrowanych procesów odebrano.
Osiem nowych procesów klienta obejmuje sześć oczekiwanych odmów (exit 1) i dwa
poprawne completion (exit 0). Dwa disposable replacement API zatrzymano po
własnej próbie bez Compute; ich exit 1 oznacza cleanup sondy, nie graceful exit.

Próba fałszywego ACK zmienia tylko własny zweryfikowany discovery record
disposable API; zachowuje oryginalne bajty w fixture i odtwarza je po próbie.
Nie wysyła completion do rzeczywistego API. Pozytywna próba używa prawdziwego
API i sprawdza trwałą historię, retirement markerów i mutację HTTP.
Review źródłowe nie wykazało actionable findings. Aktualne 124 kontrole
interpretowane kapsuły z P8-53AE zachowano; jej format i loader nie zmieniły się.
UI użytkownika zachowano; końcowy odczyt na 3197 zwrócił HTTP 200.

## Pozostały zakres

Produkcyjny koordynator launchera, ponowny live restart tego samego workspace,
warm service/drain, Compute, hydration UI i szkice Inspectora pozostają otwarte.
Nie zmienia się `restart_available=false`; kapsuła nadal pozostaje `staged`.
Live completion pustego workspace i Windows power-loss pozostają NOT VERIFIED.
