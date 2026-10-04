# B-08 — właściciel Zeemana FDM CPU

Data: 03.10.2026. Zakres: B-CORE/B-FDM, mechaniczna ekstrakcja istniejącej
realizacji `CpuReference`. Baza porównania: `d3bc3bc34bd0a95a138f381d0e9727d4f271c55a`.

## Zakres

Osiem istniejących metod rodziny zewnętrznego i regionalnego pola przeniesiono
do `crates/fullmag-engine/src/fdm/cpu/fields/zeeman.rs`:

- allocating: `external_field_vectors`, `has_external_zeeman_source`,
  `external_zeeman_field_vectors` i
  `external_zeeman_field_vectors_at_time`;
- ścieżka AoS in-place: `external_field_add_into` oraz
  `regional_field_drives_add_into_at_time`;
- ścieżka SoA in-place: `external_field_add_into_soa` oraz
  `regional_field_drives_add_into_soa_at_time`.

Sygnatury, widoczność `pub(crate)`, ciała, kolejność operacji, maskowanie
aktywnych komórek, obsługa wariantu `parallel` i jawny czas sceny dla napędów
regionalnych pozostają bez zmian. Właściciel jest rejestrowany jako
`mod zeeman;` z atrybutem `#[path = "fields/zeeman.rs"]`. Alias modułu nie
koliduje z istniejącym `use crate::magnetoelastic;` w rodzicu.

Metody Oersteda pozostają w `fields.rs`. `external_zeeman_field_vectors_at_time`
nadal wywołuje rodzicielski `oersted_field_add_into_at_time`, więc ekstrakcja
nie rozdziela istniejącej ścieżki czasowej Oersteda. Publiczne
`soa_fast_path_supported` i `soa_fast_path_rejection_reason` również pozostają
w rodzicu. `fused_local_terms_add_into` nie został przeniesiony ani rozbity.

Nie zmieniono publicznego dispatchu, lane `CpuReference`, FDM GPU, metod FEM,
równań, jednostek ani parametrów fizycznych.

## Konsumenci i granice

Istniejące wywołania pozostały w tych samych miejscach:

- `src/fdm/cpu/fields/energy.rs:31-33,79-80` — wykrycie źródła oraz energia
  zewnętrznego pola;
- `src/fdm/cpu/fields/observables.rs:31,55,98,164,179` — pole zewnętrzne i
  regionalne w obserwablach;
- `src/fdm/cpu/integrators.rs:4177-4183` — SoA pole i energia w RHS;
- `src/fdm/shared/problem.rs:389,462-468` — wspólna projekcja pola i jawny
  czas stanu;
- `src/fdm/cpu/fields.rs:362,369,827,854,974-985,1244,1316,1404,1421,1459-1463`
  — orkiestracja effective field, RHS i raportów.

Podobnie nazwane metody w `src/fem.rs` są osobną realizacją FEM i nie zostały
objęte tym przyrostem.

## Bramka ownership

W `crates/fullmag-engine/tests/fdm_source_layout_contract.rs` dodano
`fdm_cpu_zeeman_has_one_realization_owner`. Guard wymaga:

- rejestracji `fields/zeeman.rs` i dokładnie jednej deklaracji każdej z ośmiu
  metod w ownerze;
- braku tych deklaracji w `fields.rs`;
- zachowania pięciu metod Oersteda, dwóch metod capability SoA i pętli
  `fused_local_terms_add_into` w rodzicu;
- obecności istniejących konsumentów CPU oraz wspólnego FDM problemu.

Istniejący guard DMI nadal zabrania ownerowi DMI przejęcia metod Zeemana:
`external_field_add_into` i `regional_field_drives_add_into_at_time` muszą
być obecne w `fields/zeeman.rs` i nieobecne w DMI. Osobna część tego guarda
utrzymuje `soa_fast_path_supported` i `soa_fast_path_rejection_reason` w
`fields.rs`.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Porównanie ośmiu sygnatur i ciał z bazowym HEAD | PASS; identyczność po normalizacji końców linii |
| Inwentaryzacja ownera i rodzica | PASS; owner ma 8 deklaracji, rodzic nie ma żadnej z nich |
| Pozostały `fields.rs` | PASS; wiring, usunięcie wyłącznie ośmiu nazwanych metod i zachowany obcy reflow importu |
| Hash `fields/zeeman.rs` | `46beaaef66c9c0b0aa337c7c14d7119fa4a1c79905f86b4c68e5abb7def55f46` |
| Hash zmienionego kontraktu layoutu | `602c111d6e37d032f26f4b0717dc7749000c65c23ea4299eefb0108b050f54bc` |
| Niezależne porównanie root i review | PASS; osiem pełnych sygnatur i ciał, cały pozostały rodzic, pięć metod Oersteda, capability SoA i fused loop; brak P0/P1 |
| Rustfmt ownera i kontraktu layoutu | PASS, `rustfmt --edition 2021 --check`, exit 0 |
| `git diff --check` dla zmienionego zakresu | PASS, exit 0 |
| Kompilacja i test layoutu | NOT COMPILED / NOT RUN zgodnie z aktualnym zakazem |
| Produkcyjny build, runtime i walidacja fizyki | NOT VERIFIED |

Nie dodano noty naukowej: jest to ekstrakcja bez zmiany równań, parametrów,
jednostek, czasu oceny, dispatchu ani semantyki backendu. Guard ownership nie
zastępuje bramek kompilacji, runtime ani walidacji fizycznej.

Build 218 zakończył się terminalnym `succeeded`/exit 0. Niezależny odczyt
potwierdził 120 hashowanych artefaktów, 15 wymaganych niepustych outputów oraz
6829 plików kapsuły. Jest to jednak build wcześniejszego commita B-03
`9f7eadb06b7f4e9be3b0fed7b1c9006a4666ea04`, więc nie weryfikuje B-04–B-08.
SHA-256 jego receiptu: `a83e6db94e49cec989ccca985385d2250b14adb3e11e89bc7bbc0052ef811cc7`.
