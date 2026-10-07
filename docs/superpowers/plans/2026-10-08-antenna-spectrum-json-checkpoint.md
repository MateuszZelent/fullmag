# T10/T12 — jednoznaczność manifestu widma anteny

Przyrost względem `4040e36b70a81ee1771b0653c0847b287f622e9a`.
Zwykły parser Value stosował last-key-wins. Wstrzyknięcie duplikatu z ostatnią
wartością równą oryginałowi pozostawiało ten sam kanoniczny digest, mimo
niejednoznacznego dokumentu. Nie jest to problem algorytmu Fourierowskiego.

## Wspólny właściciel

`crates/fullmag-runner/src/antenna_spectrum.rs::parse_antenna_source_spectrum_manifest_json`
korzysta z istniejącego
`crates/fullmag-runner/src/artifact_json.rs::UnambiguousJson`.
Rekursywnie odrzuca powtórzone zdekodowane klucze przed digestem i typowaniem.
Nie tworzy drugiego algorytmu parsera ani nowego schematu artefaktów.

Wywołują go `verify_antenna_source_spectrum_auxiliary_artifacts`,
`reusable_antenna_source_spectrum_output` i
`crates/fullmag-api/src/router_v2/handlers/data/antenna.rs::read_source_spectrum_manifest_value`.
Ostatnia granica obsługuje metadata v1/v2 oraz payload v2. Jednoznaczny legacy
v1 zachowuje poprzednią ścieżkę. Parser nie jest samodzielnym certyfikatem:
dotychczasowe kontrole digestu, semantyki, jednostek, kształtu i payloadów pozostają.

## Dowody i ograniczenia

- Dodano `spectrum_readers_refuse_duplicate_keys_even_with_valid_last_value_digest`:
  output identity, nested component oraz escaped `un\u0069t`; test porównuje
  wynik starego Value parsera z poprawnym dokumentem, sprawdza odmowę parsera,
  verifiera i cache oraz akceptację ponownie przywróconego poprawnego cache.
- Test Rust nie został skompilowany ani wykonany — zakaz projektu obowiązuje.
  Nie jest to wykonany RED/GREEN ani test endpointów API lub legacy v1.
- Niezależny review źródeł nie wskazał blockera; potwierdził granice parsera
  i dopasowanie fixture. Kwalifikacja routingu API pozostaje otwarta.
- Parser Rust i diff check: PASS.
- `just check-api-source`: PASS, exit 0, receipt
  `43c890ae3cd24711835d9d3bf46c3344`, niezmienione źródła przed/po.
  Wcześniejszy receipt `c6ec5458e58b44b2a0144fe08c2be613` został odrzucony jako
  `source_changed` po dopisaniu regresji podczas kontroli; nie jest dowodem PASS.
- Nie zmieniono Python DSL, IR, OpenAPI, numeryki FFT ani kwalifikacji
  FDM CPU/GPU i FEM CPU/GPU. Nie zamykano aktywnej sesji.

Nieograniczony wcześniejszy odczyt manifestu cache/API oraz globalny budżet RAM
nadal wymagają osobnego domknięcia. Pełne T10/T12 i T00–T18 pozostają otwarte.
