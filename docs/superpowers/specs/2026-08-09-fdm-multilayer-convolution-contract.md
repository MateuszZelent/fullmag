# Zamrożony kontrakt FDM multilayer convolution v2

Ten dokument jest bramką G0 dla wdrożenia opisanego w
`docs/superpowers/plans/2026-08-09-fdm-multilayer-convolution.md`. Nie jest
kwalifikacją numeryczną ani deklaracją gotowości produkcyjnej.

## Wire values i intencja

- `strategy`: `auto`, `single_grid`, `multilayer_convolution`;
- `mode`: `auto`, `two_d_stack`, `three_d`;
- `execution_shape`: `cpu_reference_multilayer`,
  `cuda_native_multilayer_single_grid`,
  `cuda_native_multilayer_convolution`, `cuda_assisted_multilayer`;
- `transfer_kind`: `identity`, `push_pull`;
- `scope_kind`: `layer`, `object`, `airbox`;
- `H_eff` dla carriera Airbox jest w pierwszej promocji niedostępne z
  reason code `airbox_heff_not_available_v1`; publikowane jest `H_demag`.

Oryginalne `requested` pozostaje niezmienione, nawet gdy planner rozwiąże
`auto`. `planner_summary` jest jedynym właścicielem requested/resolved
strategy i mode; nie tworzyć drugich pól semantycznie równoważnych.

## Siatki i tożsamość

`common_transform_layout` opisuje wyłącznie wspólne liczności XY, shape FFT,
strides, padding i konwencję transformacji. Nie jest jednym fizycznym
meshem. Każda warstwa ma osobny `layer_scratch_grid` i natywną siatkę z
`layer_id`, `object_id`, fingerprintem i maską.

`common_cells` i `common_cells_xy` są wzajemnie wykluczające.
`common_cells=(N_x,N_y,N_z)` wymusza/resolwuje `three_d` i jest odrzucane przy
jawnym `two_d_stack`; `common_cells_xy=(N_x,N_y)` wymusza/resolwuje
`two_d_stack` i jest odrzucane przy jawnym `three_d`. W trybie 2D warstwa
robocza ma dokładnie jedną komórkę Z i magnetyzacja jest
reprezentowana przez moment-preserving średnią po grubości. Jeśli tekstura
`m(z)` wymaga rozdzielczości przez grubość, planner odrzuca 2D i wymaga
`three_d`.

## Kernel i transfer

Kierunek tensora jest `destination <- source`. Dla pary o rozmiarach
`n_source`, `n_destination` logiczny extent liniowej konwolucji wynosi
`n_source+n_destination-1` w każdej osi; zero-padding i crop są zapisane w
descriptorze, nie wywnioskowane przez runtime.

Volume-weighted reciprocity jest obowiązkowa:

\[
V_d K_{d\leftarrow s}=V_s K_{s\leftarrow d}^{T}.
\]

Parity reuse dla przeciwnego przesunięcia Z jest legalne wyłącznie dla
`two_d_stack`, czystego przesunięcia Z oraz równo zorientowanych `h_source` i
`h_destination`. Nierówne grubości lub dowolny offset wymagają osobnego
descriptoru/pełnej reprezentacji zespolonej.

Transfer `push_m` i `pull_h` musi być adjointny w objętościowo ważonym
iloczynie skalarnym albo energia jest raportowana na rastrze, na którym
zdefiniowano operator. `E_destination` ma postać
`-(mu0/2) * sum_active(V * M dot H)`; sumy wzajemnej nie wolno podwajać.

## Revisions i API

- `scene.v3` przechowuje `SceneFdmDiscretizationState`; stare
  `scene.v2` jest odczytywane przez migrator, a zapis zawsze emituje v3;
- `fdm_multilayer_execution.v2` jest fragmentem proweniencji;
- zasób JSON: `GET /v2/sessions/current/data/domain/fdm-multilayer-layout`;
- `layout_revision` zmienia się po zmianie geometrii/native/common grids,
  `observation_revision` po materializacji carriera, a `execution_revision`
  po nowym runie;
- ciężkie maski i pola pozostają na binary data plane; `/status` publikuje
  tylko revision pointers;
- brak pojedynczego FMRM dla `region` pozostaje reasoned 422/404 zgodnie z
  istniejącym v2 contractem.

## Kwalifikacja

Dokumentacja, testy kontraktowe, CPU FP64, CUDA FP64, CUDA FP32, Airbox i
WebGL są osobnymi lane'ami. Kod lub test RED nie podnosi capability. Promocja
może nastąpić dopiero po świeżym managed-runtime summary zawierającym source
commit/dirty state, runtime SHA, descriptor/threshold hashes, device,
precision, residency, kernel/FFT counts, transfer bytes oraz screenshot/FMVP
hashes.
