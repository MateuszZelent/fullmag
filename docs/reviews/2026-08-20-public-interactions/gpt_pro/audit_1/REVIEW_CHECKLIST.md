# Checklist review i promocji capability

## PR implementacyjny

- [ ] PR wskazuje dokładny identyfikator remediacji.
- [ ] Dodano test odtwarzający błąd przed poprawką.
- [ ] Zmiana ma jawny owner danych i revision/invalidation policy.
- [ ] Nie dodano silent fallbacku.
- [ ] Typed errors odróżniają unsupported, numerical failure, convergence failure, interrupt i OOM.
- [ ] Rejected/failure path nie commitują authoritative state.
- [ ] Publiczny requested plan rzeczywiście dociera do zmienionego kodu.
- [ ] Zaktualizowano C ABI/Rust FFI/schema, jeśli dotyczy.
- [ ] Zaktualizowano checkpoint schema i migrację, jeśli dotyczy.
- [ ] Zaktualizowano publiczną dokumentację statusu capability.

## Poprawność fizyczna i numeryczna

- [ ] Jednostki `H`, `gamma`, `mu0`, energy i torque są jawne.
- [ ] Directional derivative przechodzi dla członów konserwatywnych.
- [ ] `|m|`, phase error i damping-energy law są sprawdzone.
- [ ] Boundary/interface/PBC/Airbox semantics są objęte fixture.
- [ ] Adaptive accept/reject ma bounded progress i `dt_min_exhausted`.
- [ ] Termiczny RNG ma deterministyczny accepted-interval contract.
- [ ] CPU/GPU lub AoS/SoA parity obejmuje field, RHS, stage, step i trajectory.
- [ ] Temporal/spatial order jest zmierzony, nie założony.

## Wydajność

- [ ] Setup i steady-state są raportowane oddzielnie.
- [ ] Brak dynamicznych alokacji/assembly/plan creation w hot loop albo istnieje zaakceptowany budżet.
- [ ] Operator evaluation counts odpowiadają tableau i output schedule.
- [ ] GPU transfer/sync audit nie wykazuje pełnych round-tripów strict lane.
- [ ] Preconditioner location i rebuild count są jawne.
- [ ] Benchmark używa tej samej fizyki oraz końcowego błędu.
- [ ] Wynik zawiera hardware, driver, toolkit, thread policy i precision policy.

## Promocja

- [ ] Wszystkie kryteria z pliku findingu są zaznaczone.
- [ ] Qualification registry podaje dokładną macierz wspieranych kombinacji.
- [ ] Brakujące kombinacje są fail-closed.
- [ ] Stara realizacja jest usunięta albo jawnie oznaczona jako `legacy`.
- [ ] Artefakty CI i benchmarków są trwałe i możliwe do ponownego odtworzenia.
