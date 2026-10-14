# T12 — jednoznaczność manifestu pola anteny

## Zakres i ustalenie

Aktualny kod ma już snapshot v3, walidację `DirectOerstedSnapshot` oraz
niezależny czytnik binarnego evidence. Historycznych wpisów o ich braku nie
należy traktować jako aktualnego stanu implementacji.

Pozostała asymetria: `antenna_field_solution.rs::parse_verified_manifest`
deserializował bezpośrednio do `serde_json::Value`. Powtórzony klucz zachowywał
ostatnią wartość przed sprawdzeniem kanonicznego `content_digest`. Dwa sprzeczne
statusy lub parametry normalizacji mogły więc reprezentować dla tego czytnika
ten sam dokument co poprawny manifest. Niezależny czytnik Python odmawiał
takiego dokumentu. Sam SHA nie rozstrzyga tej niejednoznaczności.

## Zmiana źródłowa

Istniejący rekurencyjny `UnambiguousJson::deserialize` przeniesiono bez zmiany
algorytmu z `eigen/artifacts/legacy_manifest.rs` do `artifact_json.rs`.
Dotychczasowy adapter archiwalny nadal używa tego samego parsera.
`parse_verified_manifest` stosuje go przed kanonikalizacją i weryfikacją
digestu. Nie zmieniono schematu manifestu, równań, jednostek, Python DSL ani IR.
Jednoznaczne, poprawne manifesty pozostają kompatybilne.

Regresja Rust
`readers_refuse_duplicate_manifest_keys_even_when_last_value_and_digest_are_valid`
obejmuje status, prąd, scope, target count, digest, klucz zapisany przez escape
Unicode oraz bazę dodatkowego portu. Kontroluje manifest gate, asset gate,
loader widma i loader projekcji. Najpierw potwierdza, że parser last-wins
uzyskałby dokładnie pierwotny dokument z poprawnym digestem.

## Dowody i ograniczenia

- Interpretowane testy `tests.antenna.test_verify_field_convergence`: 26 testów,
  25 PASS, 1 SKIP. SKIP dotyczy rzeczywistego symlinka z powodu Windows 1314.
  Rozszerzona odmowa duplikatów obejmuje zagnieżdżone dane i escape Unicode.
- Parser `rustfmt --emit stdout --config skip_children=true`: PASS dla czterech
  zmienionych plików Rust. To dowód składni, nie typecheck ani wykonanie.
- Testów Rust nie kompilowano zgodnie z obowiązującym zakazem. Ich RED/GREEN,
  build i rzeczywisty odczyt w runtime pozostają **NOT VERIFIED**.
- Nie zamykano aktywnej sesji, nie restartowano backendu ani nie uruchamiano
  solvera. Ten etap nie zamyka T12 ani pełnego T00–T18.

## Następne bramki

`antenna_stage.rs::load_published_antenna_field_solution_checked` i
`collect_solution_files` nadal wymagają ograniczeń rozmiaru przed odczytem,
odczytywania wyłącznie zadeklarowanych payloadów oraz odmowy linków także na
granicy katalogu rewizji i manifestu. Decoder v3 stosujący bounds po alokacji
nie zastępuje tych zabezpieczeń I/O. Należy zaprojektować ten kontrakt osobno,
z limitami dla wszystkich obsługiwanych carrierów, bez arbitralnego obniżania
obsługiwanej wielkości problemu.

Regularna publikacja trzech rzeczywistych poziomów siatki, provenance,
precompute → import → compute_fields → Relax/LLG i kwalifikacja czterech
realizacji pozostają odrębnymi otwartymi bramkami planu.
