# T15 — zakres liczności i round-trip próbkowania widma

Przyrost względem `acaf3f8e03b0075c5770ccaa1886a942f754b01f`.

`packages/fullmag-py/src/fullmag/model/antenna.py::AntennaSpectrumSamplingPlane.__init__`
wcześniej przyjmował liczności większe niż zakres
`crates/fullmag-ir/src/antenna.rs::AntennaSpectrumSamplingPlaneIR` (`u32`).
Konstruktor odrzuca teraz liczności poza [2, 2**32 - 1] na obu osiach.
To zgodność reprezentacji, nie limit RAM ani zgoda na wykonanie ogromnego FFT.
Nie zmieniono schematu, algorytmu, gęstości, fizyki ani jednostek.

`packages/fullmag-py/tests/test_antenna_spectrum_sampling_contract.py`:

- RED: cztery przypadki powyżej u32 nie zgłosiły oczekiwanego wyjątku.
- GREEN: 3/3 testy, exit 0; odrzucono 0, 1, wartości powyżej u32,
  float i bool na obu osiach. Granice 2 i u32::MAX przeszły bez alokacji siatki.
- Renderer `packages/fullmag-py/src/fullmag/runtime/script_builder.py::_render_antenna_spectrum_request_expr`
  odtwarza identyczny IR dla 16 kombinacji dwóch transformacji, czterech okien
  i dwóch normalizacji. Zachowano origin, osie, extents, liczności, interpolation,
  outside_policy, port, target, symbolic solution i jawne osie k w rad/m.
  Nie dodano drugiego renderera; obecny już zachowywał te parametry.
- Po zmianie wykonano bezpośrednio 23 funkcje z
  `packages/fullmag-py/tests/test_antenna_stage_workflow.py`: PASS, exit 0;
  jedyny tmp_path otrzymał TemporaryDirectory pod storage na D. Nie pytest.
- `git diff --check`: PASS. Nie kompilowano testów Rust ani nie restartowano sesji.
- Niezależny scoped review implementacji, IR, renderera i regresji: brak
  wskazanego blockera. Round-trip nowego testu dotyczy wyrażenia requestu,
  nie kompletnej sceny z tymi 16 konfiguracjami.

Nie kwalifikuje to numeryki FFT, amplitudy, Parsevala, projekcji carrierów,
UI modal/wykresów ani FDM CPU/GPU i FEM CPU/GPU. Pozostałe bramki T15 oraz
cały plan T00–T18 pozostają otwarte. Parametry o poprawnej reprezentacji nadal
wymagają preflight kosztu/pamięci przed wykonaniem.
