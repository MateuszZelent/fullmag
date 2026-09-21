# P1-C — browserowy smoke Inspektora

Data: 20.09.2026. Checkout: lokalny `master`, HEAD `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, dirty source. Aplikacja: lokalny Control Room na `http://localhost:3104/workspace`, połączony z lokalnym API.

## Przebieg

1. Workspace uruchomił się bez projektu; `panel-right` zawierał Inspektora i przycisk `Hide Inspector`.
2. Kliknięcie `Hide Inspector` usunęło `panel-right`; viewport pozostał zamontowany i zwiększył szerokość.
3. Otwarcie ribbonowego menu `Panel` pokazało `Inspector = 0`.
4. Kliknięcie pozycji `Inspector` przywróciło `panel-right` z nagłówkiem Inspektora; menu pokazało `Inspector = 1`.

## Wniosek

Cykl hide/show korzysta z istniejącego `LayoutController.panelVisible.right` i wspólnej komendy `panels:inspector:toggle`. Nie utworzono lokalnego stanu ani osobnego endpointu. Dowód obejmuje interakcję powłoki i layoutu; nie obejmuje solvera, runtime physics ani kwalifikacji release.

## Wykonanie automatyczne

Po dodaniu regresji do `apps/control-room/scripts/smoke-inspector.mjs` wykonano
Playwright smoke na świeżym lokalnym Next.js:

```text
CONTROL_ROOM_URL=http://127.0.0.1:3104/workspace
pnpm --dir apps/control-room smoke:inspector
exit code: 0
inspectorPanelToggle: verified; header icon and ribbon restore
previewRequests: 0
visualizationMutationStability: verified; mutation budget: 20
```

Smoke sprawdził przycisk `Hide Inspector`, usunięcie `panel-right`, zachowanie
lub powiększenie slotu viewportu oraz przywrócenie przez ribbonowy `Panel →
Inspector`. Skrypt czyści teraz wszystkie wcześniejsze miary Profilerów
`InspectorModule`, w tym `nested-update`, przed pomiarem budżetu mutacji; dzięki
temu wynik nie zależy od renderów wykonanych podczas wcześniejszego routingu.

Jest to dowód przeglądarkowy z lokalnego checkoutu, bez managed receipt i bez
kwalifikacji solvera, GPU ani wydania. Raport wygenerował 19 zrzutów kontrolnych
w lokalnym katalogu `.fullmag/reports/inspector-2-browser-codex-final`.

## Rewalidacja 21.09.2026

Ponowiono smoke na lokalnym Next.js `http://localhost:3100/workspace` po
aktualizacji powłoki. Wynik: **exit code 0**; `inspectorPanelToggle` potwierdza
ikonę nagłówka oraz przywrócenie z ribbonu, `previewRequests: 0`, a stabilność
mutacji pozostaje zweryfikowana przy budżecie 20. Raport zawiera jeden błąd
konsoli, który jest oczekiwanym pojedynczym `409 Conflict` używanym przez
scenariusz dirty-selection; skrypt odrzuca wszystkie nieoczekiwane błędy i
powtarzające się konflikty. WebGL viewport przeszedł warunek niezerowego
bufora i nieutraconego kontekstu.
