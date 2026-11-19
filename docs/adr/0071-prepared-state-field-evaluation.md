# ADR 0071: Ewaluacja pól przygotowanego stanu przed pierwszym biegiem

- Status: proposed
- Date: 2026-10-27
- Relates: ADR 0004 (kanoniczne wielkości), ADR 0025 (trwały runtime), ADR 0035 (granica workera),
  ADR 0061 (Docker DEV), ADR 0067 (izolacja grup DEV), audyt
  `docs/audits/2026-10-26-quantity-availability-audit.md` (P2)

## Context

W Docker DEV komenda `compute_fields` jedynie adoptuje pakiet `accepted_quantity_bundle.v1`,
który worker publikuje po zakończonym biegu
(`accepted_field_materialization::adopt_current_bundle`). Przed pierwszym biegiem sesji
interaktywnej Study ma jeden RunIntent ze wstrzymaną bramką Compute
(`fullmag.accepted_run_start`, `mode: manual`). Scheduler nie kolejkuje ani nie zawłaszcza
zadań takiego biegu, więc nie istnieje proces z przydziałem zasobów, który policzyłby
`H_eff`, `torque`, `eden_*` czy `mat_*` dla przygotowanego `m`. Katalog raportuje je dziś jako
`accepted_state_required`, a UI pokazuje je jako wyłączone „(after Run)”.

Rdzeń obliczeń już istnieje: `fullmag_runner::materialize_accepted_observables` liczy wszystkie
aktywne pola i energie dla dokładnego toru (FDM CPU/CUDA, FDM multilayer, FEM CPU/GPU) bez
całkowania. Jest jednak związany z tożsamością zaakceptowanego stanu (`AcceptedStateRef`,
digest zegara i planu, provenance silnika), a na torach GPU tworzy backend na urządzeniu.
Dlatego:

- API nie może go wywołać we własnym procesie: ominęłoby lease, ledger grupy i budżet GPU;
- nie wolno podrabiać `AcceptedStateRef` dla stanu, który nie pochodzi z biegu;
- zwolnienie bramki Compute nie jest akceptowalnym obejściem (uruchamia Study).

Rozważone i odrzucone warianty: osobny RunIntent „ewaluacyjny” (narusza zasadę jednego
wstrzymanego RunIntent na sesję interaktywną, konkuruje z nim o urządzenie, zmienia projekcję
biegu w UI) oraz nowy rodzaj kroku Study (wymaga wyjątku od bramki startu per rodzaj kroku,
syntetycznego stanu zaakceptowanego i nie da się go dodać do już zatwierdzonego RunIntent).

## Decision

### 1. Żądanie ewaluacji jest trwałe i związane z pierwszym zadaniem wstrzymanego biegu

Gdy bieżący bieg ma wstrzymaną bramkę Compute, a pierwsze zadanie ma gotowe przygotowanie,
API zapisuje w session store niezmienny rekord `prepared_evaluation_request.v1`
(`runs/<run_id>/prepared_evaluations/<request_id>.json`), wiążący:
`run_id`, `task_id`, `step_id`, identyfikator i digest receiptu przygotowania, `plan_fingerprint`,
tożsamość wejścia wykonania (`live_execution_binding`), żądany tor (`backend`, `device`,
`precision`) oraz digest przygotowanego `m`. Żądanie nie zmienia RunIntent, katalogu zadań ani
bramki startu. Jedno aktywne żądanie na bieg; powtórzone `compute_fields` dla tej samej
tożsamości jest idempotentne.

### 2. Osobny tor przyjęcia: lease ewaluacji z urządzeniem zgodnym z planem

Wprowadzamy `FmsEvaluationResourceLease` (schema `fms_evaluation_resource_lease.v1`), wzorowany na
`FmsPreparationResourceLease`, ale z rodzajem zasobu CPU albo GPU równym torowi zadania i budżetem
VRAM wyliczonym tak jak dla jego leasu solvera. Rezerwacja przechodzi przez ledger grupy
(`group-ledger-v1`) tym samym `HostReservationRequest`; walidacja dopuszcza GPU tylko dla leasu
ewaluacji, nie dla przygotowania. Przyjmuje go scheduler ewaluacji działający w tym samym
procesie usługi runtime co scheduler przygotowania (osobna pula `evaluation`, współbieżność 1
na bieg). Zwolnienie bramki Compute czeka, aż aktywny lease ewaluacji tego biegu zostanie
zwolniony; ewaluacja nigdy nie blokuje Stop.

### 3. Jednorazowy proces ewaluatora pod nadzorem

Supervisor uruchamia proces `fullmag-accepted-evaluator` (wzór: `accepted_fem_preparer`), z
limitem czasu, heartbeat i diagnostyką stderr. Proces czyta z CAS rozwiązane wejście zadania,
receipt przygotowania (dla FEM: przestrzeń siatki) i przygotowane `m`, po czym wywołuje nowy
punkt wejścia runnera `materialize_prepared_observables`. Funkcja dzieli rdzeń per tor z
`materialize_accepted_observables`, ale przyjmuje tożsamość przygotowania zamiast
`AcceptedStateRef` i nie wymaga provenance silnika na `m` (to stan wejściowy, nie wynik).
Zegar obserwacji to krok 0 i `time_stage.start_time_s`. Brak CUDA na torze GPU kończy się
jawnym błędem; nie ma przejścia na CPU. Plany, których ewaluator nie obsługuje (thermal,
transport, antena, frozen spins, napęd pola na GPU), kończą się wynikiem `unsupported` z
powodem.

### 4. Wynik: niezmienny pakiet związany z przygotowaniem

Proces publikuje w CAS `prepared_quantity_bundle.v1`: pola (te same nośniki i układ co w
`accepted_quantity_bundle`, binarne F64LE), energie globalne, `unavailable_scopes`, tor,
precyzję, tożsamość build ewaluatora oraz pełną tożsamość z pkt 1. Wpis katalogu artefaktów
(`artifact_type: prepared_quantity_bundle`) jest związany z leasem ewaluacji, nie z próbą
zadania. Zadanie i jego cykl życia pozostają bez zmian.

### 5. Adopcja w API i katalog

Projektor biegu adoptuje pakiet do `latest_fields` tylko wtedy, gdy wyświetlane `m` jest nadal
przygotowanym stanem o tym samym `preparation_id`, `plan_fingerprint` i digeście wartości, a
scena i wejście wykonania się nie zmieniły. Provenance pól: `source: prepared_state_evaluation`.
Każda zmiana sceny, przygotowania albo start biegu unieważnia pakiet (zostaje w CAS, ale nie jest
adoptowany). Katalog przed pierwszym biegiem: `materializable=true`, stan `pending` podczas
aktywnego żądania, `complete` po adopcji, `error` z kodem przyczyny po porażce;
`accepted_state_required` pozostaje tylko tam, gdzie tor nie ma ewaluacji. Frontend opiera
odświeżenie na rewizji pól, a nie na 5-sekundowym limicie odpytywania.

### 6. Odzyskiwanie

Lease bez heartbeat wygasa i jest zwalniany przez scheduler ewaluacji tak jak lease
przygotowania. Żądanie ma ograniczoną liczbę prób; porażka zapisuje terminalny wynik z
powodem. Opublikowany pakiet nigdy nie jest liczony ponownie. Usunięcie danych podlega
istniejącej retencji runów.

## Consequences

- Pola dostępne przed pierwszym biegiem na wszystkich czterech torach, liczone na tym samym
  urządzeniu i w tej samej precyzji co bieg, z uczciwym provenance.
- Trzeci tor przyjęcia (obok solvera i przygotowania) z własnym leasem, schedulerem,
  supervisorem i procesem; rozszerzenie ledgera o GPU dla leasu innego niż zadanie.
- Bramka Compute i cykl życia zadań pozostają nienaruszone.
- Fizyka i katalog wielkości się nie zmieniają; brak nowej noty w `docs/physics/`.

## Wymagane dowody przed `accepted`

1. Grupa Docker DEV: przygotowana sesja FEM CPU i FDM CPU przed Run — Compute Fields
   publikuje `H_eff`, `torque`, `eden_total`; widoczne w viewport (dowód z przeglądarki).
2. Tor GPU (FEM GPU lub FDM CUDA): ewaluacja na GPU z leasem GPU w ledgerze; brak CUDA → jawny
   błąd, nie CPU.
3. Zmiana sceny po ewaluacji → pakiet nie jest adoptowany; Run po ewaluacji startuje normalnie.
4. Restart backendu w trakcie ewaluacji → lease wygasa, żądanie kończy się terminalnie lub
   jest ponowione w limicie; brak osieroconej rezerwacji w ledgerze.

## Plan wdrożenia (etapy, każdy osobnym commitem)

1. Runner: `materialize_prepared_observables` ze wspólnym rdzeniem per tor.
2. Session store: typy i ścieżki żądania, leasu ewaluacji, pakietu; ledger: rezerwacja GPU dla
   leasu ewaluacji.
3. Scheduler + supervisor + binarka `fullmag-accepted-evaluator`; podpięcie w usłudze runtime
   Docker.
4. API: `compute_fields` przed pierwszym biegiem → żądanie; adopcja w projektorze; katalog.
5. Frontend: stany `pending`/`error`, odświeżenie po rewizji, usunięcie „(after Run)” tam, gdzie
   ewaluacja jest dostępna.
6. Weryfikacja w Docker DEV według sekcji dowodów.

## Rewizja 27.10.2026: wdrożenie v1 w przygotowaniu FEM

Inwentaryzacja pokazała, że osobny tor przyjęcia (sekcje 1–3, 6) wymaga zmian w około stu
miejscach Rust (session store, archiwum i reachability, ledger hosta z dowodami zwolnienia i
bramkami uruchomienia, usługa runtime, API przydziałów) oraz w kilkunastu skryptach launchera,
które zakładają dokładnie dwie role potomne `{compute, preparation}`, a także nowego podziału
budżetu CPU/pamięci grupy Docker. Decyzja użytkownika: v1 nie tworzy nowego toru.

**v1 (obowiązuje):**

1. Ewaluację wykonuje istniejący preparer FEM (`accepted_fem_preparer`) pod swoim leasem
   przygotowania CPU, w tym samym procesie co przygotowanie przestrzeni siatki. Nie ma osobnego
   żądania `compute_fields`: pola przygotowanego stanu powstają automatycznie razem z receiptem
   przygotowania zadania FEM.
2. Ewaluator: `materialize_prepared_observables` na torze `fem_cpu`, dla planu osadzonego w
   receipcie przygotowania (ten sam `plan_fingerprint`, który API publikuje dla przygotowanego
   `m`). Dla planu o żądanym torze GPU obliczenie przebiega na CPU i provenance zapisuje oba tory
   (`evaluation_lane: fem_cpu`, `requested_lane: fem_gpu`). To jawna ewaluacja obserwacji stanu
   wejściowego, nie wykonanie Study: bieg nadal startuje na żądanym urządzeniu i nie ma cichego
   przejścia na CPU dla solvera.
3. Wynik: niezmienny rekord `fms_task_prepared_observation.v1` w
   `runs/<run>/task_prepared_observations/<task>.json`, związany z aktywnym leasem przygotowania,
   z tożsamością (`preparation_id`, `plan_fingerprint`, digest przygotowanego `m`) i odwołaniami
   do obiektów CAS (opis pakietu + binarne fragmenty F64LE pól). Reachability traktuje te obiekty
   jako osiągalne. Porażka ewaluacji albo przekroczenie budżetu zapisuje wynik `unavailable` z
   powodem i nie zmienia wyniku przygotowania.
4. Adopcja: API publikuje pola razem z przygotowanym `m` tylko przy zgodności `preparation_id`,
   `plan_fingerprint` i digestu wartości `m`; provenance `source: prepared_state_evaluation`.
   Brak rekordu lub `unavailable` pozostawia stan `accepted_state_required` („after Run”).
5. FDM nie ma toru przygotowania z leasem; FDM i FEM GPU na urządzeniu pozostają „after Run”
   do czasu osobnej decyzji o torze ewaluacji (sekcje 1–3 pozostają kierunkiem docelowym).

Wymagane dowody v1: przygotowana sesja FEM CPU w Docker DEV pokazuje przed Run `H_eff`,
`torque` i `eden_total` w viewport; rekord jest osiągalny po GC; zmiana sceny nie adoptuje
starego pakietu.

### Dowody v1 (27.10.2026, grupa Docker DEV `prepared-fem-verify-20261027`, commit `6d9c238cb`)

- FEM CPU, sesja interaktywna przed Compute: rekord `task_prepared_observation.v1` w stanie
  `published` (10 obiektów CAS); katalog wielkości: `H_ex`, `H_demag`, `H_ext`, `H_eff`,
  `torque`, `eden_ex`, `eden_demag`, `eden_ext`, `eden_total` w stanie `complete` (krok 0),
  `/data/fields/torque/meta` z fizycznymi statystykami (|τ| 0,04–6,56 T dla losowego `m`).
  Menu Coloring w Control Room oferuje te dziesięć wielkości jako aktywne.
- FDM CPU po 4 krokach (ścieżka pakietu końcowego przez wspólny rdzeń ewaluatora): 18 wielkości
  `complete`, w tym `E_*` i `mat_*`.
- NOT VERIFIED: kolorowanie obiektu w viewport wybraną wielkością (żądanie zakresu `part`
  zwraca 404 „mesh part not found” także dla `m` — osobny problem viewportu); energie globalne
  `E_*` przed Compute nie są jeszcze widoczne w katalogu (pakiet je zawiera); bieg FEM CPU w tej
  grupie kończył się `MPI_ABORT` przy starcie solvera niezależnie od ewaluacji (także gdy
  ewaluator nie doszedł do MFEM) — do osobnej diagnozy.
