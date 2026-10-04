# B-06 — właściciel DMI FDM CPU

Data: 03.10.2026. Zakres: B-CORE/B-FDM, mechaniczna ekstrakcja istniejącej
realizacji `CpuReference`. Baza porównania: `89390261b237de9165d6b54ff5a67718c3953288`.

## Zakres

Całą spójną rodzinę 23 istniejących metod DMI przeniesiono do
`crates/fullmag-engine/src/fdm/cpu/fields/dmi.rs`:

- energia allocating i SoA: `dmi_energy_from_vectors`,
  `rotated_interfacial_dmi_energy_from_vectors`,
  `dmi_energy_density_from_vectors`,
  `rotated_interfacial_dmi_energy_density_from_vectors` oraz
  `dmi_energy_from_soa`;
- prywatne helpery energii i geometrii ścian: `dmi_energy_density_with_coefficients`,
  `dmi_energy_with`, `dmi_energy_with_coefficients`,
  `dmi_cell_face_energy_with_coefficients`,
  `dmi_face_energy_with_coefficients`, `dmi_boundary_faces`,
  `interfacial_dmi_boundary_correction`,
  `rotated_interfacial_dmi_boundary_correction` i
  `bulk_dmi_boundary_correction`;
- allocating pola: `interfacial_dmi_field`,
  `rotated_interfacial_dmi_field`, `bulk_dmi_field`;
- ścieżki SoA in-place: `interfacial_dmi_field_add_into_soa`,
  `bulk_dmi_field_add_into_soa`, `rotated_interfacial_dmi_field_add_into_soa`;
- ścieżki AoS in-place: `interfacial_dmi_field_add_into`,
  `bulk_dmi_field_add_into`, `rotated_interfacial_dmi_field_add_into`.

Sygnatury, widoczność (`pub`, `pub(crate)` i prywatna), ciała, kolejność
operacji, stencil sąsiadów, maskowanie aktywnych komórek, warunki brzegowe i
wariant `parallel` pozostają bez zmian. Żaden prywatny helper nie miał
konsumenta poza tą rodziną, dlatego nie dodano `pub(super)` ani innego
poszerzenia widoczności.

`fields.rs` zachowuje orkiestrację i wywołania. `neighbor_index` i
`AxisBoundary` zostały związane bezpośrednio w ownerze DMI; `AxisBoundary` jest
pozostawiony w rodzicu pod `cfg(test)` dla istniejących testów rodzica. Nie
zmieniono publicznego dispatchu, lane `CpuReference`, FDM GPU ani osobnych
metod FEM.

`fused_local_terms_add_into` pozostał całkowicie poza ownerem. DMI nadal jest
wykonywane w osobnych przejściach sąsiedzkich, zgodnie z istniejącą granicą
fused local terms.

`external_field_add_into`, `regional_field_drives_add_into_at_time`,
`soa_fast_path_supported` i `soa_fast_path_rejection_reason` pozostają w
`fields.rs`; nie są metodami DMI.

## Konsumenci

Istotne istniejące wywołania pozostają bez zmian:

- `src/fdm/cpu/fields/energy.rs:59,91` — energia SoA i AoS;
- `src/fdm/cpu/fields/observables.rs:34-36,105,167-169` — trzy składowe pola
  i energia obserwabli;
- `src/fdm/cpu/integrators.rs:4193-4199` — SoA pola DMI i energia w RHS;
- `src/fdm/cpu/fields.rs:633-635,1105-1107,1150-1152,1279-1286` — orkiestracja
  effective field, telemetry/RHS i raportów;
- `src/lib.rs:1217,1247,1271,1340-1342,1366-1367` — istniejące testowe
  konsumenty publicznych metod;
- runner FDM CPU: `src/fdm/cpu/multilayer_reference.rs:1045-1048,1499-1503,1552`
  oraz `src/fdm/cpu/reference.rs:3154-3156,3209-3210,3293,3578,3682,4019,4042`.

## Bramka ownership

W `crates/fullmag-engine/tests/fdm_source_layout_contract.rs` dodano
`fdm_cpu_dmi_has_one_realization_owner`. Guard sprawdza rejestrację
`fields/dmi.rs`, dokładnie jedną deklarację wszystkich 23 metod, brak ich
deklaracji w orkiestracji, zachowanie `fused_local_terms_add_into` w rodzicu
oraz obecność kluczowych konsumentów energy, observables, integrators i testów
crate.

Niezależna kontrola wykryła początkowe przeniesienie czterech metod spoza DMI:
`external_field_add_into`, `regional_field_drives_add_into_at_time`,
`soa_fast_path_supported` i `soa_fast_path_rejection_reason`. Przywrócono je
do dotychczasowych miejsc w rodzicu, z identycznymi sygnaturami i ciałami.
Guard wymaga ich obecności w rodzicu i braku deklaracji w ownerze DMI.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Porównanie 23 sygnatur i ciał z bazowym HEAD | PASS; identyczność po normalizacji końców linii |
| Niezależny odczyt root: pełna inwentaryzacja ownera i cztery przywrócone metody | PASS; dokładnie 23 metody, pozostałe cztery oraz fused loop identyczne z bazą |
| Pozostały `fields.rs` | PASS; wiring, usunięcie dwóch zakresów DMI i lokalna korekta importu; wcześniejszy obcy reflow importu zachowany |
| Hash `fields/dmi.rs` | `50ac04f250d89fcfd1b9ad592386435be82d40c446c9af56eae5792f76eb3a3d` |
| Hash zmienionego kontraktu layoutu | `dc77e65e690476755b6f3e51bb98d1d9a044fa58a26800325243d584241dac03` |
| Rustfmt ownera | PASS, exit 0 |
| Rustfmt kontraktu layoutu | PASS, exit 0 |
| Niezależny review poprawionego freeze | PASS; brak otwartych P0/P1, widoczność/importy/konsumenci i guard zgodne |
| `git diff --check` dla zmienionego zakresu | PASS, exit 0 |
| Kompilacja i test layoutu | NOT COMPILED / NOT RUN zgodnie z aktualnym zakazem |
| Produkcyjny build, runtime i walidacja fizyki | NOT VERIFIED |

Nie dodano ani nie zmieniono noty naukowej: jest to ekstrakcja bez zmian
równań, jednostek, parametrów, stencilów i semantyki backendu. Guard ownership
nie zastępuje bramek kompilacji, runtime ani walidacji fizycznej.

Aktywny build 218 jest przypięty do wcześniejszego commita B-03
`9f7eadb06b7f4e9be3b0fed7b1c9006a4666ea04`. Jego wynik nie zweryfikuje B-06.
