# Kontrole przeglądarkowe designu Control Room

Skrypty `apps/control-room/scripts/check-*-browser.mjs` sprawdzają wygląd i interakcje w działającej grupie DEV. Nie dowodzą fizyki, wydajności solvera ani kwalifikacji wydania.

- `pnpm check:design` uruchamia statyczną kontrolę tokenów i kontrastu (`check-design-t1.mjs`), bez przeglądarki.
- `pnpm check:design:browser [--only a,b]` uruchamia po kolei kontrole przeglądarkowe (`run-design-browser-checks.mjs`). Każda kontrola zapisuje raport w osobnym podkatalogu.

## Wejścia

- `CONTROL_ROOM_URL` — strona `/workspace` testowanej grupy. Nie ma domyślnego portu, bo każda grupa DEV publikuje własny.
- `CONTROL_ROOM_DESIGN_REPORT_DIR` — zarejestrowany katalog runu zadania, np. `storage/runs/<task-id>/<run-id>`.

Kontrole `panel-design`, `inspector-ack`, `inspector-resize` i `design-acceptance` wymagają sesji z modelem `examples/fem_disconnected_mixed_p1_operator_probe.py`, która zawiera obiekt `mixed_p1_box_prism`. `design-audit` podmienia API na pustą sesję.

## Uruchomienie w grupie DEV

Proxy DEV serwuje API tylko na loopbacku. Przeglądarka działa więc w przypiętym obrazie Playwright, wewnątrz przestrzeni sieciowej kontenera frontendu. `node_modules` pochodzą z wolumenu stanu frontendu i nie są instalowane na hoście.

```bash
docker run --rm --network container:<frontend> \
  -v <frontend-state-volume>:/state/development:ro \
  -v "$PWD/apps/control-room/scripts:/state/development/workspace/apps/control-room/scripts:ro" \
  -v <run-dir>:/out \
  -e CONTROL_ROOM_URL=http://127.0.0.1:8080/workspace -e CONTROL_ROOM_DESIGN_REPORT_DIR=/out \
  -w /state/development/workspace/apps/control-room \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  node scripts/run-design-browser-checks.mjs
```

`<frontend>` to kontener `…-frontend-1` grupy. `<frontend-state-volume>` to jego wolumen zamontowany pod `/state/development` (`fullmag-dev-frontend-v1-*`).
