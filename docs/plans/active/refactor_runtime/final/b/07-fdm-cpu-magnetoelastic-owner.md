# B-07 — właściciel magnetoelastyczności FDM CPU

Data: 03.10.2026. Zakres: B-CORE/B-FDM, mechaniczna ekstrakcja istniejącej
realizacji `CpuReference`. Baza porównania: `29681cb395ea2b496c30f9f97c28e81d04b257da`.

## Zakres

Wyłącznie pięć nazwanych metod magnetoelastyczności przeniesiono do
`crates/fullmag-engine/src/fdm/cpu/fields/magnetoelastic.rs`:

- `magnetoelastic_field`;
- `magnetoelastic_energy`;
- `magnetoelastic_energy_soa`;
- `magnetoelastic_field_add_into_soa`;
- `magnetoelastic_field_add_into`.

Każdą metodę wyodrębniono niezależnie po jej deklaracji. Sygnatury,
widoczność `pub(crate)`, ciała, maskowanie aktywnych komórek, obsługa
`Uniform`/`PerCell`, kolejność operacji i istniejące wywołania biblioteki
magnetoelastycznej pozostają bez zmian. Nie zmieniono publicznego dispatchu,
lane `CpuReference`, FDM GPU ani realizacji FEM.

Moduł zarejestrowano jako `magnetoelastic_terms`, aby nie kolidował z
rodzicielskim `use crate::magnetoelastic;`. Import rodzica i istniejące granice
namespace pozostają zachowane; owner importuje crate'owy moduł
`magnetoelastic` bezpośrednio.

`fused_local_terms_add_into` pozostał całkowicie w `fields.rs`. Nie przenoszono
żadnych metod external field, regional drives ani SoA capability; ekstrakcja
nie używa zakresu obejmującego sąsiednie definicje.

## Konsumenci

Istniejące wywołania pozostają bez zmian:

- `src/fdm/cpu/fields/energy.rs:55,87` — energia SoA i AoS;
- `src/fdm/cpu/fields/observables.rs:32,103,165` — pole i energia obserwabli;
- `src/fdm/cpu/integrators.rs:4191,4197` — SoA field i energia w RHS;
- `src/fdm/cpu/fields.rs:529,984,1028,1163,1170,1415,1575,1638` —
  orkiestracja effective field, telemetry/RHS i raportów;
- istniejące konfiguracje i regresje magnetoelastyczne pozostają w
  `src/lib.rs:1052-1057,3091-3249`.

## Bramka ownership

W `crates/fullmag-engine/tests/fdm_source_layout_contract.rs` dodano
`fdm_cpu_magnetoelastic_has_one_realization_owner`. Guard sprawdza:

- rejestrację `fields/magnetoelastic.rs` pod niekolidującą nazwą modułu;
- zachowanie rodzicielskiego `use crate::magnetoelastic;`;
- dokładnie jedną deklarację każdej z pięciu metod w ownerze;
- brak ich deklaracji w `fields.rs`;
- zachowanie `fused_local_terms_add_into` poza ownerem;
- obecność konsumentów energy, observables, integrators i orkiestracji.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Inwentaryzacja ownera/rodzica | PASS; owner=5, parent=0 dla nazwanych metod |
| Porównanie pięciu sygnatur i ciał z bazowym HEAD | PASS; identyczność po normalizacji końców linii |
| Kontrola pozostałego rodzica | PASS; tylko wiring, usunięcie pięciu definicji i zachowany obcy reflow importu |
| Niezależne porównanie root i review | PASS; wszystkie pięć sygnatur/ciał, fused loop i pozostały rodzic identyczne poza wiringiem; brak P0/P1 |
| Hash `fields/magnetoelastic.rs` | `d44a29c1c4c01ceb5e1a87f958acb5dc274ab4752ca6b6d6449537a7ff4844a8` |
| Hash zmienionego kontraktu layoutu | `cc243602328df9d489a98cd44facbad0445eae3d250e80eb8374dc609c9900cf` |
| Rustfmt ownera | PASS, exit 0 |
| Rustfmt kontraktu layoutu | PASS, exit 0 |
| `git diff --check` dla zmienionego zakresu | PASS, exit 0 |
| Kompilacja i test layoutu | NOT COMPILED / NOT RUN zgodnie z aktualnym zakazem |
| Produkcyjny build, runtime i walidacja fizyki | NOT VERIFIED |

Nie dodano ani nie zmieniono noty naukowej: jest to ekstrakcja bez zmian
równań, jednostek, parametrów, obsługi strain ani semantyki backendu. Guard
ownership nie zastępuje bramek kompilacji, runtime ani walidacji fizycznej.

Build 218 obejmuje wcześniejszy commit B-03; jego wynik nie jest dowodem
kompilacji ani runtime dla B-07.
