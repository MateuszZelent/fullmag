# ADR 0056 — pochodzenie metody modalnej i oddzielna kompletność widma

Status: accepted w zakresie wdrożenia R2; implementacja i dowody CI w toku.
Data: 2026-10-10.

## Kontekst

Publiczne `damping_policy=include` nie dowodzi, że alfa uczestniczyło w pencil.
Rust reference dopisuje przybliżoną linewidth. Payload `complete` oraz zgodność
dwóch search passes nie dowodzą niezależnej liczności widma.

## Decyzja

Dodajemy wersjonowany obiekt `method_evidence` / `modal_method_evidence.v1`
do nowej diagnostyki reference i jego kopii w spectrum/summary/manifest.
Zachowujemy publiczne DSL/IR, historyczne schema i legacy solver labels.
Rozdzielamy requested damping od resolved method; zapisujemy brak alfa w pencil
oraz użycie tylko bazowego alfa. Count cap daje `count_limited`, brak count
poniżej cap daje `unknown`. Nie przyznajemy exact damping ani spectrum completeness.
Native producer wymaga osobnego adaptera własnego dowodu; nie wyciągamy jego
metody z nazwy solvera ani danych reference.

## Konsekwencje i migracja

Historyczne dokumenty bez obiektu pozostają legacy/unknown, bez backfill.
Nowy obiekt ma własną zamrożoną wersję; zmiana znaczenia wymaga następnej wersji.
Nie zmieniamy OpenAPI ani generated types w tym fragmencie; P10 musi podłączyć
pełną projekcję UI. Brak pola w UI nie może być dowodem exact ani complete.

## Weryfikacja i rollback

Testy źródłowe i serializacji w GHA, fałszywe exact/count claims odrzucane przez
negatywne fixtures. Fizyczna kwalifikacja P2/P3/P4 pozostaje odrębna.
Rollback usuwa nową emisję, nie przepisuje historycznych artefaktów.
