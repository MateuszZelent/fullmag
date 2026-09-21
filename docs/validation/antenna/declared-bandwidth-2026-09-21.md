# Deklarowane pasmo waveformu anteny — walidacja 2026-09-21

## Zakres

Domknięto lukę T11 dotyczącą sygnału próbkowanego lub piecewise-linear,
którego idealne widmo nie ma skończonego ograniczenia wynikającego z samego
czasu trwania albo odstępu próbek. Statyczna baza pola anteny pozostaje
niezależna od waveformu; deklaracja służy wyłącznie do diagnostyki ważności
przybliżenia separowalnego pola.

## Kontrakt

W `SolvedAntennaDriveIR` dodano opcjonalne:

```json
{
  "bandwidth_declaration": {
    "f_max_hz": 6000000000.0
  }
}
```

Kontrakt jest oznaczony w provenance jako
`antenna_waveform_bandwidth_declaration.v1`. `f_max_hz` musi być skończone i
nieujemne. Pole jest dozwolone dla `Pulse` i `PiecewiseLinear`; dla sinusoidy,
sinc oraz stałego sygnału obowiązują ich własne, analityczne źródła pasma.
Brak deklaracji pozostawia stan `validity_bandwidth_unknown`.

W Python DSL odpowiednikiem jest:

```python
fm.SolvedAntennaDrive(
    id="drive_1",
    name="piecewise drive",
    projection_ref="projection_1",
    port_mode_id="port_1",
    peak_current_a=1.0,
    waveform=fm.PiecewiseLinear([(0.0, 0.0), (1e-9, 1.0)]),
    bandwidth_declaration=fm.AntennaWaveformBandwidthDeclaration(6e9),
)
```

Klasyfikator nie używa `1 / duration`, odstępu węzłów ani częstotliwości
Nyquista jako fizycznego `f_max`. Nieważna deklaracja jest jawnie zgłaszana
jako `invalid_declared_bandwidth_hz`, a walidacja IR zwraca błąd ścieżki pola.

## Ślad implementacyjny

- `crates/fullmag-ir/src/field_drive_validation.rs` — typ deklaracji, wersja
  kontraktu i klasyfikator z rozróżnieniem `source=declared`;
- `crates/fullmag-ir/src/antenna.rs` — walidacja zakresu i zgodności z
  waveformem;
- `crates/fullmag-plan/src/antenna_validity.rs` — odświeżanie noty przy każdej
  zmianie waveformu oraz obliczenia `eta_wave`/`eta_skin`;
- `packages/fullmag-py/src/fullmag/model/antenna.py` — publiczny konstruktor
  DSL i serializacja do IR;
- `docs/superpowers/plans/2026-09-08-microwave-antenna-refactoring-plan.md` —
  odhaczenie punktu T11 i ograniczenie zakresu T14.

Deklaracja nie jest częścią immutable manifestu `H_ant_basis`; zmiana pasma
odświeża diagnostykę planu, ale nie unieważnia statycznej bazy prąd/pole.

## Agregacja wielu portów

Planner publikuje dodatkowo `antenna_waveform_bandwidth_aggregate.v1`. Nota
obejmuje drive’y potencjalnie aktywne dla danego `StudyIR`, wypisuje ich ID oraz
porty i używa konserwatywnego:

$$f_{max,aggregate}=\max_i f_{max,i}.$$

`AllTimeEvolution` jest filtrowane według rodzaju study. `StageIds` pozostaje
potencjalnie aktywne, ponieważ singularny `ProblemIR` nie ma jeszcze
konkretnego stage boundary. Jeśli jeden z portów ma nieznane pasmo, agregat
jest `status=unknown`; nie jest emitowana częściowa liczba, która sugerowałaby
pełne ograniczenie wspólnego źródła `H_ant_basis`.

## Weryfikacja

- parser `rustfmt` z `skip_children=true` dla wszystkich zmienionych plików
  Rust: **OK**;
- parser AST Python dla DSL i regresji: **OK**;
- `git diff --check`: **OK**;
- `pnpm --dir apps/control-room generate:api`: **OK**; wygenerowano OpenAPI
  v2 oraz `openapi-v2-types.ts`;
- `check:api-hygiene`: **not qualified** przez wcześniejsze literalne URL-e w
  testach viewportu, niezwiązane z anteną;
- pełne testy Rust oraz kontenerowy runtime nie zostały uruchomione w tej
  sesji zgodnie z obowiązującą blokadą kompilacji testów jednostkowych.

## Granice

Pole jest teraz formalnie typowane jako opcjonalny
`AntennaWaveformBandwidthDeclarationResource` w OpenAPI v2 i wygenerowanym
TypeScript. Dedykowany panel `SolvedAntennaDrive` pokazuje read-only wartość
deklaracji: skończone `f_max_hz`, `not declared` lub `invalid declaration`.
Formatter nie wyprowadza pasma z czasu impulsu ani próbkowania. Edycja,
walidacja konfliktu i pełny browser smoke pozostają zadaniem T14/T15; obecna
zmiana zapewnia kanoniczny IR, planner provenance, kontrakt API i bezpieczną
prezentację bez udawania fizycznego pasma.

Weryfikacja panelu:

- ukierunkowany Vitest `AntennaCompositionPanels.test.ts`: **5/5**;
- ESLint dla zmienionych plików Inspectora: **OK**;
- repozytoryjny typecheck zatrzymał się na istniejących błędach
  `FieldMapModule.tsx:588-591`, niezwiązanych z tą zmianą.
