# B-04 — właściciel pola wymiany FDM CPU

Data: 03.10.2026. Zakres: B-CORE/B-FDM, mechaniczna ekstrakcja istniejącej
realizacji `CpuReference`. Baza: `b8d6cfc2725427bf6c49b016a7583cb0918d7be1`.

## Zakres

Istniejące cztery metody pola wymiany przeniesiono do
`crates/fullmag-engine/src/fdm/cpu/fields/exchange.rs`:

- `cell_exchange_field`;
- `exchange_field_from_vectors`;
- `exchange_field_add_into`;
- `exchange_field_add_into_soa`.

Sygnatury, widoczność `pub(crate)`, ciała i istniejące komentarze metod
pozostają bez zmian. `cell_exchange_field` pozostaje helperem rodziny exchange
z zachowaną widocznością crate; warianty allocating, AoS in-place i SoA
pozostają jedną rodziną realizacji exchange. Nie zmieniono wzoru, współczynników, masek aktywności,
warunków brzegowych ani ścieżki fused local terms.

`fields.rs` zachowuje orkiestrację i dotychczasowe wywołania. Konsumenci
pozostają bez zmian:

- `src/fdm/cpu/fields/energy.rs` — `exchange_field_add_into_soa` oraz
  `exchange_field_from_vectors`;
- `src/fdm/cpu/fields/observables.rs` — `exchange_field_from_vectors`;
- `src/fdm/cpu/integrators.rs` — `exchange_field_add_into_soa`;
- `src/fdm/shared/problem.rs` — publiczne ścieżki `exchange_field` i energii;
- `src/fdm/cpu/fields.rs` — orkiestracja effective field, RHS i obserwabli.

Podobnie nazwane metody realizacji FEM, GPU oraz publiczny dispatch nie zostały
zmienione. Przyrost dotyczy obecnej Rustowej ścieżki `FdmEngine::CpuReference`;
nie jest awansem do native FDM CPU ani dowodem parytetu CPU/GPU.

## Bramka ownership

Dodano test źródłowy
`fdm_cpu_exchange_field_has_one_realization_owner` w
`crates/fullmag-engine/tests/fdm_source_layout_contract.rs`. Sprawdza on:

- rejestrację `fields/exchange.rs` w `fields.rs`;
- dokładnie jedną definicję każdej z czterech metod w nowym ownerze;
- brak definicji tych metod w pliku orkiestracji;
- obecność wszystkich istotnych konsumentów i ich wywołań.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Porównanie czterech sygnatur i ciał z bazowym HEAD | PASS; identyczność po normalizacji końców linii |
| Pozostały `fields.rs` | PASS; wiring i usunięcie czterech definicji; istniejący obcy reflow importu zachowany |
| Hash nowego ownera | `62acfe86256ebff3a0972578afadfe9baee4732cb2279e7028cb1d928e3a6477` |
| Rustfmt ownera | PASS, exit 0 |
| Rustfmt kontraktu layoutu | PASS, exit 0 |
| `git diff --check` dla zakresu | PASS, exit 0 |
| Niezależny review zamrożonego przyrostu | PASS, bez P0/P1; importy, cfg parallel, visibility i konsumenci zachowane |
| Porównanie pozostałego rodzica przez root | PASS; tylko wiring, usunięcie czterech metod i odstępy; obcy reflow wyłączony ze stagingu |
| Kompilacja i test layoutu | NOT COMPILED / NOT RUN zgodnie z aktualnym zakazem |
| Produkcyjny build tego źródła | NOT VERIFIED; istniejący queued build 218 ma wcześniejszy commit B-03 i nie obejmuje B-04 |
| Runtime, walidacja fizyki, parity CPU/GPU | NOT VERIFIED |

Nie dodano ani nie zmieniono noty naukowej: ten przyrost nie zmienia równań,
jednostek, parametrów ani semantyki backendu. Istniejące kontrakty wymiany i
bramki kwalifikacyjne pozostają wymagane przed jakimkolwiek twierdzeniem o
poprawności numerycznej lub produkcyjnej.

Przyrost źródłowy nie awansuje procentów strumienia B ani całego planu.
Po odblokowaniu storage trzeba odebrać wynik istniejącego buildu 218,
a ten późniejszy przyrost objąć następnym spójnym buildem na pełnym SHA.
