# DE +10 rad/µm: izolowany wpływ siatki powietrza

Odczyt 2026-10-04T12:10:50.063820+00:00. **Zmieniono tylko zadany wzrost elementów powietrza 1,3→1,15; film i stan równowagi zachowano w jawnych tolerancjach porównania.** Zaakceptowany wynik to **11.216153905 GHz**, pełny względny residual **2.312e-11** przy niezmienionym progu1e−8. Solve/managed run trwał 81.399 s, exit0. To eksperyment diagnostyczny, nie pełna kwalifikacja solvera ani benchmark wydajności.

## Warunki i wynik

Film DE 40×40×10 nm, Ms800000 A/m, Aex1,3e−11 J/m, B0,1 T, γ₀221100 m/(A·s), μ₀1,2566370614359173e−6 T·m/A. M₀=x, k=y, normalna z; ky=10e6 rad/m. PBC x/y, full-field Floquet exp(−ik·Δr), demag włączony; finite Dirichlet air padding2µm każda strona. Body L2/3, target5nm, air cap100nm. Okno8,5–16GHz, EPS/KSP1e−9, FGMRES restart8, full residual1e−8. Inspektor wymagał identyczności wszystkich wcześniejszych pól modelu baseline; nowym polem jest jawne air_growth_rate.

| Parametr | Baseline | Zagęszczone powietrze |
| --- | ---: | ---: |
| Growth | 1.3 | 1.15 |
| Węzły całej siatki | 6138 | 7524 |
| Węzły filmu | 396 | 396 |
| Tet całej siatki | 30012 | 36900 |
| Tet filmu | 1476 | 1476 |
| Liczba płaszczyzn z całej siatki | 62 | 76 |
| Częstotliwość [GHz] | 11.205285324 | 11.216153905 |
| FEM − open-air 1D basis16 [%] | -0.204668 | -0.107871 |


## Niezależna kontrola izolacji

- Porównano rzeczywiste bound cache/mode payload, kanoniczne współrzędne i połączenia tet filmu, bez utożsamiania różnych whole-mesh hashy. Film ma396węzłów/1476tet i4płaszczyzny z w obu próbach; objętość1,6e−23m³. Kanoniczne hashe body są identyczne przy jawnej tolerancji współrzędnych1e−20m; największa różnica surowych współrzędnych wynosi 3.309e-24m.
- Z zaakceptowanych LinearizationState odczytano rzeczywiste m₀ i pola statyczne. Max komponent m₀ różni się o 4.784e-20, poniżej tolerancji porównania1e−12. Max różnice h_demag0 i h_eff0 to odpowiednio 3.620e-11 i 2.037e-09 A/m. To pomiar niezmienności stanu do porównania; nie zmienia progów akceptacji solvera.
- Profile magnetyczne porównano po mapowaniu kanonicznych węzłów; squared overlap w consistent P1 tet mass wynosi 0.999999942484. Rzeczywisty air z-schedule zmienił się. To nie certyfikat kompletności widma.
- Driver wymagał zgodności czterech miejsc: de_smoke.air_growth_rate, study_universe.airbox_growth_rate, domain_frame.declared_universe.airbox_growth_rate i mesh.mesh_build_report.effective_airbox_target.growth_rate. Wszystkie rozwiązały się do1,15. Nie użyto legacy backend air_box_config.grading1,4.
- Postsolve PASS: receipts/model/source binds, demag, projected full weak-form i periodic seams, true residual FGMRES, L2/3 i physical potential fields. Sam exit0 nie był kryterium przyjęcia.

## Wniosek i następne bramki

Zmiana samej siatki powietrza podniosła częstotliwość o **10.868580 MHz** i zmniejszyła różnicę wobec1D z0,204668% do **0.107871%**. To dowód, że dyskretyzacja powietrza wnosi część obserwowanej rozbieżności. Nie dowodzi, że jest jedyną przyczyną, że 1,15 jest zbieżne, ani że operator ma błąd znaku/skali lub brakuje exchange. Referencja1D basis16=11,228265980GHz uwzględnia profile po grubości i off-diagonal demag; zmiana basis8→16 była około27Hz. Open-air i finite Dirichlet mają różne założenia brzegowe; nie należy mieszać tej różnicy z błędem FEM w Γ.

Następne kroki: kolejny kontrolowany poziom air mesh, sekwencja body/thickness refinement oraz niezależna zbieżność padding i liczby modów. Potem wspólny signed15/serial-adaptive parity i live GUI. Γ pełnego okna nadal failed7/50; zaakceptowany selected-only Γ227 z wykresu tego nie zastępuje. A1/COMSOL i pozostały zakres S00–S12 pozostają **OPEN**.

## Tożsamość i dowody

Runtime jest z managed buildu228/job8df582e52a54410bae0387d2eaecd6a9, source commit57182911c6e8e721b8ee9705aa7f70491c70fe94, digest1635883ea717cc5892970fabb872c70e6d94648da2b57234d6d3c857bbc9d326. Nie wykonano nowego buildu. Nowe standalone wejście: commit38fc4420bbc02454c4b74896ce8bd014b70643f5, SHA2560b67ee80b71acf12f95061c0940d1cdb0b4b53a0ead2620239664e0b7e538d0e. Kompilowane runtime/Python są capsule-bound; skrypt wejściowy ma odrębną tożsamość. Dane historyczne zachowano.

Raw output: resolver storage → runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/scientific-batches/nonzero-k-validation/8df582e52a54410bae0387d2eaecd6a9/de-k10-L2-layers3-air-growth115-fgmres-window-job228-v1. Kapsuła obejmuje historyczne schema LinearizationState.v6/EquilibriumArtifact.v7; ten eksperyment nie kwalifikuje późniejszych migracji źródłowych.

Dowody lokalne w preview-state-checkpoint: `k10-air-growth115-postsolve-inspection-20261004T120400064124Z.json`, SHA256 `b392134a152972611f13ac5b223f360d6832d4c05bd14992004fd654859aef7c`; `k10-air-grading-isolation-20261004T120705977188Z.json`, SHA256 `c9314a438a1c4ed5ce35994fc10097982fb4ac4663ef0b2026078988d321cf72`. [Manifest integralności](assets/de-signed15-20261004/air-grading-manifest.json) zawiera pełne raw i mesh/payload binds; same hashe nie są kwalifikacją. [15-punktowy wykres baseline](2026-10-04-de-signed15-runtime.md) pozostaje jednorodnym zbiorem growth1,3; pojedynczy refinement go nie zastępuje.

Kontrolka źródłowa przeszła independent review bezP1/P2,52interpretowane testy pilota i35scientific-documentation tests. Testów Rust/C++/React nie kompilowano. Nota i mapowanie: docs/physics/0830-fem-poisson-airbox-modal-eigen.md — de-air-grading-controlled-input.
