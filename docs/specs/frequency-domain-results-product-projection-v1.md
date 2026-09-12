# Projekcja aktywnego produktu w drzewie Results

**Status:** wdrożone źródłowo, kwalifikacja runtime nadal otwarta
**Zakres:** Control Room v2, Results Explorer, produkty częstotliwościowe
**Data:** 2026-08-13

## Cel i granica

Drzewo `Results` opisuje wyniki opublikowane przez bieżący run. Nie jest
katalogiem wszystkich możliwości solvera. Obecność capability,
`response_progress` albo zasobu z poprzedniego odświeżenia nie aktywuje węzła.

W jednym gotowym manifeście może być opublikowany dokładnie jeden produkt:

| `study_product` | Produkt w Results | Dozwolone gałęzie |
|---|---|---|
| `modal_eigen` | `Modal Eigen Results` | spectrum, branches, dispersion, mode fields |
| `driven_response` | `Driven Frequency Response` | response sweep, frequency points, response fields |

Produkty mają wspólną rodzinę API, ale nie są zamiennymi widokami tego samego
wyniku. Nie wolno wyświetlać obu gałęzi tylko dlatego, że manifest capability
deklaruje oba tryby.

## Źródło prawdy i kolejność rozstrzygania

Resolver korzysta z zasobu:

```text
GET /v2/sessions/current/analysis/frequency-domain/manifest.v1
  -> result_manifest
  -> result_manifest.status
  -> result_manifest.payload
```

Wynik jest gotowy do projekcji dopiero, gdy `result_manifest.status ===
"ready"`. Następnie obowiązuje poniższa kolejność:

1. Jeżeli `payload` nie jest obiektem, aktywnego produktu nie ma.
2. Jeżeli `payload` ma klucz `study_product`, jego wartość musi być dokładnie
   `modal_eigen` albo `driven_response`. Wartość nieznana, `null` lub pusty
   wpis kończy się stanem niejednoznacznym i ukryciem gałęzi.
3. Dla starszych artefaktów bez klucza `study_product` dopuszczony jest odczyt
   `payload.requested_execution.calculation_mode` (lub starego
   `payload.calculation_mode`) jako migracja jednokierunkowa. Rozpoznawane są
   `free_modes`/`fmr_modal`/`dispersion_modal` oraz
   `fmr_response`/`response_map`.
4. Brak rozpoznawalnego produktu oznacza brak aktywnych wyników, a nie wybór
   domyślnego FMR.

Po rozpoznaniu produktu modalnego `requested_execution.calculation_mode` (lub
starszy `calculation_mode`) ogranicza podprodukty. `free_modes` i `fmr_modal`
nie publikują gałęzi `branches`/`dispersion`; są one widoczne wyłącznie dla
`dispersion_modal` albo dla starszego manifestu, który nie podał trybu. Dzięki
temu pozostawione przez poprzedni run ścieżki `dispersion.csv` nie aktywują
Dispersion w bieżącym Results. Jawnie nieznany tryb jest traktowany tak samo
jak brak opublikowanej gałęzi.

Resolver jest fail-closed także dla manifestu `pending`, `running`,
`interrupted` lub `failed`. Węzeł `Run Provenance` może pozostać widoczny, aby
użytkownik mógł obejrzeć stan wykonania, ale nie wolno pod nim pokazywać
artefaktów wynikowych.

## Reguły publikacji artefaktów

Rozpoznanie produktu nie oznacza, że wszystkie zasoby tego produktu zostały
zamówione. Każdy wynikowy podprodukt musi być zadeklarowany w gotowym
`result_manifest.payload`:

| Podprodukt | Wymagany wpis manifestu |
|---|---|
| spectrum | `artifacts.spectrum_v2_path` lub `resources.spectrum_resource_key` |
| branches | `artifacts.branches_v2_path` lub `resources.branches_resource_key` |
| dispersion | `artifacts.dispersion_csv_path` lub `resources.dispersion_resource_key` |
| response sweep | `artifacts.response_sweep_v1_path`/`v2` lub `resources.response_sweep_resource_key` |
| response map | `artifacts.response_map_v1_path`/`v2` lub `resources.response_map_resource_key` |

Zasób przekazany przez cache, lecz niezgodny z deklaracją bieżącego manifestu,
jest ignorowany. Dzięki temu samo zamontowanie endpointu dispersion nie tworzy
węzła `Dispersion`, jeżeli bieżąca symulacja nie zapisała `dispersion.csv`.

Reguły drzewa są następujące:

- produkt modalny dostaje wyłącznie zadeklarowane `spectrum`, `branches`,
  `dispersion` i mode fields, dodatkowo ograniczone przez jawny tryb
  `requested_execution.calculation_mode`;
- produkt wymuszony dostaje wyłącznie zadeklarowany response sweep oraz
  postęp/cancel tego samego runu;
- `Calculation Modes` powstaje tylko dla rozpoznanego produktu i ma dzieci
  wyłącznie dla zadeklarowanych podproduktów;
- `Exports` nie pokazuje artefaktów produktu nieaktywnego;
- `FMR` otrzymuje badge `modal` albo `driven` wyłącznie z aktywnego produktu.

Reference solvers are subject to the same publication gate. A solver may emit
the spectrum or analytic validation curve without emitting mode fields. The
runner must not create a hidden mode bundle when the request contains only
`EigenSpectrum`/`DispersionCurve`; if `EigenMode` is explicitly requested, the
mode payload must carry a valid source mesh identity and otherwise fails closed
with no partial mode publication.

Węzły capability i zasoby pomocnicze pozostają dozwolone w gałęzi
`Resources`/`Diagnostics`, ponieważ opisują dostępność lub provenance, a nie
opublikowany wynik. Nie mogą być źródłem węzłów `Results`.

## Właściciel implementacji

| Odpowiedzialność | Plik/symbol |
|---|---|
| Resolver aktywnego produktu i artefaktów | `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`, `activeFrequencyDomainProduct`, `publishedFrequencyDomainArtifact` |
| Projekcja drzewa Results | ten sam plik, `buildFrequencyDomainResultNode`, `buildFrequencyDomainCalculationModesNode` |
| Publikacja faktycznych podproduktów | `crates/fullmag-runner/src/eigen/artifacts.rs`, `modal_manifest_execution`, `write_frequency_domain_eigen_manifest` |
| Publikacja manifestu ścieżki i klasyfikacja próbek | `crates/fullmag-runner/src/dispatch.rs`, `build_eigen_path_frequency_domain_manifest`, `eigen_path_calculation_mode` |
| Modele spectrum/response | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` |
| Zasób HTTP v2 | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`, `useFrequencyDomainManifestResource` |
| Kontrakt API | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`, `FrequencyDomainManifestResource` |
| Typ OpenAPI | `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts` |

Frontend nie wykonuje dodatkowego requestu w resolverze, nie czyta capability
przez `fetch()` i nie zmienia statusu artefaktu. HTTP v2 pozostaje źródłem
prawdy, a zdarzenia realtime wyłącznie unieważniają revision.

## Responsywność panelu Explorer

Explorer jest kontenerem responsywnym, a nie tylko elementem zależnym od
szerokości viewportu. Przy szerokości dokowania poniżej 360 px status i badge
mają ograniczoną szerokość, tekst otrzymuje ellipsis, a status pomocniczy jest
ukrywany, aby nie wypchnąć nazwy węzła. Pełna wartość pozostaje dostępna przez
`title`. Poniżej 300 px badge jest jeszcze skracany. Nie powstaje poziomy
overflow wiersza.

### Inspector modalnego spektrum

Karta wykresu modalnego ma jawny podział na wiersz powierzchni ECharts i wiersz
podsumowania. Każdy punkt spektrum jest własną siatką `Select`/`Load in 3D`, a
reguła stylowania kart dotyczy wyłącznie bezpośrednich elementów podsumowania;
zagnieżdżone etykiety tekstowe nie mogą otrzymać obramowania karty. Przy
szerokości panelu do 360 px akcje punktu układają się pionowo. Stopka
Inspectora przechodzi do dwóch kolumn przy szerokości do 560 px i ma wysokość
automatyczną, dzięki czemu `Apply` pozostaje w panelu. Ten kontrakt jest
sprawdzany przez `inspectorDesignSystemContract.test.ts` oraz kontrakt CSS w
`FrequencyDomainCharts.test.tsx`; pełny browser smoke nadal wymaga kompletnego
checkoutu zależności UI.

## Testy regresyjne

`buildModelTree.test.ts` pokrywa:

- gotowy `modal_eigen` z jednocześnie przekazanymi zasobami modalnymi i
  response: tylko `results:eigen`;
- gotowy `driven_response` z tym samym zestawem: tylko
  `results:frequency-response`;
- gotowy modal z zasobem dispersion, ale bez deklaracji artefaktu: bez węzła
  `Dispersion`;
- gotowy `free_modes` z pozostawionymi ścieżkami `branches`/`dispersion`: bez
  węzłów `Dispersion` i `Branches`;
- brak `result_manifest`: brak obu gałęzi i `Calculation Modes`;
- manifest niegotowy: brak obu gałęzi niezależnie od payloadu i zasobów;
- jawnie nieznane `study_product`: brak obu gałęzi, bez fallbacku do starego
  `requested_execution`;
- progress-only driven response: widoczny jest wyłącznie postęp response;
- modalny badge FMR ma wartość `modal`;
- responsywne reguły panelu 360/300 px i tooltip pełnego badge.

Weryfikacja lokalna:

```bash
TMPDIR=/tmp node \
  /home/kkingstoun/git/fullmag/fullmag/node_modules/.pnpm/vitest@4.1.5_@types+node@22.15.0_vite@8.0.16_@types+node@22.15.0_esbuild@0.28.1_jiti@2.6.1_/node_modules/vitest/vitest.mjs \
  run --root /zfn2/mateuszz/git/fullmag/.worktrees/eigensolve-k0-demag-recovery/apps/control-room \
  src/modules/explorer/builders/buildModelTree.test.ts \
  src/modules/explorer/ExplorerTreeView.test.ts
```

Testy źródłowe nie zastępują typecheck ani browser smoke. Błąd zależności lub
montowania środowiska należy raportować jako blocker weryfikacji, nie jako
regresję resolvera.

Regresja klasyfikacji obejmuje również testy runnera:

- `eigen_manifest_does_not_publish_dispersion_for_multi_sample_k0_field_sweep`;
- `k0_multi_sample_path_is_not_classified_as_dispersion`.
- `de_bv_low_k_dispersion_validation_uses_analytic_reference_solver` verifies
  spectrum/validation publication and fail-closed analytic mode fields;
- `k_path_gamma_frequency_window_rejects_uncertified_equilibrium_before_native_entrypoint`
  verifies the equilibrium gate before native dispatch.

## Browser evidence i granica claimu

Fixture smoke może potwierdzić, że dla manifestu modalnego drzewo zawiera
`Modal Eigen Results` i spectrum, a nie zawiera `Driven Frequency Response`
ani niezamówionej `Dispersion`. Taki smoke nie potwierdza native FEM, GPU
residency ani produkcyjnego pola 3D.

Kwalifikacja produktu wymaga dodatkowo świeżego artefaktu z `status=ready`,
`study_product`, zgodnymi `source_mesh_identity` i revision, realnego API
smoke bez fixture substitution oraz WebGL proof (`gl.isContextLost() === false`,
niezerowy drawing buffer i rzeczywisty handoff pola modu do jednego viewportu).
Osobne bramki CPU/GPU pozostają opisane w
`docs/physics/0700-frequency-domain-linearized-llg.md` i
`docs/physics/0830-fem-poisson-airbox-modal-eigen.md`.

Runner publikuje `branches_v2_path`, `dispersion_csv_path` oraz odpowiadające
resource keys tylko dla `dispersion_modal`; dla `free_modes` manifest zawiera
wyłącznie `spectrum` i `mode_fields`. Dotyczy to także wielopunktowego skanu
pola przy stałym wektorze Blocha `k=(0,0,0)`: liczba próbek ani wartość
`path_s` nie zmieniają takiego skanu w dispersion. `path_s` jest wtedy jedynie
współrzędną kolejnych próbek skanu pola, a `k_sampling` pozostaje `single`.
Tryb `dispersion_modal` i `k_sampling=path` wymagają co najmniej jednej
niezerowej składowej `k_vector`. Fizyczne pliki pomocnicze z poprzedniego
przebiegu nie stają się przez to częścią bieżącego produktu.

Naprawa projekcji i responsywności usuwa błąd prezentacji, ale sama nie nadaje
statusu `production_qualified` żadnemu backendowi.

## Migracja i utrzymanie

Backend powinien zawsze zapisywać `study_product` oraz wpisy artefaktów w
gotowym manifeście. Fallback do `requested_execution` jest wyłącznie
kompatybilnością odczytu dla starszych artefaktów i może zostać usunięty po ich
wycofaniu i aktualizacji testów migracyjnych. Nowe produkty wymagają nowej
wartości kontraktu, osobnych węzłów i testu fail-closed; nie wolno dopisywać
ich do unii modal/response bez aktualizacji tej specyfikacji.
