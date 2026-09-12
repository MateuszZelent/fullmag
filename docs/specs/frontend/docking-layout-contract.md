# Spec: Kontrakt układu Docking (Control Room)

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


## Cel

Układ dockingu w Control Room ma być:

- zawsze możliwy do ręcznej zmiany szerokości i wysokości,
- odporny na uszkodzone lub starsze zapisy w localStorage,
- powtarzalny po przełączeniach `desktop` / `tablet` / `mobile`,
- odzyskiwalny bez utraty możliwości pracy użytkownika.

## Zakres

- komponenty: `apps/web/components/workspace/docking/*`
- przechowywanie układu: `apps/web/lib/workspace/workspace-store.ts`
- walidacja i naprawa kontraktu: `apps/web/lib/workspace/dockLayoutContract.ts`
- panel roboczy: `apps/web/components/workspace/docking/WorkspaceDockingShell.tsx`
- domyślne i alternatywne szablony: `apps/web/components/workspace/docking/dockLayoutDefaults.ts`

## Zasady minimum wymiarów

Wymagane minima stosowane w kontrakcie:

- `dock-left`: `minWidth >= 220`
- `dock-right`: `minWidth >= 220`
- `dock-center`: `minWidth >= 360`
- `dock-bottom`: `minHeight >= 180`
- przy każdej krawędzi (border) `size` musi być co najmniej `minSize`.

W trakcie zapisu i odczytu `parseDockLayoutRecordForPreset`/`normalizeDockLayoutEnvelope`:

- klonujemy model,
- normalizujemy `global`,
- klamrujemy niewłaściwe rozmiary do minimalnych wartości,
- zapisujemy metryki naprawy.

## Zasady trwałości układu

1. Stan dockingu jest traktowany jako `DockLayoutEnvelope`.
2. W `localStorage` przechowujemy:
   - `dockingLayoutSchemaVersion`,
   - `templateId`,
   - `model` jako `IJsonModel`,
   - `lastRepairReason` i `lastRepairAtUnixMs`,
   - `wasRecovered`.
3. Przy każdym odczycie uruchamiana jest walidacja:
   - obecność wszystkich wymaganych komponentów (`dock-left`, `dock-center`, `dock-right`, `dock-bottom`),
   - poprawność struktury modelu,
   - zgodność z minimami.
4. Jeżeli stan jest niepełny lub niepoprawny:
   - wykonujemy naprawę i zapisujemy zaktualizowaną wersję,
   - przy krytycznej niespójności wracamy do szablonu przypisanego do preset i towarzyszy temu metryka naprawy.

## „Naprawialne” vs „niewodwracalne”

- **Naprawialne**:
  - brak części komponentów,
  - brak pola `global`,
  - niepoprawne minima,
  - starsza wersja schematu.
  - `templateId` spoza aktualnego zestawu (fallback do template odpowiadającego presetowi).
- **Niewodwracalne** (fallback hard):
  - uszkodzony payload nie parsowalny jako JSON,
  - brak obiektu układu dla danego presetu po wszystkich etapach próby naprawy.

W obu przypadkach fallback do odpowiedniego szablonu `default-*` i jawny reset metryk.

## Standardy resize UI

- `touch-action: none` na splitterach i uchwytach,
- `user-select: none`,
- minimum szerokości/ wysokości splittera (`3px`) + wyraźna strefa chwytu,
- osobne style dla „normalnego” splittera i klasy `flexlayout__splitter_drag`,
- hover/active mają wyraźny kontrast i widoczną zmianę tła,
- overlay diagnostyczny pokazuje:
  - preset,
  - template,
  - wersję kontraktu,
  - czy ostatnio wykonano naprawę.

## Template checklist

Dodawanie nowego szablonu:

1. dodać `templateId` w `DockLayoutTemplateId`,
2. zdefiniować model (`IJsonModel`) i panel entries,
3. przypisać domyślny preset (`desktop` / `tablet` / `mobile`),
4. dodać minimalne wymiary komponentów,
5. dopisać dokumentację migracji i przeznaczenia.

