# P8-52 — przyrostowy backend Windows

## Cel i zakres

Zmiany backendu nie powinny wymuszać pełnego buildu release. Natywna trasa
Windows pozostaje niezależna od WSL i kolejki Linux. Zakres tej iteracji to
workspace FDM CPU; kwalifikacja FEM/GPU i instalator pozostają osobnymi bramkami.

## Decyzja

- `just windows-ui dev` wybiera profil Cargo `backend-dev` oraz oddzielny,
  stały profil storage `windows-native-fdm-cpu-dev`. Static domyślnie wybiera
  dotychczasowy release. Profile nie nadpisują sobie binariów ani manifestów.
- Profil dev włącza incremental, wyłącza LTO i zachowuje optymalizację O3
  aktualnych jąder FDM CPU (`fullmag-engine`, `fullmag-fdm-demag`). Jest profilem
  pracy programisty; nie zastępuje kwalifikacji release ani walidacji naukowej.
- `auto` ponownie używa zweryfikowanego pakietu, gdy wejścia backendu i hashe
  artefaktów nie zmieniły się. Zmienione źródło przechodzi zwykłą kompilację
  zależnych jednostek Cargo i ponowne linkowanie.
- `just windows-workspace-build dev dev 3197 auto` buduje bez uruchamiania UI.
  `just windows-ui dev` sam uruchamia własny watcher po zapieczętowaniu runtime.
  `just windows-backend-dev 3197` pozostaje opcją oddzielnej obserwacji.
  Watcher wywołuje tę samą zamkniętą trasę. Zmiany są scalane, a nieudany build
  czeka na kolejną edycję.
- Działające EXE pochodzą z odrębnej, zapieczętowanej kopii runtime. Dopiero
  potwierdzenie jej manifestu i hashy zwalnia blokadę mutowalnego buildu.
  Osobna blokada runtime chroni pojedynczy aktywny workspace tego worktree.
- Terminalny raport wymaga odebrania wyniku launchera i zakończenia watchera.
  Watcher musi zakończyć się kodem 0; przerwanie lub błąd pozostawia `unknown`.
  Utrata managera nie oznacza bezczynności potomków: niepewny zapis blokuje
  kolejne buildy i starty przed bootstrapem storage. Nie zabijamy całego drzewa,
  ponieważ niezależny owner obliczeń z ADR 0049 ma własny lifecycle.
  Jawne recovery zachowuje poprzedni raport wraz z SHA-256 i dowodami inspekcji.
- Watcher nie restartuje aplikacji ani nie podmienia załadowanego kodu. Po
  komunikacie o gotowym buildzie użytkownik zapisuje projekt i restartuje UI.
  Ochrona oraz odtworzenie niezapisanych szkiców nie są deklarowane.
- Podczas pracy UI kolejne buildy nie wykonują instalacji Python/pnpm ani
  ponownego stagingu frontendu. Python DSL i manifesty zależności muszą być
  zgodne z kopią runtime; ich zmiana blokuje background build. Synchronizacja
  wersji pakietu Python jest jawnie odroczona do następnego uruchomienia.
- Kontrolowana trasa odmawia startu/buildu przy istniejących canonical
  `OWNER.json`, `OWNER.lock`, `LAUNCH.json`, `LAUNCH.lock`, błędzie obserwacji
  albo ustawionym `FULLMAG_RUNTIME_SERVICE_CONFIG`. Sprawdza tę granicę przed
  bootstrapem i pod blokadą buildu. Nie próbuje usunąć danych ani zatrzymać
  ownera. Obsługa niezależnego service wymaga osobnego handshake; sam brak
  plików nie kwalifikuje współbieżności z zewnętrznym uruchomieniem service.
- CMake przypisuje transportowy identyfikator źródeł CUDA wyłącznie do
  `context.cu`, który go odczytuje. Pozostałe jednostki nie otrzymują zmiennej
  definicji kompilatora. Zmiany headerów, flag, toolchainu i ABI nadal mogą
  zasadnie przebudować wiele jednostek.

## Kryteria odbioru

1. Regresje interpretowane: wybór profilu, zamknięte argv/admission, reuse,
   debounce, błąd buildu, zmiana źródeł w trakcie kompilacji, integralność
   kopii runtime i rozdzielenie blokad. Bez kompilowania testów jednostkowych.
2. Rzeczywisty pierwszy build dev i jego terminalny receipt.
3. Pomiar `auto` bez zmian oraz przebudowy po zmianie kodu backendu.
4. UI uruchomione z kopii runtime, działające podczas kolejnego buildu.
5. Brak automatycznego restartu, brak mutacji projektu wskutek watchera.

## Stan dowodów

Kryteria 1–5 potwierdzono dla natywnego workspace FDM CPU w opisanych niżej
warunkach. Aktualny wspólny przebieg regresji
interpretowanych: **130 passed, 2 skipped, 12 subtests passed**, exit 0,
87,82 s. Obejmuje profile, CMake configure bez kompilatora, watcher, bundle,
handshake, blokady, awarię managera, walidację zachowanego recovery, odmowę
naprawy Python podczas pracy UI, niezerowy exit watchera, ochronę znanego
ownera service i serializację manifestu. Linux mount checks
pominięto na Windows. Nie kompilowano testów Rust/TypeScript.
Po tym przebiegu dodano kontrolę zintegrowanej trasy: rzeczywisty fixture
`OWNER.json` odrzuca zarówno start, jak i build przed `initialize`. Osobny
focused check: **1 passed, 2 subtests passed**, exit 0; plik ownera bez zmian.

| Przebieg rzeczywisty | Wynik | Czas |
|---|---|---:|
| Pierwszy build profilu `backend-dev` | exit 0, CLI/API/desktop i terminalny receipt | 600,11 s |
| `auto` bez zmian | exit 0, wybór `false`, brak Cargo/uv/pnpm build | 10,50 s |
| Zmiana CLI i launchera, przyrostowy build | exit 0, nowy snapshot i manifest | 140,27 s |
| Automatyczna przebudowa CLI przy działającym UI | exit 0, watcher `ready`, zachowane procesy i model | 102,72 s |
| Build z końcowymi guardami lease/service | exit 0, bez instalacji ani restagingu podczas pracy UI | 147,16 s |

Receipts `backend-dev-cold-20261003.json`,
`backend-dev-unchanged-20261003.json` i `backend-dev-warm-20261003.json` oraz
logi znajdują się w kanonicznym runtime root worktree
`fullmag-0950f4dca4ffe38f`; bazowy HEAD
`04560f7d1fdd6a93b547ffd13326a9aac48bbbf0`. Przebiegi obejmowały produkcyjne
binaria, nie kompilację testów jednostkowych. Cold nie jest obietnicą czasu
po każdej edycji; warm nie jest benchmarkiem wszystkich zmian backendu.

Pierwszy start dev odrzucono przed uruchomieniem UI, ponieważ PowerShell
zapisał CPU `features` jako `null`. Producer poprawiono do tablicy `[]`,
a regresja wykonuje rzeczywiste wyrażenie AST dla CPU i CUDA. Rzeczywisty
ponowny start dev przeszedł: API, CLI i desktop używały zapieczętowanego
pakietu `9c822952c2b1469999ffd9ccbf4f6447`. W przeglądarce utworzono sesję
„Backend dev watcher proof” i obiekt „Watcher proof box”. Edycja komentarza
CLI uruchomiła watcher bez osobnego polecenia i bez instalacji zależności.
Receipt `backend-watch-live-proof-20261003.json` potwierdza exit 0, stan `ready`
oraz identyczny SHA-256 sceny przed i po:
`a8a3106a7846bd07f8170455b43d3ed2a767dc021d8404de78eeadeae0c87956`.
API zachowało UUID `63fec81c-99e0-4767-9692-d15b5c0482e7`; CLI/API/desktop
zachowały PID 198916/232268/210800. Widoczny canvas miał `contextLost=false`
i drawing buffer 514 × 337. Nowy manifest ma inny snapshot i jawne
`python_sync_required=true`; działające procesy zachowały poprzednią wersję.

Po teście zatrzymano własny watcher przez jego kanał stop-file. Po zachowaniu
kopii modelu zakończono własny proces testowego UI; CLI przeprowadziło cleanup.
Receipt `backend-dev-live-terminal-20261003.json` ma `completed`, exit 0,
`launcher_waited=true`, `watcher_waited=true` i `watcher_exit_code=0`.
Inspekcja po zakończeniu potwierdziła brak natywnych CLI/API/UI, watchera
i listenerów 3197/8081. Końcowe guardy przeszły też rzeczywisty build
`backend-dev-final-policy-build-20261003.json` exit 0. Zastosowanie nowej wersji
z odtworzeniem modelu pozostaje P8-53/NOT VERIFIED. Kontrola blokuje mutacje zależności przy
niezależnym ownerze obliczeń; nie wolno uznać zamknięcia UI za drain ownera.
Natywne GPU i czas kompilacji CUDA: NOT VERIFIED.

Ponowny `just windows-ui dev` użył gotowych EXE (`automatic build selection:
false`, bez Cargo), wykonał odroczoną synchronizację metadanych pakietu Python
i uruchomił watcher z baseline nowego buildu. Dowód
`backend-dev-relaunch-proof-20261003.json` potwierdza pakiet
`201c8af66ddf44febb4fb00a5349cb94`, wersję CLI
`0.1.0-dev.20261003.g04560f7d1fdd.dirty.s476c52e387ac+9772`, zgodną wersję
PEP440 pakietu Python, `python_sync_required=false` oraz nowy API UUID
`3012ca88-4c47-433a-af01-03032247df51`. UI na 3197 pokazuje ekran tworzenia
symulacji; automatyczne odtworzenie testowej geometrii nie jest deklarowane.

Pełny plan refaktoryzacji pozostaje aktywny; ten zakres nie zamyka P1/P6/P8.
