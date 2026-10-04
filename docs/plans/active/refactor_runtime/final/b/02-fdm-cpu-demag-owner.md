# B-02 — właściciel pola demagnetyzacji Rust FDM CPU

Data: 03.10.2026. Zakres: B-CORE/B-FDM/B-DEMAG, bieżąca realizacja
`CpuReference`. Baza: `5669108d61a8fd9d2480824e0f9492332810a2cd`.

Siedem istniejących metod przeniesiono z `fields.rs` do
`crates/fullmag-engine/src/fdm/cpu/fields/demag.rs`:

- `demag_field_from_vectors`;
- `observable_demag_field_from_vectors`;
- `demag_field_from_vectors_ws`;
- `observable_demag_field_from_vectors_ws`;
- `demag_field_from_vectors_ws_with_output_mask`;
- `demag_field_add_into`;
- `demag_field_add_into_soa_fft_backend`.

Moduł jest właścicielem realizacji pola; FFT i workspace pozostają u swoich
dotychczasowych właścicieli. Energia, obserwable i RHS nadal wywołują te same
metody. Prywatny helper pozostaje prywatny w nowym module. Pole solvera
zachowuje maskowanie nieaktywnych komórek; pole obserwacyjne zachowuje pole
rozproszone w tych komórkach. Wariant SoA nadal deleguje do `FdmFftBackend`.
Nie zmieniono dispatchu, requested/resolved execution ani implementacji GPU.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Porównanie z bazowym HEAD | PASS: wszystkie siedem sygnatur i ciał identyczne po normalizacji końców linii. |
| Pozostały plik `fields.rs` | PASS: tylko rejestracja nowego modułu, usunięcie przeniesionych definicji i odstępy; obce formatowanie importów zachowane poza stagingiem. |
| Rustfmt nowego modułu i kontraktu layoutu | PASS, exit 0. |
| Niezależny review źródeł | PASS, brak P0/P1; importy, prywatność, odbiorcy i rozdział masek zachowane. |
| Kontrakt layoutu Rust | Dodany; NOT COMPILED / NOT RUN zgodnie z aktualnym zakazem. |
| Istniejąca regresja pola obserwacyjnego w nieaktywnych komórkach | Zachowana bez zmian; nie wykonano ponownie. |
| Produkcyjny build tego przyrostu | NOT VERIFIED. Build 217 ma wcześniejszy przypięty commit i nie zawiera B-02. |
| Runtime, fizyka, parity CPU/GPU | NOT VERIFIED dla nowych źródeł; kontrola niezmienności kodu nie zastępuje tych bramek. |

SHA-256 pliku `demag.rs`:
`880a4dac65ffa97f7f0d9a9bcf4321aef44e11057fa48c897f0d0c33742e42ec`.

Cały strumień B pozostaje otwarty, bez awansu procentów na podstawie samej
ekstrakcji. Następny spójny zakres: direct torques (Zhang–Li, Slonczewski,
SOT), z zachowaniem reekspozycji helperów konfiguracyjnych używanych przez
FEM reference i odrębnym dowodem niezmienności implementacji.
