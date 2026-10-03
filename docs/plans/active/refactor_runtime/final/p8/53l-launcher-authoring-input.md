# P8-53L — wejście authoring przez natywny launcher

## Zakres

Przyrost łączy prywatne wejście API z natywnym CLI. Zwykły launcher zamykał
stdin dziecka API, więc sprawdzony w P8-53K restore nie miał drogi przez CLI.
Przy jawnej konfiguracji prywatnego restore CLI przekazuje stdin bez zmiany
kanonicznego dokumentu. API nadal sprawdza envelope, rozmiar, deadline,
tożsamość docelowego buildu i semantykę sceny przed otwarciem listenera.

Restore odrzuca start poza UI dev, start z plikiem skryptu i niepoprawną
wartość konfiguracji. Sprawdzenie przed przygotowaniem skryptu zapobiega
nadpisaniu odtworzonej sceny przez zwykły publisher. Odtworzenie odrzuca
również świadome użycie już działającego API.

## Granice kolejnego kroku

To nie jest jeszcze pełny restart workspace. Manager musi zweryfikować
capsule oraz sealed bundle, zamknąć zapisany pipe, potwierdzić właściciela
listenera i świeży pin API, rozwiązać szkice UI oraz potwierdzić globalne
idle/drain zaakceptowanych zadań. Oddzielne dane editor/workspace/project
document muszą przejść przez właściwych konsumentów UI. Receipt `restored`
można opublikować dopiero po ich odtworzeniu. Publiczne `restart_available`
pozostaje wyłączone.

Nowy manager powinien uruchamiać sealed CLI bezpośrednio. Przekazywanie
surowego stdin przez PowerShell `Invoke-External` nie jest zweryfikowaną
trasą. Sama gotowość kompatybilnego HTTP nie dowodzi tożsamości procesu
w wyścigu o port; manager musi sprawdzić listener i nowy API instance.

## Weryfikacja

`prepare_development_restore_launch` odczytuje staged capsule przez istniejący
loader semantyczny i sprawdza pełny sealed bundle profile dev. Namespace musi
zgadzać się z worktree resolvera. Target capsule jest digestem manifestu buildu;
target API jest zweryfikowaną product version, zgodnie z konfiguracją launchera.
Helper zachowuje osobno editor/workspace/project_document i nie zmienia receipt.
Nie ma jeszcze produkcyjnego wywołania helpera przez pętlę restartu managera.

`just windows-workspace-build dev dev 3197 auto`: exit 0, profile `backend-dev`,
source identity passed. Baza: `bd7e07472f0420dc5b2df3d93d709efea6c422dc`.
Source snapshot: `9fb36b84425f15649fde42a0b0c0acd3efda782a079c76b46a6191ad433b8f0a`.
Backend source: `0880459897430640f728cc8165e35e15abe5a4c1566fcfc9ab87a8197a2cbf04`.

`just verify-windows-development-handoff`: exit 0, **79 sprawdzeń**, 0 pominiętych.
Receipt: `storage/builds/fullmag-0950f4dca4ffe38f/development-handoff-checks/checks/dd588b9b155a479296a49fc8cf9729d0/receipt.json`.
Nowe przypadki sprawdzają rozdzielenie obu build IDs, zachowanie osobnych danych
UI, rebasing assetów, odrzucenie obcego targetu/namespace/binding, release i
lokalizacji poza runtime, zmodyfikowanego EXE oraz już odtworzonego capsule.
To checks interpretowane; nie kompilowano testów jednostkowych.

`just verify-windows-development-backend-api`: exit 0, **48 checks**.
Receipt: `storage/builds/fullmag-0950f4dca4ffe38f/development-backend-api-checks/checks/37028c19a1c146e5b9a6b218e031a81e/receipt.json`.
Verified build ID: `85fae601f6a542969fd2d4cac36529329a5ba073d46077a49496908ff873e2a3`.
Backend digest przed/po identyczny. Produkcyjny CLI odrzucił trzy nielegalne
konteksty. Valid envelope przeszedł rzeczywisty inherited pipe CLI → API;
API otworzył listener po restore, a celowy błąd konfiguracji URL frontendu
zatrzymał bootstrap przed uruchomieniem frontendu/desktop. Guard zakończył
własny API, a `api_listener_closed=true` potwierdził zamknięcie portu.
12 zarejestrowanych własnych procesów waitowanych, pusty service po drain exit 0.

Scoped rustfmt, Python parser i diff check: PASS. Review wykrył błąd timeout
w verifierze: zabicie samego CLI mogło osierocić API. Poprawiono sprzątanie
własnego drzewa fixture i kontrolę zamknięcia portu w `finally`; re-review nie
znalazł kolejnego blokera tej poprawki. Ścieżka timeout cleanup ma review
źródeł, lecz nie została wymuszona w końcowym natywnym przebiegu.

Nie restartowano workspace użytkownika. Pełny manager–capsule–restart–browser,
globalny accepted-work idle fence i świeży PID/API-instance pin pozostają
NOT VERIFIED. P8-53 oraz cały plan pozostają w realizacji.
