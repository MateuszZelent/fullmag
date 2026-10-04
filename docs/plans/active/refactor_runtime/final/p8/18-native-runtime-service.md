# P7-C / P8 — niezależny proces natywnego runtime

Data: 03.10.2026. Source increment; runtime i produkt Windows NOT VERIFIED.

## Zaimplementowano w źródłach

| Obszar | Wynik |
|---|---|
| Proces | Nowy fullmag-runtime-service, bez zależności od UI i konsoli Windows. |
| Owner | Native File::try_lock na stabilnym OWNER.lock, jeden właściciel całego SessionStore; descriptor z instancją/procesem, targetem, buildem, pulami, generacjami i dziećmi. |
| Startup | Konfiguracja jawnych zasobów, istniejące publikatory, gated start obu schedulerów; potwierdzenie build/owner/PID/roli przed admission, następnie ready z generacją puli. |
| Source identity | Publishery, schedulery, worker i preparer odrzucają niezgodny commit/snapshot przed otwarciem store. |
| Sterowanie | Prywatny loopback TCP z wersją i tokenem ownera; drain obu admissions przed oczekiwaniem na procesy. |
| Błędy | Deadline publishera/drain daje unknown z zachowanym PID/lease; drugi scheduler drenuje przy awarii pierwszego. Brak PID/age takeover. |
| Recovery | Prep ready nie zależy od wolnego slotu podczas recovery; wcześniejszy nonterminal owner nadal wymaga kontrolowanego odzyskania. |
| Storage | Operational owner/logs nie są korzeniami CAS ani eksportem FMS; import nadal wymaga pustego staging store. |
| Pakowanie | Bin w Cargo, Makefile install, portable bundle/loader validation, MSI i wymaganym inventory managed receipt. |

Kontrakt: [spec v1](../../../../../specs/native-runtime-service-v1.md),
[ADR 0049](../../../../../adr/0049-native-runtime-owner-control.md).
Budżety są deklaracją operatora, nie syntetycznym wykryciem sprzętu.

## Dowody

- 49 lekkich, interpretowanych testów pakowania PASS, w tym brak/pusty bin usługi.
- Parser 12 zmienianych plików Rust PASS; metadata Cargo offline/locked PASS.
- Parser PowerShell MSI PASS; kontrola lokalnych linków ADR/spec PASS.
- Regresje Rust zapisano dla owner lock/recovery/stanu, source mismatch,
  control version/token, konfiguracji i procesu ignorującego drain oraz GC preview.
  Nie kompilowano ani nie uruchomiono unit tests zgodnie z zakazem operatora.
- Review wykrył i doprowadził do poprawy deadline, prep readiness i częściowych
  generacji. Terminalne pule wymagają pełnej zgodności po drain pod blokadą
  writer/CAS; nieznana obserwacja procesu nie udaje running. Końcowy scoped
  review po poprawkach: brak P0/P1 na poziomie analizy źródeł.
  Scoped staged diff/parser PASS; bez cudzych zmian formatowania.

To nie jest dowód typecheck, procesu, Windows Job API, wykonania solvera ani
kwalifikacji naukowej. Starszy queued build 212 nie zawiera tej implementacji.

## Następne obowiązki pełnego planu

Dołączyć klienta lifecycle/discovery do launchera i UI: native service pozostaje
procesem niezależnym, API adapterem, a UI klientem attach/detach. Wykonać bramki
version mismatch, reconnect/orphan, service crash, drain, restart oraz prawdziwe
obliczenie przy zamkniętym UI. Kontrolowane recovery nonterminal ownera i retencja
logów są nadal otwarte. Nie zwiększono procentów całego planu.

Nie zatrzymano instancji 3104 ani innych aktywnych zasobów; nie zmieniono
konfiguracji wolumenów Docker ani cudzych zmian źródeł.
