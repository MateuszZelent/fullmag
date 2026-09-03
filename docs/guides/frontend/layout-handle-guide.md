# Layout handle guide (Control Room Docking)

> **UWAGA (2026-09-03, audyt frontendu): dokument nieaktualny.**
> Opisuje wczesniejszy system dockingu oparty o `apps/web/components/workspace/docking/*`
> i `dockLayoutContract.ts` / `workspace-store.ts` (localStorage). Sciezki te juz nie
> istnieja w repozytorium. Biezacy uklad paneli Control Roomu jest zaimplementowany w
> `apps/control-room/src/kernel/layout/WorkspaceDockLayout.tsx` przy pomocy
> `react-resizable-panels` (grupy `ResizablePanelGroup`/`ResizablePanel`, `autoSaveId`
> do persystencji ukladu, min/default size w %). Ten dokument zostawiono jako
> kontekst historyczny; nie traktowac go jako obowiazujacej specyfikacji do czasu
> aktualizacji tresci ponizej.

---


## 1) Cel

Ten guide opisuje, jak poprawnie dodawać nowe panele do układu docking i jak
uruchamiać bezpieczne zmiany `splitter`/`panel` bez regresji.

## 2) Checklist „template”

Każdy nowy panel albo alternatywny układ musi mieć:

1. typ docka (`dock-left` / `dock-center` / `dock-right` / `dock-bottom`),
2. wpis w domyślnych modelach szablonów (`dockLayoutDefaults.ts`),
3. minimalny rozmiar (`minWidth` / `minHeight`) wg mapy paneli,
4. pozycję dla `desktop` / `tablet` / `mobile`,
5. nazwę i opis panelu (`label`),
6. wpis migracyjny, jeśli zmienia się układ paneli w szablonie.

## 3) Minimalne dane panelu

Dla każdego nowego typu panelu dodajemy:

- `component` (np. `dock-left`),
- `label`,
- preferowaną szerokość i/lub wysokość (`preferredWidthPx`, `preferredHeightPx`) w panel mapie template'u,
- przynajmniej jedną reprezentację `tab` w `IJsonModel`.

## 4) Walidacja

Po dodaniu zmian uruchamiamy checklistę:

- `parseDockLayoutRecordForPreset` dla niekompletnego modelu (brak jednego z required paneli),
- migracja ze starej wersji modelu,
- zapis/odczyt przez `workspace-store`,
- ręczny test przesuwania:
  - lewy splitter,
  - środkowy splitter,
  - prawy splitter,
  - splittery dolne.

## 5) Rozdział odpowiedzialności

- `dockLayoutContract.ts` — definicje, walidacja, clamp min-size, migracja.
- `workspace-store.ts` — serializacja/deserializacja i domyślne envelope.
- `WorkspaceDockingShell.tsx` — render + adapter i kontrolki diagnostyczne.
- CSS (`app/globals.css`) — touch/pointer/hover/drag dla splitterów.

## 6) Przypadki testowe

Nowe zmiany szablonu powinny mieć:

1. test jednostkowy naprawy brakujących paneli,
2. test migracji starej wersji,
3. test zachowania minima po „niedozwolonym” rozciągnięciu,
4. test klikalnej ścieżki przywracania domyślnego układu.

