# ADR 0025: Trwały runtime i źródła obserwacji

- Status: accepted
- Data: 2026-08-18
- Decydenci: Fullmag core
- Powiązana nota: `docs/physics/interactive-observation-and-restart-semantics.md`

## Kontekst

Kończenie stage nie może niszczyć kosztownych operatorów ani uzależniać
dostępności quantity od eager terminalnego batchu. Historyczna ramka autosave
jest potrzebna do obserwacji, lecz wgranie jej do aktywnego solvera nie odtwarza
atomowo zegara, integratora, RNG i układów sprzężonych. Publiczny kontrakt musi
zachować jeden `ProblemIR`, jawny requested/resolved execution, HTTP v2 jako
źródło prawdy i osobne realizacje backendów.

## Decyzja

### D-01. Rezydentny `LiveRuntime`

`LiveRuntime` pozostaje rezydentny do jawnego close, udanego atomowego swapu,
fatalnego `failed_unusable` albo końca procesu. Brak pamięci jest typed error;
nie uruchamia eviction, zmiany precyzji ani fallbacku CPU.

### D-02. Źródła prawdy i ograniczona historia w pamięci

RAM/VRAM trzyma accepted primary state, plan, domenę, materiały,
operatory/workspaces i wszystkie policzone quantity bieżącego źródła. Pełna
historia autosave pozostaje dyskowa; `ObservationRuntime` trzyma jedną wybraną
ramkę i jej policzone quantity. Cache sampling/presentation jest osobny.

### D-03. Izolowany `ObservationRuntime`

Historyczne compute używa oddzielnego `ObservationRuntime` bez API
step/run/relax/resume i bez live publishera. Nigdy nie swapuje ani tymczasowo
nie mutuje `LiveRuntime`.

(accepted-state-identity)=
### D-04. Kanoniczny `AcceptedStateRef`

`AcceptedStateId` jest trwałym, content-bound digestem wersji, kanonicznego
`ObservationClock`, `ProblemIR`, planu, domeny i pierwotnych nośników. Clock
jest częścią digestu. `AcceptedStateGeneration` jest lokalnym guardem epoki i
rewizji. `AcceptedStateRef` zawsze łączy oba pojęcia dla live source.

### D-05. Jedno `ComputeQuantities`

Jedna operacja materializuje pełne kanoniczne pola i skalary on-demand dla
`ObservationSource` i listy `quantity_ids`. `ComputeFields` oraz
`ComputeEnergies` mogą być przejściowymi aliasami, ale nie osobnymi ownerami
fizyki ani cache. Cache prezentacji/samplingu jest pochodny i osobny.

### D-06. Autosave frame nie jest resume checkpointem

Ramka jest immutable observation source. Wybór ramki nie cofa symulacji.
`LogicalResume` z ramki może zbudować nową gałąź z jawną utratą stanu
algorytmicznego; `ExactResume` wymaga pełnego checkpointu wszystkich nośników.

### D-07. Jawne i transakcyjne `.fms`

`.fms` powstaje wyłącznie po Save, Save As albo Export. Import najpierw
waliduje integralność i buduje kandydacki runtime, a następnie wykonuje dokładnie
jeden atomowy swap. Porażka pozostawia aktywną sesję bez zmian.

### D-08. Fail-closed zamiast rekonstrukcji

Brak primary carriera daje `unsupported_missing_primary_state` z listą braków,
nigdy przybliżenie ani zero. Dotyczy to między innymi RNG/thermal,
charge/spin, dynamicznego Oersteda i nośników mechanicznych.

## Konsekwencje i obowiązki implementacyjne

- FDM/FEM oraz CPU/GPU mają jeden neutralny kontrakt i osobne realizacje.
- Nie powstaje silent fallback ani nowy owner fizyki w `Context`,
  `mfem_bridge.cpp`, runnerowym `dispatch.rs` lub ogólnym `execute.rs`.
- HTTP v2 pozostaje truth; WebSocket tylko invaliduje; istnieje jeden field
  data plane.
- Availability zależy od katalogu, fizyki, planu, lane'u i primary carriers,
  nie od materialization/cache.
- Source presence, executability, validation i production qualification są
  raportowane osobno. Task 0 nie promuje żadnej capability.

## Odrzucone alternatywy

### Swap live state na czas historycznego compute

Odrzucone: nie odtwarza atomowo integratora, FSAL/ABM, RNG, transportu,
preconditionerów i rewizji; błąd pośredni może skazić aktywną sesję.

### Odbudowa runtime per kliknięcie

Odrzucone: niszczy rezydencję operatorów/workspaces, zwiększa latency i tworzy
drugą ścieżkę wyboru backendu mogącą wprowadzić fallback lub inną precyzję.

### Eager terminal-all-fields

Odrzucone jako reguła normatywna: mnoży pamięć i czas, miesza capability z
cache i nie rozwiązuje obserwacji `pause`, `stop` ani ramki historycznej.

## Migracja i rollback

Najpierw wprowadza się typy identity/source i read-only materializer, następnie
autosave descriptors, zasoby HTTP v2 i transakcyjne `.fms`. Stare komendy są
aliasami wyłącznie do czasu migracji wszystkich klientów; kryterium usunięcia
to brak konsumentów oraz przejście contract guards. Rollback implementacji nie
może przywrócić eager terminal-all-fields jako kontraktu ani historycznego
swapu `LiveRuntime`.

## Testy i walidacja

Gate źródłowy wymaga pięciu definicji i braku starej reguły eager. Dalsze testy
muszą dowieść zerowej mutacji live state, atomowości batchu i importu, czasu
ramki, typed missing-carrier, cache isolation oraz osobnych receipts dla FDM
CPU/GPU i FEM CPU/GPU. GPU proof musi podać device identity i zero fallbacku.
