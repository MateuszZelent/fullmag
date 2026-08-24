# Plan audytu publicznego Sphinx — fala 2D

> **Dla agentów wykonawczych:** realizować inline zgodnie z `scientific-documentation-contract`; bez subagentów, stage, commita i wspólnego builda Sphinx.

**Cel:** Zweryfikować i skorygować 25 stron Python API dotyczących dynamiki, wyników, runtime i badań na podstawie aktualnego DSL, ProblemIR, plannera/runtime oraz kontraktu zasobowego v2.

**Architektura:** Źródłem prawdy pozostają noty fizyczne/specyfikacje, aktualne klasy `packages/fullmag-py`, lowering ProblemIR i runtime. Dokumentacja ma rozdzielać zamiar autora od rozwiązanej realizacji oraz od zasobów wynikowych; HTTP v2 pozostaje źródłem snapshotów, a realtime wyłącznie sygnalizuje zdarzenia i invalidację.

**Stos:** MyST/Sphinx, Python DSL, ProblemIR, walidator map naukowych, `unittest`, repozytoryjny guard przykładów.

## Ograniczenia globalne

- Publiczne strony po angielsku; raport i plan po polsku.
- Zmieniać wyłącznie 25 stron bucketu 2D i ich istniejące mapy, gdy wymagają synchronizacji.
- Każdy przykład symulacyjny ma używać `fm.study(...).stages`.
- Nie uruchamiać builda Sphinx, nie stage’ować i nie commitować.

### Zadanie 1: Inwentarz i źródła prawdy

**Pliki:** 25 ścieżek z sekcji 2D w `.superpowers/sdd/public-sphinx-wave2-briefs.md`.

- [ ] Przeczytać każdą stronę, mapę, stronę nadrzędną i bezpośrednie implementacje.
- [ ] Zapisać sygnatury, defaulty, walidację, lowering, status i zasoby runtime dla każdej strony.

### Zadanie 2: Minimalne korekty

**Pliki:** wyłącznie potwierdzone rozjazdy w bucket 2D i potrzebne istniejące `.source-map.json`.

- [ ] Skorygować niezgodne parametry, defaulty, walidację, stage-first i Python→ProblemIR.
- [ ] Zachować jawne ograniczenia dla nieudowodnionych pasów i zasobów.

### Zadanie 3: Weryfikacja

- [ ] Uruchomić ukierunkowane testy `packages/fullmag-py`, `scripts/check_public_doc_examples.py`, walidatory dotkniętych map oraz `git diff --check`.
- [ ] Potwierdzić, że zmiany dokumentacyjne nie zmieniają OpenAPI, wygenerowanego transportu, hooków, kodeków ani adapterów.

### Zadanie 4: Artefakty odbioru

**Tworzone:**
- `.superpowers/sdd/public-sphinx-wave2d-report.md`
- `.superpowers/sdd/public-sphinx-wave2d-review.diff`

- [ ] Raport ma zawierać tabelę 25/25, źródła, testy i jawne concerns.
- [ ] Pakiet recenzji ma zawierać pełną listę zmienionych plików i dokładnie jeden nagłówek `diff --git` na rzeczywisty plik diffu.
