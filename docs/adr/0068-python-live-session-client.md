# ADR 0068 — tryb `live` DSL: skrypt Pythona programuje działającą instancję

Status: **przyjęta** — decyzje D1–D5 i odpowiedzi na pytania zaakceptował
użytkownik 22.10.2026. Implementacja nie jest rozpoczęta.
Data: 2026-10-22.
Specyfikacja: [`docs/specs/python-live-client-v1.md`](../specs/python-live-client-v1.md).

Ten dokument nie opisuje działającego runtime. Stan kodu odpowiada commitowi
`48e947787`.

## Kontekst

Docelowo Fullmag ma działać jak Boris Spintronics z `NetSocks.py`
(`external_solvers/BORIS/NetSocks.py`, submoduł `external_solvers`): zwykły
skrypt Pythona z `import fullmag as fm`, uruchomiony przez `python skrypt.py`
albo komórka po komórce w Jupyterze, jest **klientem działającej instancji**
Fullmaga. Każda linia programuje symulację w żywej sesji: tworzy i zmienia
obiekty, parametry i etapy, uruchamia, wstrzymuje i przerywa runy oraz
odczytuje wyniki. Control Room pokazuje te zmiany na bieżąco.

Dziś jest inaczej: `fullmag skrypt.py` **interpretuje** skrypt. Launcher
uruchamia helper Pythona, który przechwytuje definicje i etapy do ProblemIR
(tryb `capture`), a dopiero potem Rust planuje i wykonuje całość. Wywołanie
`python skrypt.py` liczy w procesie Pythona przez PyO3 (tryb `eager`), bez
sesji i bez Control Room.

Wymaganie użytkownika: istniejący skrypt (`fm.engine(...)`, `fm.cell(...)`,
`layer = fm.geometry(...)`, `layer.Ms = 800e3`, `fm.relax()`) ma działać w
trybie `live` bez zmiany słownictwa.

### Jak robi to Boris

- Jeden język komend konsoli (~600 komend) jest wspólnym kanałem GUI, skryptów
  i Pythona. Wszystkie trafiają do `Simulation::HandleCommand(std::string)`
  (`Boris/Commands.cpp`).
- Serwer TCP na porcie 1542: wątek `Listen_Incoming_Message`
  (`Commands.cpp:26`) odbiera komunikat `hasło*komenda arg…` (`*` cicho,
  `>` z echem w konsoli) i odsyła wartości rozdzielone tabulatorem (bufor
  4096 B). Każda komenda to osobne połączenie connect → send → recv → close.
- Komendy wykonują się pod `userInputMutex` i `simulationMutex`, więc nie
  wchodzą w środek iteracji. Komenda wysłana podczas biegu zatrzymuje
  symulację, a klient najpierw odbiera komunikat `stopped`. `run` blokuje
  klienta do końca biegu.
- `NSClient` w `NetSocks.py` ma ~640 metod wygenerowanych ze zrzutu komend
  (każda z wariantem `bufferCommand`, czyli paczką `buffercommand` +
  `runcommbuffer`). Nad nimi leży fasada obiektowa: `Mesh`
  (`ns.Ferromagnet(...)`), `Param` (`mesh.param.damping.setparam(...)`),
  `Quantity` (`mesh.quant.M.getvalue(...)`), algebra `Shape`, helpery etapów
  (`setstages`, `Relax`, `Hxyz`) oraz lokalny odczyt i zapis OVF2.
- Skrypt łączy się jawnie: `ns = NSClient()` sprawdza, czy instancja Borisa
  nasłuchuje na porcie.
- Tryb embedded: moduł C `BPython` (`Boris/PythonScripting.h`) wykonuje te
  same stringi w procesie Borisa. `Run(callback)` zastępuje pętlę solvera
  atrapą i woła `Simulate()` po jednej iteracji z pętli Pythona, wykonując
  callback użytkownika po każdym kroku.
- `NSMultiClient` rozdziela przemiatanie parametrów na kilka instancji
  Borisa (osobne porty) w wątkach.

Słabości, których Fullmag nie przejmuje: brak schematu, wersjonowania i
typowanych błędów; brak rewizji i kontroli współbieżności; zatrzymanie biegu
przez dowolną komendę; hasło otwartym tekstem; zdalne wykonanie dowolnego
kodu (`runscript`); dane wyłącznie przez pliki.

### Co Fullmag już ma

| Potrzeba | Istniejący mechanizm |
|---|---|
| Słownictwo komend | DSL Pythona: `fm.engine`, `fm.cell`, `fm.geometry`, `fm.b_ext`, `fm.relax`, `fm.run`, `fm.study().stages…`, uchwyty obiektów (`layer.Ms`, `layer.alpha`, `layer.m`) |
| Tryby wykonania DSL | `world.py` rozgałęzia funkcje etapów na `capture` (`fullmag skrypt.py`, zapis do ProblemIR) i `eager` (`python skrypt.py`, obliczenie w procesie przez PyO3, `runtime/simulation.py`) |
| Mutacje sceny | `POST /v2/sessions/current/model/transactions` (`AuthoringTransactionRequest`, `crates/fullmag-api/src/schemas/authoring.rs`), każda z `base_revision`; konflikt → `scene_stale_revision` (409) |
| Etapy | `scene.study.stages` przez transakcję `merge_patch` |
| Sterowanie runem | `POST /v2/sessions/current/simulation/commands` (`StructuredCommandRequest`, `schemas/commands.rs`): `run`, `relax`, `pause`, `resume`, `stop`, `skip`, `compute_fields`, … z `RuntimeCommandIntent` (target, precondition, `client_intent_id`) i dziennikiem stanów |
| Powiadomienia | WebSocket `/v2/sessions/current/events/ws` (`fullmag.live.v1`), wyłącznie powiadomienia o zmianie rewizji |
| Dane | binarne FMVP `…/data/fields/:q/samples/vector` (ADR 0053), tabele `rows.bin`, ETag |
| Kontrakt | OpenAPI v2 (`/v2/platform/openapi.json`), generator klienta TypeScript |

Braki: w `packages/fullmag-py` nie ma klienta HTTP/WebSocket, sesji ani
dekodera FMVP; API ma jedną sesję `current` na proces; w trybie accepted
(Docker) edycje wejścia przy aktywnym, także wstrzymanym, runie są odrzucane
z błędem `accepted_execution_input_locked`
(`crates/fullmag-api/src/live_execution_binding.rs`); supervisor scratch
kończy proces potomny przy każdej zmianie rewizji sceny
(`crates/fullmag-cli/src/scratch_runtime.rs`); przechwytywanie skryptu
blokuje zdarzenia `socket.*` (`fullmag/runtime/accepted_source_capture.py`).

## Decyzje

**D1. Skrypt Pythona jest klientem działającej instancji; interfejsem jest
istniejący DSL w trzecim trybie `live`.** Nie powstaje język komend
tekstowych ani nowe słownictwo; jedyną kanoniczną powierzchnią skryptową
pozostaje DSL (inwariant 13.1, `.agents/instructions/contracts.md`). Tryb
`live` działa tak samo dla `python skrypt.py`, interpretera interaktywnego i
Jupytera, obok istniejących `capture` i `eager`:

- funkcje definiujące scenę (`fm.engine`, `fm.cell`, `fm.geometry`,
  `fm.b_ext`, przypisania na uchwytach, `study.stages.add_*`) wysyłają
  **natychmiast po każdym wywołaniu** jedną typowaną transakcję z
  `base_revision`;
- funkcje akcji (`fm.relax`, `fm.run`, `fm.minimize`, …) wysyłają komendy
  runtime i domyślnie czekają na ich zakończenie, jak w skrypcie;
- odczyty (`m`, pola, tabele) pobierają dane z sesji.

Wybór trybu: `fm.connect(url=None)` jawnie przełącza proces na `live`
(odpowiednik `NSClient()`). Bez wywołania `fm.connect()` tryb `live`
włącza się, gdy ustawiona jest zmienna `FULLMAG_URL`. Bez obu proces zostaje
w dotychczasowym trybie `eager`. `fullmag skrypt.py` zostaje trybem `capture`
dla wykonań kwalifikowanych z pełną provenance. Stan sesji eksportuje się do
kanonicznego skryptu (`GET …/model/script`).

**D2. Generowany klient jako warstwa wewnętrzna; uchwyty DSL jako proxy.**
Warstwa niska `fullmag.client` używa modeli wygenerowanych z OpenAPI v2 dla
wybranego podzbioru tagów i jest dostępna dla zaawansowanych użytkowników.
Tryb `live` DSL korzysta z niej wewnętrznie. Rolę obiektów-proxy (odpowiednik
`Mesh`/`Param`/`Quantity` z Borisa) pełnią istniejące uchwyty DSL
(`MagnetHandle` i pozostałe) podpięte do sesji; nie powstaje równoległa
hierarchia klas. Każda operacja mapuje się na konkretny wariant transakcji
(`create_object`, `patch_material`, …); `merge_patch` tylko tam, gdzie API nie
ma dedykowanego wariantu.

**D3. Edycja podczas biegu tylko przez jawną pauzę; obowiązuje od granicy
etapu.** Klient nie zatrzymuje runu niejawnie (inaczej niż Boris).
`with fm.paused(): …` wysyła `pause`, czeka na stan wstrzymany, wykonuje
edycje i wysyła `resume`. W v1 edycje wejścia przyjęte w pauzie obowiązują od
następnej granicy etapu. Zmiana parametrów w trakcie całkowania wymaga
wcześniej notatki w `docs/physics/` i deklaracji per ścieżka wykonania
(FDM/FEM × CPU/GPU). Wywołanie DSL zmieniające wejście podczas biegu bez pauzy
zgłasza `InputLockedError`.

**D4. Odpowiednik `Run(callback)`: zdarzenia i `run_until`.** W v1:
callbacki na zdarzenia WebSocket (`scalar.sample`, `resource.batch_changed`),
warunki stopu po stronie serwera oraz `fm.run_until(predicate,
chunk_steps=N)` jako pętla `run(max_steps=N)` z oceną predykatu między
blokami, z udokumentowanym kosztem. Synchroniczny callback po każdym kroku
wymaga trybu in-process przez PyO3 i `InteractiveRuntime` (faza F7 spec).

**D5. Przemiatanie parametrów przez wiele grup Docker DEV.** Odpowiednik
`NSMultiClient`: skrypt łączy się z kilkoma grupami DEV (ADR 0067), każda
z własnym portem i budżetem `FULLMAG_DEV_*`, i rozdziela punkty przemiatania
między ich sesje `current`. Każda grupa ma jedną sesję; równoległość zależy
od liczby uruchomionych grup i ich budżetów.

## Rozstrzygnięte pytania

1. **Dostęp z hosta.** Port API (8081) nie jest publikowany z kontenera.
   Frontend grupy DEV przekazuje `/v2/*` do API (`apps/control-room/next.config.ts`,
   rewrite `/v2/:path*`), a Control Room łączy się z WebSocketem pod tym samym
   originem. Skrypt używa więc `http://127.0.0.1:<port frontendu grupy>`.
   `development_admission` nie jest autoryzacją: zamyka mutacje tylko na czas
   przekazania backendu i zwraca wtedy ustrukturyzowany błąd, po którym klient
   ponawia żądanie z backoffem.
2. **Edycje w pauzie.** Zgodnie z D3: od granicy etapu; zmiany w trakcie
   całkowania dopiero po notatce fizycznej.
3. **`step{n}` i long-poll.** Nie w v1. Wystarczają `run(max_steps)` i
   zdarzenia WebSocket; nowe komendy tylko po zmierzonej potrzebie.
4. **Skrypt i Control Room na tej samej sesji.** Sesja jest współdzielona.
   Konflikty rewizji klient zgłasza jako `StaleRevisionError`, bez
   nadpisywania. Control Room pokazuje, że podłączony jest klient skryptu.

## Konsekwencje

- `packages/fullmag-py` dostaje opcjonalną zależność HTTP (httpx) i WebSocket
  (dodatek `fullmag[client]`); rdzeń DSL i ścieżka `fullmag skrypt.py`
  pozostają bez nich.
- Funkcje DSL w `world.py` dostają gałąź `live` obok `capture` i `eager`.
  Każda funkcja publiczna musi mieć zdefiniowane zachowanie w trybie `live`
  albo zgłaszać jawny błąd „nieobsługiwane w trybie live”.
- Natychmiastowa synchronizacja oznacza wiele rewizji sceny; ponowne
  wykonanie komórki lub linii definiującej obiekt musi aktualizować istniejący
  obiekt zamiast tworzyć duplikat (reguła tożsamości w spec §5.2).
- `just docker-dev-codegen` generuje także modele Pythona; zmiana schematu API
  wymaga regeneracji obu klientów.
- Dekoder FMVP istnieje w dwóch językach; zgodność pilnują wspólne próbki.
- Backend wymaga zmian z F5 spec: edycje w pauzie od granicy etapu,
  utrzymanie stanu runtime scratch przy edycjach, obecność klienta skryptu
  widoczna w Control Room.
- Przemiatanie przez wiele grup DEV wiąże się z kosztem zasobów: każda grupa
  ma własny backend, frontend i budżet CPU/RAM.

## Odrzucone alternatywy

- **Port protokołu Borisa (tekst po TCP) lub warstwa komend tekstowych.**
  Duplikowałyby semantykę poza DSL i ProblemIR, bez rewizji i typów.
- **Osobna hierarchia obiektów-proxy (`session.objects[...]`).** Wymagałaby
  drugiego słownictwa obok DSL; skrypt nie działałby w trybie `live` bez
  zmian.
- **Synchronizacja dopiero przed akcją (`fm.relax`, `fm.run`).** Odrzucona
  przez użytkownika: zmiany mają trafiać do sesji natychmiast.
- **Przemiatanie przez batche trwałych projektów.** Odrzucone przez
  użytkownika na rzecz wielu grup DEV; batche pozostają możliwe jako przyszłe
  rozszerzenie.
- **Generowanie całego klienta z pełnego OpenAPI.** Specyfikacja ma ~1,8 MB;
  generowany jest podzbiór tagów.
