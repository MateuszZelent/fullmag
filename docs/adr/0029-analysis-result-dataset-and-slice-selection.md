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

## Rozwinięcie: przypięte metadane pola w CAS

Tensor wyniku może zawierać opcjonalny, wersjonowany `field_binding`.
Dokładny SHA-256 rootu obejmuje zarówno dotychczasowy `TensorDescriptor`,
jak i opis pola producenta; nie tworzy się osobnego magazynu Results ani
referencji do aktywnego runtime'u. Odczyt pola wymaga przypiętego właściciela
SolutionSet i zgodnej tożsamości dataset/sample/item/field. Dla pary real/imag
obie płaszczyzny mają tego samego właściciela, grupę i opis semantyczny.

Pole nie dodaje krawędzi CAS: jedyne payloady pozostają w `chunks`.
Dotychczasowe bramki publikacji, recovery, GC i FMS walidują również binding
przy parsowaniu typed rootu. Brak bindingu nie upoważnia do odgadywania
jednostek ani przestrzeni z nazwy tensora. Oryginalne statusy wykonania
i ocena naukowa pozostają oddzielne od integralności danych.

Jest to kontrakt magazynu sesji, bez nowego endpointu i bez zmiany OpenAPI.
Pełny MaterializedDataset, generator metadanych producenta oraz publiczny
consumer pozostają osobnymi obowiązkami wdrożenia. Starsze rooty bez
bindingu pozostają czytelne; starszy strict reader nie odczyta nowych rootów
z bindingiem. Włączenie nowych writerów wymaga wcześniejszego wdrożenia
readerów i wyklucza zapis do historycznej, zamkniętej rewizji.

Kontrakt szczegółowy: [przypięty tensor](../specs/pinned-solution-tensor-v1.md).

## Rozwinięcie: trwały manifest zapisanego datasetu

Pierwszy MaterializedDataset zapisanego pola jest strict artefaktem CAS
`fullmag.materialized_dataset.v1` wewnątrz istniejącego SolutionSet.
Manifest zawiera niezmienną definicję, dataset oraz dokładne źródło tensora
z dodatnią rewizją SolutionSet, RunSpec, member/artifact/root i coverage.
Nie powstaje drugi katalog Results ani oddzielny CURRENT datasetów.
Indeks datasetów jest projekcją tego samego katalogu wyników.

Manifest i tensor są publikowane w jednej rewizji SolutionSet pod istniejącą
bramką writer lease. Pierwsza publikacja waliduje źródło względem dokładnej
publikowanej rewizji; kolejne rewizje zachowują niezmienny manifest i jego
pierwotną przypiętą rewizję. Nie jest to cykl hashy CAS: referencja właściciela
wskazuje tożsamość katalogu i rewizję, a payloady wskazują konkretne hashe.

Pierwsza realizacja obejmuje jedno pole rzeczywiste i jeden sample/item.
`Ready` oznacza dostępność zweryfikowanych danych, nie sukces wykonania,
zbieżność ani kwalifikację. Oryginalne statusy i oceny pozostają w dokładnym
właścicielu SolutionSet. Nie dopisuje się manifestu do historycznych memberów
lub rewizji przy odtwarzaniu; istniejące wyniki pozostają zgodne.

Przed włączeniem producenta obowiązują typed publication, recovery, pin
retirement, GC oraz FMS export/import obejmujące manifest → tensor → chunks
wraz z dokładnym właścicielem runu. Nieznane schema pozostają opaque;
nowy manifest nie może korzystać z tego wyjątku. Rollback wyłącza producenta,
zachowując reader i traversal już opublikowanych manifestów.

Kontrakt magazynu nie dodaje endpointu ani generated types. Publiczne
zasoby datasetu i consumer UI pozostają zależnym etapem P6. Wymagane są
source regression dla konfliktu ownera/rewizji/coverage oraz osobne bramki
runtime, eksport/import i pamięci; source check nie zastępuje tych dowodów.

## Referencje

- `docs/audits/2026-09-01-results-mode-sweep-ui-audit-and-refactor-plan.md`;
- `docs/specs/resource-first-control-room-api-v2.md`;
- `docs/specs/frontend-v2/03-api-integration-layer.md`;
- `docs/specs/frontend-v2/04-state-management.md`.
