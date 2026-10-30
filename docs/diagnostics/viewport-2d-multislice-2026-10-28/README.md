# Multislice widoku 2D (F6 B2) — dowody 2026-10-28

Grupa DEV `viewport-2d-streamlines-verify-20261028` (gałąź B2), FDM CPU double, fixture
`examples/viewport_2d_mumax_parity_fdm_smoke.py` (dysk Ø 400 nm, 128×128×2 komórek 4 nm, stan
początkowy wiru), Chromium headless (SwiftShader).

## PM-N27 przez API (`pm_n27_api_check.py`)

| Płaszczyzna | φ | współrzędna | panel = pojedynczy przekrój (współrzędna, raster bitowo) |
|---|---|---|---|
| XY | 0,25 / 0,5 / 0,75 | z = −2 / −2 / +2 nm | tak / tak / tak |
| XZ | 0,25 / 0,5 / 0,75 | y = −130 / −2 / +126 nm | tak / tak / tak |

Tokeny próbek paneli są różne dla każdej φ (także gdy dwie φ trafiają w tę samą warstwę FDM —
hash źródła zawiera żądaną frakcję). `position_fraction` dla źródła monitora: 400
`planar_position_fraction_requires_default_source`; `multislice` z jednym panelem: 400.

## Przeglądarka

- Przycisk **Slices** w pasku 2D włącza panele; przełącznik 2/3/4 ustawia równe frakcje.
- `multislice-xy-3.png`: trzy panele XY, wspólna legenda koła barw, proporcje 1:1.
- `multislice-xz-4.png`: cztery panele XZ (paski 512 × 8 nm, proporcja 64:1); y = 206 nm leży poza
  dyskiem (pusty panel); cięciwy przy y = ±130 nm krótsze niż przy y = −2 nm.
- Wszystkie panele `ready`, 0 błędów strony; po wyłączeniu wraca pojedyncza mapa.
- Smoke wykrył i naprawiono: `useStablePlanarFieldQuery` gubił `position_fraction` (wszystkie panele
  pokazywały przekrój sesji), panele nie zachowywały proporcji u:v.
