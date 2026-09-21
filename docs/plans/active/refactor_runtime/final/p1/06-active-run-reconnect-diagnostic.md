# P1 — diagnostyczny reconnect podczas aktywnego runu

Data: 21.09.2026. Ten przebieg był wykonany na izolowanym porcie `18204` i
izolowanym katalogu roboczym `.tmp-active-run-api`; po zakończeniu procesy i
katalog tymczasowy usunięto. Jest to dowód zachowania runtime, a nie managed
receipt.

## Zakres

Uruchomiono rzeczywisty mały FDM CPU `flat_relax` na tym samym checkoutcie,
z `max_steps=100000`, aby run pozostał aktywny. API i CLI zostały zbudowane
diagnostycznie lokalnie bez wstrzykniętego source snapshotu (`unknown`), a
Control Room pominięto przez `FULLMAG_SKIP_CONTROL_ROOM=1`, ponieważ proces
Next.js odmawiał odczytu zależności z `node_modules` (`EPERM`). Nie zmieniano
bieżącej sesji API na porcie `8081`.

Probe otworzył WebSocket z protokołem `fullmag.live.v1`, odczytał `hello`,
zamknął socket, odczekał na dalszą pracę solvera i połączył się ponownie z
`after_seq=141`. Równolegle pobrał HTTP resources:
`simulation/runs/current`, `simulation/stages/execution`,
`simulation/solver/status` oraz `simulation/commands`.

## Wynik

```text
state: passed
session_id: session-1789950846857-215092
run_id: run-session-1789950846857-215092
protocol: fullmag.live.v1
first hello: seq=141, current_seq=141
reconnect hello: seq=143, current_seq=143, after_seq=141
same session: true
same run: true
solver state: running before and after reconnect
steps: 4000 before, 4050 after disconnect/reconnect
HTTP resources: reachable before, during and after reconnect
socket close codes: 1006, 1006 (kontrolowane zerwanie klienta)
```

Probe zakończył się `exit 0` i zweryfikował, że run nie został podmieniony,
status nie cofnął się, a rewizje run/stages/solver wzrosły z `166` do `170`.
To potwierdza zachowanie aktywnego backendowego runtime na trasie lokalnej.

## Granica dowodu

Przebieg nie ma managed receipt, nie używa binarium z przypiętym source
snapshotem i nie steruje fizycznym oknem Tauri. Nie zastępuje więc CAE-41,
managed active-run recovery ani browserowego dowodu, że zamontowany DOM
workspace pozostaje tym samym węzłem. Te bramki pozostają `NOT VERIFIED`.
