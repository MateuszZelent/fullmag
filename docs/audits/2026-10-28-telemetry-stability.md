# Stabilność telemetrii — dowody przed integracją

## Zakres poprawki

`FooterTelemetry` zachowuje klasyfikację kompletnej sceny podczas odświeżenia
`ready → stale → ready`. Nie pojawiają się przez to chwilowo karty magnetyczne
w scenie, która została już rozpoznana jako niemagnetyczna. Brak danych nadal
pozostaje stanem nieznanym.

Przy tej samej rewizji pełna próbka live ma pierwszeństwo przed wierszem historii,
który nie zawiera opcjonalnych diagnostyk. Ściśle nowsza historia nadal wygrywa
w całości; poprawka nie miesza rewizji. Zestaw sześciu żądanych kolumn, jednostki,
filtrowanie próbek live według sesji i runu oraz rzeczywiste błędy obserwacji
runtime pozostają bez zmian.

## Weryfikacja źródeł

Baza: `b4eab956b209ee698fede9beb70ad149f8dc1069` (z PR #304).
Etap UI: `72b3bf9076e727efd36c4b0bf76eb9bde77e9431`.
Grupa: `fullmag-worktree-fullmag-465ed74fce6e7ce0`, port 3320.

- Typecheck: PASS.
- ESLint całego Control Room, zero ostrzeżeń: PASS.
- Vitest: **9221/9221 testów**, 888 plików, PASS.
- Regresje telemetrii: 52 testy, w tym rzeczywiście zamontowany komponent,
  zachowanie tożsamości korzenia DOM oraz zestawu kart podczas odświeżenia.
- Kontrole architektury i API: PASS.
- React Doctor: tryb `changed` nie rozpoznał brancha w cieniu źródeł kontenera
  i wykonał pełny skan (exit 1). Uwagi dotyczące FooterTelemetry wskazują
  istniejące wcześniej eksporty funkcji pomocniczych (`only-export-components`).
  Nie jest to zielony skan całej aplikacji ani powód do zmieniania innych modułów.

Receipty i logi bramek są w wolumenie kontrolnym grupy pod
`verification/frontend-telemetry-checks/` oraz `verification/telemetry-react-doctor.*`.
Pierwszy pełny Vitest miał jeden błąd konfiguracji ścieżki testowej launchera;
przekazanie `FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source` do istniejącego
readonly checkoutu pozwoliło wykonać pełny zestaw bez pomijania testu.

## Przeglądarka i granice dowodu

Utworzono wyłącznie pustą sesję testową
`session-18e2cce32618d87f00004c25` w grupie 3320. Nie wykonano Solve.
W obu motywach wykonano po 50 pomiarów co 200 ms po rozgrzaniu strony:
korzeń panelu, widoczność, zestaw etykiet i wysokość były stabilne.
Brak błędów JavaScript. Widoczny canvas: 703 × 527, kontekst WebGL niezagubiony.
Przeglądarka używała SwiftShader; to nie jest dowód sprzętowego renderowania GPU.

Artefakty operatora: `telemetry-browser-proof.json`, `telemetry-light.png`
i `telemetry-dark.png` w katalogu raportów `recovery/master-20261028`.
Backend testowy powstał z wcześniejszej bazy `3ffd6896a45109f881ae1dd072107727cf5d5d15`
(snapshot `c57be14cf54cae7bd593962d516292766c262239e1862f70a7a16297d0865988`).
Frontend czyta przez HMR zintegrowane źródła brancha. Dowód dotyczy UI pustej
sesji i regresji prezentacji; nie kwalifikuje solvera ani odzyskania mastera.

Osobny zastany problem: historia skalarów nie ma identyfikatora runu w swoim
kontrakcie. Przypisywanie jej do bieżącego runu wymaga osobnego rozstrzygnięcia
provenance. Ta poprawka nie zmienia tego kontraktu ani nie deklaruje jego naprawy.

## Odblokowanie grupy testowej

Początkowy start `d9071f5ad22f492e9efcaab3d3e5abae` został odrzucony przed
utworzeniem usług z powodu wyczerpanej puli sieci. Po osobnej zgodzie operatora
usunięto tylko osieroconą sieć `fullmag-net-a6ad5bf63d81b91f` po PR #297.

Nowa procedura failure-only zachowała oryginalny receipt, zweryfikowała brak
usług i sieci własnej grupy, właściciela helpera i zajęty `operation.lock`,
a następnie zapisała `failed-confirmed`. Wyłącznie oryginalny helper zwolnił
`active`. Nie opublikowano `verified` i nie usunięto danych ani wolumenów.
40 testów Python obejmuje odmowę przy zmienionym digescie, symlinkach, obcych
konsumentach oraz wykonanie publikacji shell CAS na izolowanych plikach.
Po review kontrola obcych bind mountów obejmuje również podkatalogi i katalogi
nadrzędne checkoutu. Testy tej procedury są podłączone do CI.

Nowy start `68c9820293cd4aaa9aa24c270dfc21b0` zakończył się sukcesem;
Compose SHA: `c1a54a4777d9df11bed8a31e13377e05fc2ae6476158d3c6205a518dee3808dc`.
Odzyskiwanie sesji mastera pozostaje oddzielną operacją koordynowanego właściciela.
