# P3/P5 — atomowość komunikatów koordynatora

Data: 24.09.2026. Zakres: model aplikacyjny; bez transportu ani workera.

## Poprawki

`WorkerCoordinator::accept_event` aktualizował deduplikację/sekwencję przed
sprawdzeniem lifecycle. Przedwczesny `Progress` był odrzucany, ale późniejsze
poprawne `Started` z numerem 1 kończyło się `ProtocolOutOfOrder`.
Teraz protokół jest sprawdzany bez zapisu; nieudane zastosowanie zdarzenia
przywraca stan zadania, a ledger jest zatwierdzany dopiero po sukcesie.
Rollback kopiuje stan zadania, nie cały narastający rejestr komunikatów.

`emit` zwiększał licznik jeszcze przed przyjęciem komendy. Nieprawidłowy
`Stop` z pustym powodem tworzył lukę (kolejna komenda miała numer 3 zamiast 2).
Licznik jest teraz zatwierdzany dopiero po poprawnej walidacji i przyjęciu.

Faza `Released` została przemianowana na `ReleaseRequested`. Wysłanie
komendy nie jest dowodem zwolnienia CPU/GPU/VRAM ani durable lease.
Przegląd konsumentów nie wykazał użyć starego wariantu poza koordynatorem
i jego testem. Wire format `worker_protocol.v1` nie został zmieniony.

## Dowody

- Regresja zdarzenia przed poprawką: run `3c8d7a9cdc5d440c9fa1a671a9d0d06b`,
  oczekiwany błąd `ProtocolOutOfOrder { sequence: 1, last_sequence: 1 }`.
- Regresja komendy przed poprawką: run `dbedad5bd13342c2814dc11eb6800b62`,
  numer 3 zamiast wymaganego 2.
- Końcowe `just verify-project-application`: **38/38 PASS** — 19 testów
  biblioteki, 6 repository, 13 lifecycle; 0 doctestów.
- Run `cadc569917fd4027b8963bdb330078de`, exit 0,
  `source_changed_during_run=false`; source SHA-256
  `562ffcd76beefc1a2917b2c0bd40ccd7f80475d61f8676d92198c7564e4454ec`.
- Receipt i log: zarządzane storage,
  `builds/fullmag-0950f4dca4ffe38f/windows-application-test/project-application-test/cadc569917fd4027b8963bdb330078de/`.
- Kontrola diffu: PASS. Wszystkie uruchomione tu procesy testowe zakończone.

Pełny transport, supervisor, potwierdzenie fizycznego release i restart
aktywnego workera pozostają **NOT VERIFIED**. Ta poprawka nie kwalifikuje
P5 ani żadnej realizacji solvera.
