# Audyt cyklu życia benchmarku dyspersji — 2026-09-19

## Zakres i dowody

Audyt obejmuje `scripts/run_comsol_dispersion_benchmark.py` oraz
`scripts/test_run_comsol_dispersion_benchmark.py` w worktree
`C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`. Nie zatrzymuję ani
nie usuwam działających kontenerów; ich obsługa pozostaje po stronie koordynatora
zadania.

Zaobserwowany błąd jest potwierdzony: `_execute()` wywołuje `subprocess.run()` z
`timeout=...` na kliencie `docker compose`. `subprocess.TimeoutExpired` ustawia
`timed_out=True`, ale nie inspekcjonuje ani nie zatrzymuje kontenera utworzonego
przez `compose run`. Klient Compose może zostać zakończony, podczas gdy solver i
kontener nadal pracują. W efekcie nie ma `run-result.json`, proces może zużywać
CPU/RAM po zakończeniu procesu hosta, a wynik nie ma terminalnego stanu.

## Ustalenia

1. **P1 — brak tożsamości kontenera benchmarku.** Polecenie nie używa własnego
   `--name` ani etykiet. Cleanup nie może więc bezpiecznie odróżnić tego
   kontenera od innego uruchomienia Compose.

2. **P1 — timeout jest wyłącznie hostowy.** Limit nie jest przekazany do
   procesu w kontenerze. `subprocess.run()` może przerwać klienta, ale nie
   gwarantuje zakończenia procesu solvera ani usunięcia kontenera.

3. **P1 — brak ścieżki cleanup po przerwaniu.** `TimeoutExpired`,
   `KeyboardInterrupt` i przerwanie/OSError nie zapisują terminalnego receipt i
   nie wykonują fail-closed inspekcji własnego kontenera. `--rm` pomaga tylko po
   normalnym zakończeniu Compose.

4. **P1 — brak dowodu bezpiecznego usunięcia.** Samo wyszukanie po nazwie,
   wiek kontenera albo brak wyniku nie może uprawniać do `stop`/`rm`. Przed
   mutacją trzeba potwierdzić exact container ID, własną etykietę, obraz oraz
   komplet trzech mountów: source capsule, runtime i output tego runu.

5. **P1 — receipt może nie powstać.** `_execute()` zapisuje `run-result.json`
   dopiero po powrocie z `subprocess.run()`. Wyjątek lub przerwanie procesu
   omija ten zapis, więc downstream nie może odróżnić failed od nadal żywego
   wykonania.

6. **P1 — lease storage nie obejmuje benchmarku.** `main()` trzyma tylko
   `fullmag_storage.build_lock()`. Nie używa `managed_heavy_lock()`, a ten
   mechanizm nie zna kontenerów benchmarku. Po timeout hostowy lock plikowy może
   się zwolnić mimo żywego kontenera. Zmiana lokalna powinna zapisać stan
   `cleanup=blocked` i nie zgłaszać sukcesu; pełna integracja z globalnym
   heavy-lease wymaga osobnego kontraktu storage/runnera i nie może być udawana
   przez `run-result.json`.

## Plan minimalnej naprawy

- Nadać każdemu runowi deterministycznie unikalną nazwę na podstawie job/run
  identity oraz etykiety `com.fullmag...` zawierające job ID i run ID.
- Przekazać limit do kontenera przez GNU `timeout` obejmujący cały skrypt
  przypadków, z krótkim grace period dla SIGTERM. Host otrzyma limit plus grace,
  aby normalnie odebrać terminalny exit Compose.
- Po `TimeoutExpired`, `KeyboardInterrupt` lub `OSError` wykonać tylko
  best-effort, fail-closed reconciliation: `docker inspect` po exact name,
  potwierdzenie ID/label/image/mountów, następnie `stop` i `rm` po exact ID.
  Przy każdej niepewności pozostawić kontener oraz zapisać
  `cleanup.status=blocked` z powodem.
- Zapisywać `run-result.json` w jednej ścieżce `finally`, z terminalnym stanem
  `failed` oraz polami timeout/cleanup. Status `completed_*` będzie możliwy
  wyłącznie po normalnym zakończeniu i walidacji artefaktów.
- Dodać lekkie testy komendy, limitu wewnątrz kontenera, tożsamości mountów,
  cleanupu po timeout oraz blokady cleanupu przy obcej tożsamości. Testy nie
  budują native targetów i nie dotykają Docker daemon.

## Ograniczenia

Naprawa chroni lifecycle tego orchestratora. Nie rozstrzyga już osieroconych
kontenerów z wcześniejszych runów i nie zwalnia automatycznie kolejki
`runner-jobs.sqlite`; takie kontenery wymagają exact-container reconciliation
przez koordynatora. Globalny heavy lease pozostaje osobnym kontraktem i powinien
być rozszerzony dopiero po uzgodnieniu właściciela durable lease.

## Stan po naprawie

W `run_comsol_dispersion_benchmark.py` dodano:

- unikalną nazwę oraz etykiety `com.fullmag.*` dla każdego kontenera;
- timeout GNU `timeout` wewnątrz kontenera dla całego benchmarku, z osobnym
  marginesem na SIGTERM i cleanup Compose;
- hostowy watchdog ustawiony poza limitem kontenera;
- fail-closed `docker container inspect` sprawdzający exact name, pełne ID,
  etykiety, pinned image oraz dokładny zestaw trzech mountów;
- `stop` i `rm` wyłącznie po zweryfikowanym pełnym ID, z końcową kontrolą
  nieobecności kontenera;
- zapis terminalnego `run-result.json` także po timeout, `KeyboardInterrupt` i
  błędzie startu, z polami `execution_error`, `container_timed_out`,
  `interrupted` i `cleanup.status`.

Dodano testy regresyjne dla komendy Compose, wewnętrznego timeoutu, cleanupu
własnego kontenera, blokady przy obcych etykietach oraz terminalnego receipt po
`TimeoutExpired`. `python -m unittest scripts.test_run_comsol_dispersion_benchmark`
przechodzi: **14 testów**. Nie uruchamiano kompilacji natywnej ani nie zmieniano
historycznych `run-result.json`.

Globalny `fullmag-heavy.lock` nadal nie jest durable lease tego orchestratora.
Po skutecznym cleanupie blokada plikowa wraca do systemu przez zwykły kontekst
Python; przy `cleanup.status=blocked` wynik pozostaje `failed`, a kontener nie
jest uznawany za bezpiecznie usunięty. Reconciliation osieroconych kontenerów
runnera musi nadal wykonać koordynator po exact container ID.
