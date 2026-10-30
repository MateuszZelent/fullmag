# Parytet ergonomii widoku 2D z mumax3 (F5) i streamlines (F6 B3) — 2026-10-28

Dowód parytetu **ergonomii** (koło barw, strzałki), nie poprawności fizycznej.

- Stan: dysk Ø 400 nm w siatce 128×128×2 komórek 4 nm, Ms = 800 kA/m, stan początkowy wiru
  (Fullmag `fm.texture.vortex()`, mumax3 `Vortex(1, 1)`).
- Fullmag: grupa DEV `viewport-2d-streamlines-verify-20261028` (commit `8e8afaa34`), FDM CPU double,
  fixture `examples/viewport_2d_mumax_parity_fdm_smoke.py`, Chromium headless (SwiftShader),
  stan `planar`: źródło Default, `m`, `hsl_direction`, `vector_budget` 256.
- mumax3: `mumax3-vortex-initial.mx3` (lokalny fork z wyjściem zarr), `snapshot(m)`.
- Stan początkowy: oba programy z tej samej tekstury (`fullmag-2d-direction.png`, `mumax3-vortex-initial.jpg`).
- Stan po relaksacji (2026-10-29, po poprawce runnera FDM CPU, która przywraca nieograniczony horyzont
  relaksacji — wcześniej run kończył się błędem `until_seconds must be finite and positive`):
  Fullmag po etapie relaksacji fixture (`llg_overdamped`, 200 kroków = `max_steps`, run `completed`)
  w `fullmag-2d-direction-relaxed.png`; mumax3 po `Relax()` w `mumax3-vortex-relaxed.jpg`. Etap Fullmag
  jest ograniczony do 200 kroków, więc nie jest to w pełni zbieżny stan równowagi jak w mumax3; porównanie
  pozostaje porównaniem ergonomii (koło barw, strzałki), nie fizyki.

| Plik | Zawartość |
|---|---|
| `fullmag-2d-direction.png` | koło barw + ciemne strzałki (jak mumax3), stan początkowy |
| `fullmag-2d-direction-relaxed.png` | to samo po etapie relaksacji (200 kroków, FDM CPU) |
| `mumax3-vortex-initial.jpg` | ten sam stan w mumax3 |
| `fullmag-2d-streamlines.png` | warstwa streamlines na kole barw: 7 linii, `truncated=false` |
| `fullmag-2d-streamlines-arrows.png` | streamlines + strzałki: linie styczne do strzałek, grot w kierunku pola |

Zgodność: ten sam układ barw (+x czerwony na dole wiru przeciwnego do wskazówek zegara, cyjan u góry,
zieleń po prawej, fiolet po lewej) i ciemne strzałki nad obrazem kierunku. 0 błędów strony.
