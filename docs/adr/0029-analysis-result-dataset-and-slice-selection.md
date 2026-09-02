# ADR 0029 — Tożsamość datasetu wyników i selekcji slice

**Status:** accepted for implementation

**Date:** 2026-09-01

**Decision makers:** Fullmag core

## Kontekst

Artefakt `eigen/field_sweep.v1.json` jest zapisywany przez runner z pełną
informacją o osi skanu, próbkach, modach, referencjach pól, topologii,
rewizjach i wykonaniu. Warstwa API udostępniała jednak tylko kilka pól oraz
otwarte `extra`, a Results wyprowadzał listę próbek z osobnego spectrum.
Powodowało to utratę jednostek i proweniencji oraz możliwość rozjechania
próbki, modu i pola po zmianie kolejności.

## Decyzja

Wynik analizowany przez UI ma rozdzielone pojęcia:

- `dataset` — immutable produkt analizy wraz z własną rewizją i referencjami
  źródłowymi;
- `axis` — semantyczna oś z kanoniczną jednostką i jawnymi konwersjami
  wyświetlania;
- `sample` — rozwiązany punkt osi, identyfikowany przez `sample_id`;
- `item` — element wyniku w próbce, dla modal eigen identyfikowany przez
  `mode_id`;
- `branch` — osobna relacja trackingu między próbkami;
- `field` — opcjonalna referencja do rzeczywiście zapisanego pola.

`sample_index`, `raw_mode_index`, float i etykieta prezentacyjna są wyłącznie
locatorami lub formatowaniem. Nie uczestniczą w identity ani w joinach.

Pierwszy rollout wdraża tę decyzję dla istniejącego bias-field sweepu bez
wprowadzania ogólnego endpointu dataset-index. API dostaje typowane pola
writer-a, frontend konsumuje wygenerowane typy, a Field Sweep jest źródłem
listy próbek i modów. Spectrum oraz branches mogą uzupełniać dane tylko po
stabilnych ID i zgodnej `source_revision`; konflikt daje `partial/stale`, nie
join po indeksie.

Referencja pola jest legalna tylko wtedy, gdy producent potwierdził
niepusty, skończony, kartezjański payload `real/imag`. Brak referencji oznacza
`spectrum-only`; UI nie tworzy zerowego pola i nie uruchamia wizualizacji.

## Konsekwencje

- Zmiana kolejności próbek lub modów nie zmienia selekcji.
- Wartość `[Hx, Hy, Hz]` pozostaje kanonicznie w A/m; UI pokazuje jawną
  projekcję, np. `μ₀ Hx = 50 mT`.
- Statusy `complete`, `partial`, `interrupted`, `corrupt`, `missing` i
  `unsupported` nie są upraszczane do `ready`.
- Ogólny `result_dataset_index`, server-side paging i wspólna selekcja dla
  Analysis są kolejnymi fazami i nie są ukrywane w tym rolloutcie.
- Istniejące endpointy indeksowe pozostają compatibility boundary do czasu
  wdrożenia typed field resource dla nowego modelu.

## Obowiązki implementacyjne

1. Utrzymać pełny typed payload w OpenAPI v2 i regenerować klienta/types.
2. Zachować `source`, `source_revision`, dataset `revision`, counts, axis,
   units, topology, requested/resolved execution oraz cross-artifact refs.
3. Wiązać `mode_field_id` i `mode_field_resource_key` z walidacją payloadu.
4. Budować Results z field-sweep samples, z małymi ID w selection ref.
5. Prowadzić status i reason z zasobu; nie zgadywać sukcesu z obecności tablicy.

## Migracja i rollback

Minimalne stare artefakty z samym `schema_version` i `samples` pozostają
czytelne. Brak nowych pól daje jawny stan częściowy i brak legalnej selekcji
pola. Rollback polega na wyłączeniu nowego adaptera Results; typowane pola API
pozostają backward-compatible i nie zmieniają formatu istniejących artefaktów.

## Testy i walidacja

- serde/API round-trip pełnego fixture `eigen/field_sweep.v1`;
- negatywne przypadki brakującego/duplikowanego stable ID i konfliktu rewizji;
- adapter generated types zachowują axis, conversions, sample/mode refs,
  status i proweniencję;
- Results pokazuje 15 próbek z fizycznymi etykietami i właściwymi field refs;
- Inspector pokazuje counts, axis, units, tracking, topology i field
  availability;
- `cargo test -p fullmag-api frequency_domain`, focused Vitest, typecheck,
  lint i architecture/API hygiene.

## Referencje

- `docs/audits/2026-09-01-results-mode-sweep-ui-audit-and-refactor-plan.md`;
- `docs/specs/resource-first-control-room-api-v2.md`;
- `docs/specs/frontend-v2/03-api-integration-layer.md`;
- `docs/specs/frontend-v2/04-state-management.md`.
