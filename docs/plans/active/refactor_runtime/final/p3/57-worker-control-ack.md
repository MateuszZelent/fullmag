# P3-B/P5-B — durable worker control ACK i bariera ukończenia

Data: 27.09.2026
Implementacja: `2fb3d3d23053339231b37e252f4f76948c654c47`
(`feat(runtime): acknowledge durable worker control`)

## Problem

Dotychczas supervisor odnawiał lease na podstawie obserwacji żywego procesu,
a operatorowy `Stop` kończył potomka z zewnątrz. Taki model nie dowodził, że
worker odebrał konkretny heartbeat ani że sam potwierdził zatrzymanie. Osobne
strumienie command/event mogły również wyprowadzić journal do dwóch poprawnych
lokalnie, lecz wzajemnie sprzecznych prefiksów.

## Zaimplementowany kontrakt

- `worker_protocol.v3` dodaje zdarzenie `Completing`. Worker publikuje je po
  zakończeniu side effectu, przed końcowym drainem durable inboxu, publikacją
  outputów i `Completed`.
- Każdy zapis journalu niesie pełny checkpoint command/event. `SessionStore`
  porównuje go pod jednym writer lockiem z rzeczywistym wspólnym prefiksem obu
  strumieni. Konflikt powoduje recovery i ponowienie dokładnej operacji.
- Heartbeat jest trwałą komendą. Worker odbiera go z inboxu i publikuje
  `HeartbeatAck` dla tej samej sekwencji. Supervisor zwiększa fizyczny
  `heartbeat_sequence` lease dopiero po tym ACK.
- Po `Completing` supervisor nie publikuje kolejnego heartbeat, a publiczny
  `Stop` jest odrzucany. Pozwala to wyznaczyć zamknięty prefiks sterowania przed
  terminalnym `Completed`.
- Publiczny `Stop` trafia do durable journalu i inboxu. Worker przerywa
  kontrolowany przebieg, oznacza komendę jako applied i publikuje `Stopped`.
  Supervisor po zaobserwowaniu Stop wyłącza nowe heartbeat, czeka na normalny
  exit workera i dopiero potem zwalnia dokładny lease.
- Ostatni ACK może zostać zrekoncyliowany z nadal aktywnym lease po terminalnym
  evencie, lecz przed release. Ta wyjątkowa ścieżka nie pozwala na nowe
  admission ani przejęcie ownership terminalnego taska.
- Nieudany exit zachowuje `failure_reason` również wtedy, gdy wcześniej
  zażądano Stop; sama intencja anulowania nie zamienia awarii procesu w sukces.
- Recovery zachowuje historyczne `worker_protocol.v2` per attempt. Jedna próba
  nie może mieszać wersji protokołu.

## Dowody

| Bramka | Wynik | Receipt |
|---|---|---|
| Source check API/runtime | **PASS** | `3467a65769be4235bf64e87bfcd1e2f3` |
| Produkcyjne process E2E | **PASS** | `ee5c9689c1af4be7b11797c3815d960b` |

Process E2E używa rzeczywistych binariów API, publishera, schedulera i workera.
Dla czterech zakończonych runów potwierdza niepuste, dokładnie równe listy
`Heartbeat`/`HeartbeatAck`, kolejność `Completing` przed `Completed`, pusty
pending inbox, applied commands i released lease z końcową sekwencją ACK.
Osobny scenariusz przez publiczne HTTP materializuje run, czeka na `Running`,
publikuje `Stop` i wymaga worker-originated `Stopped`, zastosowanego Stop,
poprawnego exit receiptu oraz zwolnionego lease. Receipt ma schemat
`fullmag_resource_discovery_runtime_v4`.

Testy jednostkowe Rust pozostają **NOT RUN** zgodnie z aktywnym zakazem
kompilowania targetów testowych. Bramka źródłowa i process E2E nie są
przedstawiane jako ich zamiennik.

## Granica kwalifikacji

Dowód obejmuje lokalny accepted runtime FDM CPU/double/strict. Nie kwalifikuje
FDM GPU, FEM CPU, FEM GPU, hosta zdalnego, izolacji urządzenia, steeringu,
pełnej fizyki ani wydania. P3 wzrasta do **92%**, P5 do **84%**, a cały plan do
około **48%**.
