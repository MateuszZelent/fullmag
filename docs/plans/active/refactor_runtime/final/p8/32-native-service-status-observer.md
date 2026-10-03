# P8-32 — rzeczywisty odczyt stanu natywnej usługi

## Implementacja wewnętrzna

`application_service_status::observe` odczytuje konfigurację i ownera bez
inicjalizacji store, zapisu, spawn, retry startu, kill ani takeover. Wynik
`application_service_status.v1` rozróżnia brak konfiguracji, błąd konfiguracji,
brak ownera, ostatnio opublikowane starting/draining/drained/failed/unknown,
potwierdzone ready oraz niepewną obserwację. Stan opublikowany w pliku nie
dowodzi żywotności procesu. Nie jest kwalifikacją solvera ani gwarancją
dostępności żądanego GPU.

Ready wymaga odczytu przez config-aware loopback probe z deadline 3 s:
nonce, dokładna konfiguracja, build identity, owner/process-start token,
PID/host, target, obie pule i generacje. Deskryptor porównuje się także
z odpowiedzią, aby odmówić zmiany ownera między odczytami. Obcy target/pool
lub dostępna obca tożsamość buildu odmawia także stanu niegotowego.
OWNER.lock bez deskryptora oznacza niepewną obserwację wymagającą recovery,
a nie obietnicę dalszego startu. Konfiguracja ma limit 64 KiB, owner 256 KiB,
a tekst powodu 2048 B, również po skróceniu wielobajtowego UTF-8.

## Poprawka wykryta w review

Wspólny `repository_path::read_bounded_regular_file` obsługuje teraz odczyt
config, ownera w observerze oraz powtórne odczyty discovery/ensure. Wymaga
wspieranego lokalnego FS, bezpiecznej ścieżki i zwykłego pliku. Sprawdza typ
i rozmiar przed open oraz z otwartego uchwytu, potem czyta najwyżej limit+1.
Unix używa O_NONBLOCK/O_NOFOLLOW; Windows otwiera finalny reparse point
przez FILE_FLAG_OPEN_REPARSE_POINT i odrzuca go z metadata uchwytu. FIFO,
directory, końcowy link i nadmiarowy payload nie stają się strumieniem statusu.

Root i przodkowie pozostają zaufane zgodnie z kontraktem `checked_path`.
Nie deklarujemy odporności na podmianę całego drzewa przez obcy lokalny proces,
power-loss qualification ani deadline dla zawieszonego sterownika dysku.
Deadline 3 s dotyczy live RPC. Explicit config na niewspieranym FS jest
odrzucany, zamiast omijać tę granicę.

## Weryfikacja i otwarte bramki

- Parser/format `rustfmt --check` i scoped diff check: PASS.
- Niezależny source review i re-review: PASS. P1 odczytu plików specjalnych
  zamknięty przez shared reader; brak otwartych P0/P1 w tym zakresie.
- 11 regresji observera zapisanych: brak config, niewłaściwy root,
  limit UTF-8, wire schema, malformed config, brak ownera, malformed owner,
  oversized owner, obcy target/pool, metadata Ready bez live proof i orphan lock.
- Dwie regresje shared readera: zwykły plik/budget/directory oraz Unix FIFO/link.
  Wszystkie NOT RUN / NOT COMPILED z powodu zakazu unit builds.
- Pozytywny RPC, kompilacja Rust, Windows FS i runtime: NOT VERIFIED.
- Centralny runner sprawdzony 03.10.2026 02:09 UTC: worker running,
  accepting_jobs, brak active jobs, waiting_for_disk, 6 301 057 024 B wolne.
  Próg 8 GiB nie jest spełniony. Allow-list nie zawiera profilu API-codegen ani
  Windows. Nie uruchomiono hostowego zastępstwa, ręcznego ciężkiego builda,
  cleanup ani fikcyjnego generowania canonical OpenAPI.

## Następna integracja

Przygotowano robocze źródła DTO i handlera przyszłego
`GET /v2/platform/runtime-service`. Nie są zarejestrowane w routerze ani
canonical OpenAPI; nie są częścią tego commita. Endpoint, generated transport,
resource hook, widoczny status niezależny od sesji oraz autorun aplikacji
pozostają otwarte. Canonical kontraktu nie zastąpiono ręcznym snapshotem.
Brak gotowej usługi musi zachować dostęp do edycji i zapisu projektu.

Plan P0–P8 pozostaje otwarty. Stara instancja na 3104 jest zachowana do decyzji
użytkownika. Cudze zmiany i współdzielone zasoby pozostają zachowane.
