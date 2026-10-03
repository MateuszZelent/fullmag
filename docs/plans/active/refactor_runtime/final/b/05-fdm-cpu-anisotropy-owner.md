# B-05 — właściciel anizotropii FDM CPU

Data: 03.10.2026. Zakres: B-CORE/B-FDM, mechaniczna ekstrakcja istniejącej
realizacji `CpuReference`. Baza porównania: `2a6a2d956d72044820ccf6f4a7a31bacef13ea18`.

## Zakres

Sześć istniejących metod rodziny anizotropii przeniesiono do
`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs`:

- `anisotropy_field_components` — rozdzielone składowe jednoosiowa i sześcienna;
- `anisotropy_field` — allocating field złożonego wkładu;
- `anisotropy_energy` oraz `anisotropy_energy_from_soa`;
- `anisotropy_field_add_into` — ścieżka AoS in-place;
- `anisotropy_field_add_into_soa` — ścieżka SoA in-place.

Sygnatury, widoczność, ciała metod, komentarz publicznego rozdzielenia składowych,
maskowanie aktywnych komórek, wariant `parallel` i kolejność obliczeń pozostają
bez zmian. Nie zmieniono publicznego dispatchu, ścieżki `CpuReference`, realizacji
GPU ani osobnych metod FEM.

Wspólny prywatny helper
`anisotropy_energy_density_for_magnetization` pozostał w `fields.rs`, ponieważ
istniejący `fields/energy.rs` używa go przez `super::` i jego prywatna granica
nie wymaga zmiany dla tej ekstrakcji. Nie jest to druga realizacja anizotropii:
helper zawiera wyłącznie wspólną funkcję gęstości energii, a sześć metod
realizacyjnych ma jeden owner w `fields/anisotropy.rs`.

`fused_local_terms_add_into` pozostał w `fields.rs`. Jego scalona pętla jest
osobnym przyszłym zakresem modularizacji i nie została rozbita ani zmieniona.

## Konsumenci i granice

Istniejące wywołania pozostają w tych samych miejscach:

- `src/fdm/cpu/fields/energy.rs:57,89` — oba warianty energii;
- `src/fdm/cpu/fields/observables.rs:33,104,166` — field i energia obserwabli;
- `src/fdm/cpu/integrators.rs:4192,4198` — SoA field i energia w RHS;
- `src/fdm/cpu/fields.rs:1431,2146,2278,2285,2753` — orkiestracja effective
  field, RHS i raportów;
- `src/lib.rs:1463,1496` — istniejące testowe konsumenty API crate;
- `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs:1498` oraz
  `crates/fullmag-runner/src/fdm/cpu/reference.rs:3152,3662`,
  `crates/fullmag-runner/src/fdm/cpu/reference/direct_snapshot.rs:221` i
  `crates/fullmag-runner/src/fdm/cpu/reference/outputs.rs:311` — publiczne
  użycie allocating field.

Nie przenoszono podobnie nazwanych metod z `crates/fullmag-engine/src/fem.rs`.
Ten przyrost nie promuje FDM CPU do native production FDM ani nie stanowi dowodu
parytetu CPU/GPU lub kwalifikacji naukowej.

## Bramka ownership

W `crates/fullmag-engine/tests/fdm_source_layout_contract.rs` dodano
`fdm_cpu_anisotropy_has_one_realization_owner`. Guard sprawdza:

- rejestrację `fields/anisotropy.rs` w `fields.rs`;
- dokładnie jedną deklarację każdej z sześciu metod w nowym ownerze;
- brak ich deklaracji w pliku orkiestracji;
- zachowanie prywatnego helpera gęstości energii w `fields.rs`;
- zachowanie `fused_local_terms_add_into` poza nowym ownerem;
- obecność istotnych konsumentów energy, observables, integrators i istniejących
  testów crate.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Porównanie sześciu sygnatur i ciał z bazowym HEAD | PASS; identyczność po normalizacji końców linii |
| Pozostały `fields.rs` | PASS; wiring i usunięcie sześciu definicji; wcześniejszy obcy reflow importu zachowany |
| Hash `fields/anisotropy.rs` | `1a999445a6e3c29ecca05798819271ba3362494c7211cbcb70c020c55a9867d3` |
| Hash zmienionego kontraktu layoutu | `e0a2f4b20cad8b5f406e779182710c28b84a1df51e9f9de80c0ce6c6a3dc1b24` |
| Rustfmt ownera | PASS, exit 0 |
| Rustfmt kontraktu layoutu | PASS, exit 0 |
| `git diff --check` dla zmienionego zakresu | PASS, exit 0 |
| Niezależny review | Kod: bez P0/P1; błędne ścieżki konsumentów w raporcie poprawiono i sprawdzono w źródłach |
| Kompilacja i test layoutu | NOT COMPILED / NOT RUN zgodnie z aktualnym zakazem |
| Produkcyjny build, runtime i walidacja fizyki | NOT VERIFIED |

Nie dodano ani nie zmieniono noty naukowej: przyrost nie zmienia równań,
jednostek, parametrów, kolejności operacji ani semantyki backendu. Przed promocją
całego strumienia B nadal wymagane są bramki kompilacji, runtime i walidacji
fizycznej; sam guard ownership nie jest ich substytutem.
