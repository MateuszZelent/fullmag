# T11 — kontrola sumy payloadów i rezerwacji dekodowania

Przyrost źródłowy względem `1baeb2f7d3a094eb3d6689085c9f880733b31636`.
Nie zmienia fizyki, Python DSL, ProblemIR ani formatu artefaktów.

## Granice implementacji

`crates/fullmag-runner/src/antenna_field_solution.rs::antenna_field_solution_payload_lengths`
sprawdza przez `checked_add` sumę długości manifestu i wszystkich unikalnych,
zadeklarowanych payloadów. Odmowa przepełnienia następuje przed pierwszym
odczytem payloadu w
`crates/fullmag-runner/src/antenna_stage.rs::load_published_antenna_field_solution_checked`.
Ten sam rachunek obowiązuje w verifierze danych już znajdujących się w pamięci.

`crates/fullmag-runner/src/antenna_field_solution.rs::decode_xyz_f64_le`
i `decode_tet4_u32_le` rezerwują przez `try_reserve_exact`; błąd rezerwacji
staje się `RunError`. Kontrole długości, skończoności i indeksów pozostają
bez zmian. Nie jest to zabezpieczenie przed systemowym overcommit ani OOM kill.

Rachunek obejmuje zapisane bajty, nie peak RAM. Nie obejmuje pojemności
alokatora, map/metadanych, dodatkowych dekodowanych kopii, projekcji ani solvera.
Nie stanowi limitu przyjęcia zadania. Nie narzuca limitu targetów direct-v3
operatorowi vector-potential i nie zmniejsza rozdzielczości.

`crates/fullmag-ir/src/compute_resources.rs::MemoryReservationIR` oraz
`crates/fullmag-application/src/run_spec.rs::RequestedExecution::validate_problem_resources`
opisują minimalną rezerwację/admission; `reservation_bytes` nie jest limitem RAM.
Pełny T11 wymaga jawnego właściciela enforcement i przekazania budżetu do solve
oraz cold-load. Nie wolno uznać tego checkpointu za zamknięcie tej bramki.

## Weryfikacja i następny krok

- Kontrola diff i parser Rust: PASS; nie są dowodem typecheck ani wykonania.
- Niezależny przegląd pełnego diffu i istotnych konsumentów: brak wskazanego
  blokera źródłowego; potwierdzono odmowę przed odczytem i trafienie regresji
  w nową gałąź przepełnienia. To nie jest review całego modułu.
- Dodano regresje `read_plan_refuses_aggregate_overflow_with_valid_individual_lengths`
  i `decoded_buffers_preserve_values_and_validation`. Pierwsza wymaga odmowy,
  mimo że każda długość osobno mieści się w granicy pojedynczej alokacji.
- Regresje Rust nie zostały skompilowane ani uruchomione: obowiązuje zakaz
  kompilacji testów. RED/GREEN i produkcyjny build pozostają NOT VERIFIED.
- Nie zamykano ani nie restartowano aktywnej sesji. Kwalifikacja FDM CPU,
  FDM GPU, FEM CPU i FEM GPU nie zmienia się na podstawie kontroli źródeł.

Następne bramki: wspólny kontrakt twardego budżetu RAM, blokowanie targetów,
pomiar peak memory, anulowania i globalnego kosztu; wykonanie regresji po
odwołaniu zakazu oraz managed runtime i naukowe testy T00–T18.
