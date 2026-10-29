# Parytet ergonomii widoku 2D z mumax3 (F5) i streamlines (F6 B3) — 2026-10-28

Dowód parytetu **ergonomii** (koło barw, strzałki), nie poprawności fizycznej.

- Stan: dysk Ø 400 nm w siatce 128×128×2 komórek 4 nm, Ms = 800 kA/m, stan początkowy wiru
  (Fullmag `fm.texture.vortex()`, mumax3 `Vortex(1, 1)`).
- Fullmag: grupa DEV `viewport-2d-streamlines-verify-20261028` (commit `8e8afaa34`), FDM CPU double,
  fixture `examples/viewport_2d_mumax_parity_fdm_smoke.py`, Chromium headless (SwiftShader),
  stan `planar`: źródło Default, `m`, `hsl_direction`, `vector_budget` 256.
- mumax3: `mumax3-vortex-initial.mx3` (lokalny fork z wyjściem zarr), `snapshot(m)`.
- Relaksacja w Fullmag nie była możliwa: run FDM CPU kończy się na masterze błędem runnera
  `until_seconds must be finite and positive` (`crates/fullmag-runner/src/fdm/cpu/reference.rs`),
  niezależnie od tej zmiany. Dlatego porównywany jest stan początkowy; `mumax3-vortex-relaxed.jpg`
  pokazuje dla odniesienia stan po `Relax()`.

| Plik | Zawartość |
|---|---|
| `fullmag-2d-direction.png` | koło barw + ciemne strzałki (jak mumax3) |
| `mumax3-vortex-initial.jpg` | ten sam stan w mumax3 |
| `fullmag-2d-streamlines.png` | warstwa streamlines na kole barw: 7 linii, `truncated=false` |
| `fullmag-2d-streamlines-arrows.png` | streamlines + strzałki: linie styczne do strzałek, grot w kierunku pola |

Zgodność: ten sam układ barw (+x czerwony na dole wiru przeciwnego do wskazówek zegara, cyjan u góry,
zieleń po prawej, fiolet po lewej) i ciemne strzałki nad obrazem kierunku. 0 błędów strony.
