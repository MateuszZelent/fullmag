# Antena — luka publikacji samodzielnej bazy pola, 2026-10-02

## Wynik audytu kodu

Samodzielny `AntennaFieldSolve` zapisuje niezmienny artefakt
`antenna_field_solution.v1`. Jego zasób HTTP publikuje identyfikatory,
podpisy, metadane siatki i referencje do binarnych `sample_positions` oraz
`magnetic_field_per_ampere` dla każdego portu. W bieżącym kodzie nie ma
jednak podłączenia tej bazy do kanonicznego katalogu quantity i binarnego
field-store używanego przez Field Map/viewport. Inspector rozwiązania
pokazuje cienkie metadane, a nie mapę próbek `H_ant_basis`.

Istniejące `H_ant` oznacza chwilowe pole antenowe w aktywnym runtime,
sumowane i skalowane przebiegiem prądu. Nie jest tym samym co
`H_ant_basis` o jednostce A/m/A. Dla jednego portu i prądu $I(t)$
oczekiwana zależność wynosi
$\mathbf H_{\mathrm{ant}}(\mathbf r,t)=I(t)\mathbf H_{\mathrm{basis}}(\mathbf r)$,
a indukcja prezentowana w teslach to
$\mathbf B_{\mathrm{ant}}=\mu_0\mathbf H_{\mathrm{ant}}$ w przyjętym
modelu pola w próżni. Nie wolno podpisywać bazy na amper jako pola
przy zadanym prądzie ani udawać, że sama konwersja jednostek publikuje
nowe dane solvera.

## Kontrakt do domknięcia w T09/T14/T15

1. Udostępnić binarne próbki konkretnego `solution_id` i `port_mode_id`
   przez kanoniczną rodzinę `data`, z weryfikacją rozmiaru/hash oraz
   tożsamością sesji, manifestu i portu. Obecne `data/artifacts` może
   służyć jako transport tylko po sprawdzeniu, że scoped URL i walidacja
   referencji odpowiadają temu kontraktowi; nie traktować dowolnej ścieżki
   artefaktu jako gotowego quantity.
2. Zmaterializować `H_ant_basis` w field-store z jawnym nośnikiem
   próbkowania, maską/zakresem i stanami `inside`, `outside_domain`,
   `missing_payload`, `unsupported_topology`. Osobno udostępnić
   chwilowe `H_ant` po zastosowaniu aktywnych drive'ów. Nazwa prezentacyjna
   typu `B_zeeman_antena_1` wymaga stabilnego mapowania do `object_id`
   i portu, bez wyprowadzania fizyki z nazwy obiektu.
3. Field Map i viewport muszą przechodzić przez istniejący typed facade,
   resource hook i adapter quantity. Wybór A/m lub T jest wyłącznie
   konwersją prezentacyjną z jawnie pokazaną jednostką; airbox wymaga
   zakresu próbek obejmującego powietrze, a nie dorabiania zer poza
   opublikowanym nośnikiem.
4. Bramka integracyjna: samodzielny solve bez LLG → katalog quantity →
   binarny odczyt → Field Map/viewport pola bazy → późniejsze Relax/Run
   korzystające z tej samej sygnatury bazy. Test musi odrzucać mieszanie
   rewizji sesji/manifestu i odróżniać pole bazy od pola przy $I(t)$.

## Dowody i ograniczenia

- `crates/fullmag-runner/src/antenna_field_solution.rs` —
  `load_antenna_field_solution_samples` dekoduje pozycje, pole na amper
  i opcjonalną topologię po weryfikacji hashy.
- `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` —
  `get_antenna_field_solution` zwraca cienki zasób `H_ant_basis` z
  referencjami binarnymi, a `get_antenna_source_spectrum_payload`
  demonstruje osobny, wersjonowany transport binarny tylko dla FFT.
- `crates/fullmag-runner/src/interactive_runtime.rs` —
  `begin_cached_preview_prefetch` oraz ścieżka `H_ant` dotyczą pola
  aktywnego runtime; nie materializują samodzielnej bazy jako quantity.
- `apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx`
  — `AntennaCompositionPanel` konsumuje metadane solution i stage.
- `apps/control-room/src/kernel/api/quantityIds.ts` — katalog zawiera
  `H_ant` (A/m), lecz nie `H_ant_basis` (A/m/A).
- `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
  — tabela quantity rozdziela `H_ant` i `H_ant_basis`.

To jest audyt statyczny źródeł z 2026-10-02, nie wykonany browser smoke
ani dowód natywnego solve. Obecny brak nie może być oznaczony jako
ukończona wizualizacja pola anteny.
