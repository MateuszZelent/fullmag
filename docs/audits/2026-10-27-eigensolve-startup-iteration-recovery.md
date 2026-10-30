# Odzyskanie startu po nieudanej iteracji

## Zakres

Polecenie `scripts/docker_dev.py stop-startup-iteration-volume` obsługuje
wyłącznie nieudaną iterację po prawidłowym drain poprzedniego runtime.
Nie zamyka aktywnych workerów i nie uznaje historycznego OWNER za aktywny.
Pozostawia wyniki, sesje, wolumeny, frontend i oryginalne receipty.

Wymagane argumenty: `--attempt` (development), `--iteration-attempt`,
`--config-sha256`, `--source-root`, `--port`. Domyślnie wykonuje preview;
`--apply` ponawia wszystkie kontrole pod blokadą BuildControl i zatrzymuje
wyłącznie dokładny backend przez zachowany dokument Compose.

Kontrole obejmują źródło, terminale development/iteration, digest Compose,
obraz, cgroup binding, StartedAt, niezmienny startup-failure fence, drzewo
procesów zawierające tylko init/supervisor/diagnostyczne API, zmienną API
wskazującą dokładny fence, drained OWNER zgodny z terminal_service_owner,
wyjście poprzednich workerów oraz wyłącznych konsumentów grupy/control volume.
Po stopie potwierdzane są zatrzymana instancja, niezmieniony frontend,
oryginalne receipty i OWNER. Wynik domenowy `stopped-confirmed` jest
zapisywany oddzielnie od stanu operacji BuildControl `succeeded`.

## Dowody wykonania 27.10.2026

- Development: `3305c687a5e941ce835afc29b695b7d6`.
- Failed iteration: `8a8750f64d034bd08d920577f0ece389`.
- Błąd startu: timeout NVML; po przywróceniu GPU nadal działało diagnostyczne API.
- Preview procedury przeszedł; stop `1a540470ccae4c0b9c5213b4185d0bf5`
  potwierdził zatrzymanie backendu `f14ddb0a2f54…` bez zmiany OWNER.
- Pierwsza wersja miała błąd finalizacji: przekazywała `stopped-confirmed`
  do BuildControl zamiast `succeeded`, pozostawiając helper przy blokadzie.
  Wznowienie `5c63c26198e04e10a5a87d992f497409` zostało odrzucone przed startem.
- Poprawiono mapowanie stanu i dodano test regresji. Opcja
  `--reconcile-stop-attempt` weryfikuje dokładny aktywny helper, oryginalny
  protokół lease, zapisany preflight/stop, receipty i bieżący zatrzymany
  backend. Po preview i `--apply` oryginalny helper publikuje terminal
  atomowo, a jego własny protokół zwalnia blokadę. Host nie usuwa `active`.
- Domknięcie `1a540470…` potwierdzone; managed resume
  `15d023b425df44e9beebe5427d320e19` zakończone succeeded, API ready,
  URL http://127.0.0.1:3217. Launcher wykonał przyrostową kompilację
  w zachowanym Docker build volume (backend_package_cache_hit=false).
  To nie jest jeszcze dowód renderowania modu.
- Osiem lekkich testów Python PASS; obejmują także negatywne subtesty
  tożsamości, niezgodne źródła/obrazy/kontenery i poprawny stan terminalny.
  Testy kompilowane nie były uruchamiane lokalnie.

## Granice

Ta procedura nie rozwiązuje nieznanego stanu aktywnego solvera, błędu
supervision ani ownera innego niż drained. Takie wejścia są odrzucane.
Nie jest dowodem zakończenia dyspersji, renderowania modu ani zbieżności.
