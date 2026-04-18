# ADR 0005: Stabilny lifecycle układu Docking i bezpieczeństwo persystencji

| Field     | Value |
| --------- | ----- |
| Status    | Accepted |
| Date      | 2026-04-18 |
| Deciders  | Frontend/runtime team |
| Relates   | `docs/specs/frontend/docking-layout-contract.md` |

## Kontekst

W ostatnim czasie odnotowano regresję: ręczne zmiany wielkości paneli (`splitter`) przestają działać po zmianie układu lub przy odtworzeniu zapisu. Dodatkowo lokalny zapis układu mógł pozostawać w stanie częściowo uszkodzonym (brak komponentu, błędny kształt JSON, brak nowych pól).

Najważniejsze problemy:

- brak wyraźnej warstwy walidacyjnej dla modelu flexlayout,
- bezpośrednie użycie `Model.fromJson` na danych z `store` bez pełnego recovery,
- ograniczona widoczność metryk diagnostycznych podczas działania.

## Decyzja

Wprowadzamy warstwę `dock layout contract` i runtime hook:

1. `DockLayoutEnvelope` staje się podstawowym typem stanu zapisywanego.
2. Wszystko wejście do modelu idzie przez:
   - `normalizeDockLayoutEnvelope`
   - `parseDockLayoutRecordForPreset`
3. `WorkspaceDockingShell` przestaje ręcznie parsować layout i korzysta z hooka
   `useDockLayoutRuntime`.
4. W `workspace-store` zapisuje się już zwalidowany envelope (w tym:
   schema version, template id, metryki napraw).
5. Reagujemy na zmianę `stage`/`preset` poprzez automatyczny `repair in-place`.
6. Dodajemy kontrolki diagnostyczne w shellu:
   - przywracanie domyślnego układu,
   - reset zapisu i ponowne ustawienie domyślnych paneli,
   - podgląd wersji i informacji o ostatniej naprawie.

## Utrzymane zasady

- Semantyka logiczna UI pozostaje stabilna (`workspace` → panele: lewy/środek/prawy/dół).
- Zmiany w kontrakcie są wersjonowane przez `dockingLayoutSchemaVersion`.
- Rewalidacja trwa po każdym odczycie i po zmianie presetu.

## Trade-offs

- Większa ilość metadanych w persisted state (kosztowy zapis, ale kontrolowany).
- Dodatkowa logika naprawy może modyfikować układ przy starcie, ale tylko do bezpiecznej postaci
  (nie zmienia celowo intencji użytkownika).
- Brak globalnych toasts — diagnostyka jest widoczna inline przy `WorkspaceDockingShell`.

## Konsekwencje

### Dla odtwarzalności

- Uszkodzony zapis ma deterministyczny fallback.
- Starsze zapisy przechodzą migrację do bieżącej wersji.

### Dla doświadczenia użytkownika

- `splitter`y pozostają reagujące po odświeżeniu i przy zmianie stage/preset.
- Można szybko przywrócić bezpieczny stan bez ręcznej interwencji w kod.

### Dla przyszłego rozwoju

- Kolejne szablony (np. `analysis-heavy`, `inspector-focus`) są łatwiejsze do dodania
  i weryfikacji.
- Dokumentacja front-endowa wskazuje minimalne wymagania przy dodawaniu nowego panelu.

## Zależne pliki

- `apps/web/components/workspace/docking/useDockLayoutRuntime.ts`
- `apps/web/components/workspace/docking/WorkspaceDockingShell.tsx`
- `apps/web/lib/workspace/dockLayoutContract.ts`
- `apps/web/lib/workspace/workspace-store.ts`
- `apps/web/components/workspace/docking/dockLayoutDefaults.ts`
- `docs/specs/frontend/docking-layout-contract.md`

