# 2D Slice Capabilities

Ten status rozróżnia implementację, wykonanie zarządzane, dowód przeglądarkowy
i walidację naukową dla kanonicznej powierzchni `field-map`. Raporty z lipca
2026 są **historycznym punktem odniesienia**, a nie dowodem aktualnego `HEAD`.
Aktualny smoke wymaga zgodności telemetryki aktualnego żądania z wyrenderowanym
rastrem, zanim może zapisać `pass: true`.

| Feature | FDM CPU | FEM CPU | FEM GPU run | Evidence status |
|---|---|---|---|---|
| Session `Default` source: XY/XZ/YZ plane sample | implemented, source-tested | implemented, source-tested | implemented, source-tested; runtime pending | managed science/browser qualification not yet available on current HEAD |
| Session `Default` source: slab average | implemented, source-tested | implemented, source-tested | implemented, source-tested; runtime pending | managed science/browser qualification not yet available on current HEAD |
| Plane heatmap and probe | yes | yes | yes | historycznie validated; wymaga świeżego smoke HEAD |
| Slab average | yes | yes | yes | historycznie validated; wymaga świeżego smoke HEAD |
| Depth projection | yes | yes | yes | historycznie validated; wymaga świeżego smoke HEAD |
| Surface projection | not applicable in fixture | yes | yes | historycznie validated dla FEM; wymaga świeżego smoke HEAD |
| Magnetic vectors | yes | yes | yes | historycznie browser verified; wymaga świeżego smoke HEAD |
| Contours and masked holes | yes | yes | yes | focused model tested |
| Mesh overlay | structured outline | exact FEM section | exact FEM section | historycznie browser verified; wymaga świeżego smoke HEAD |
| PNG export | yes | yes | yes | contract tested |
| 3D frame preview | yes | yes | yes | historycznie browser verified; wymaga świeżego smoke HEAD |

## Status Language

Use these messages consistently:

- `Requires FEM explicit topology` for FEM-only mesh and airbox controls on unsupported domains.
- `No airbox mesh part in current domain` when FEM topology exists but has no airbox part.
- `Using local fallback` or `mesh: local fallback after backend error` when backend mesh overlay cannot be used.
- `Not implemented E2E yet` for contour, primitives, and airbox vectors;
  slab sampling is implemented in the shared sampler but still needs fresh
  managed/browser evidence on the current HEAD.
- `Default` is a session-resolved source, not an authored monitor; it is not
  added to `SceneDocument`, `ProblemIR`, canonical Python, or Explorer.
- `source-tested` means the contract, resolver, transport, or UI behavior was
  exercised locally. It is not a managed-runtime or production qualification.
- FDM GPU remains `not_qualified`: the required managed launcher and an
  executed device/carrier proof do not exist, so no green status is inherited
  from FDM CPU.

## Historyczne evidence zarządzane (2026-07-18)

- `fdm-cpu`: science and browser reports pass; requested/resolved `fdm/cpu`; 100 switches; 61,594,483-byte heap growth.
- `fem-cpu`: science and browser reports pass; requested/resolved `fem/cpu`; 100 switches; 7,936,018-byte heap growth.
- `fem-gpu`: science and browser reports pass; requested `cuda` (GPU alias), resolved `fem/gpu`; 100 switches; 7,457,770-byte heap growth.
- Cross-backend manufactured linear-field relative RMS is about `1.19e-3` for both FEM lanes.

Raporty i screenshoty są pod `.fullmag/reports/viewport-2d-planar-monitor-smoke/`,
ale nie kwalifikują aktualnego `HEAD`. Planar sampling jest obecnie jawnym CPU
postprocessorem nawet, gdy symulacja rozwiązuje się na FEM GPU; raport ma to
rejestrować zamiast sugerować sampler rezydujący na urządzeniu.

## Baseline authored-monitor smoke contract (2026-08-12)

- Smoke `viewport-2d-browser-smoke-v2` publikuje monitor ID, operator kind,
  quantity/component, `meta.etag` jako tymczasową sample identity,
  field revision, status, checksum/range rastra oraz liczby glyph/contour/mesh.
- `pass: true` jest dozwolone wyłącznie, gdy każdy obserwowany raster jest
  `ready` i jego identity oraz field revision zgadzają się z odpowiedzią
  `meta` zużytą przez przeglądarkę.
- Fixture do kolejnego świeżego uruchomienia: compact FEM
  `examples/viewport_2d_planar_monitor_fem_compact_smoke.py` i multi-object
  FDM `examples/viewport_2d_planar_monitor_fdm_multi_object_smoke.py`.
- To nie jest managed-runtime qualification; wymagane jest osobne uruchomienie
  repozytoryjnej receptury `just` po jej przełączeniu na te fixture.

## Default planar source implementation (2026-08-16)

- `visualization/state.planar` now has typed `source` and `default_slice`
  state. A fresh session resolves `Default`, `xy`, and `position_fraction=0.5`;
  selecting 2D does not list monitors, create a draft, or mutate the model.
- The `planar-default` data family uses the same backend planar sampler as an
  authored monitor and publishes source-aware meta, identity, frame, operator,
  and canonical child links.
- The Inspector exposes `Default`/authored monitor selection, XY/XZ/YZ,
  position fraction, resolved coordinate, and plane/slab sampling controls.
- Local evidence currently includes the validator suite, focused frontend/API
  tests, typecheck, and API/architecture hygiene. The managed recipe and
  browser/science reports for the current HEAD remain pending because the
  managed native runtime storage is full; no lane is `production-qualified`.

## Release Policy

Powyższe authored-monitor lane'y są zaimplementowane, lecz ich browser/science
status z lipca pozostaje historyczny do czasu świeżego dowodu. Airbox-specific
field availability nadal wynika z kanonicznego quantity catalog, a nie z samej
widocznej geometrii airboxa. Scena bez monitorów otwiera teraz sesyjny `Default`
po przygotowaniu domeny; nie tworzy niezatwierdzonego draftu i nie wymaga Apply.
Utworzenie trwałego monitora pozostaje wyłącznie jawną akcją authoringową.
