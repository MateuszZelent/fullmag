# P1 — zarządzany reconnect podczas aktywnego runu

Data: 21.09.2026. Recepta: `just verify-project-active-run-runtime`.

## Zakres i provenance

Recepta zbudowała `fullmag-api` i `fullmag` z jednego checkoutu `master`,
przypiętego do commit `14c8e73a6f3c55f4fc080835a6156f2a4db8f111` oraz source
snapshotu `1b53c128203d6402ff89c4e44946a20bf31d97a5792084511ddb968c7db59a8c`.
Build użył zarządzanej trasy Windows, `cargo build --locked --offline` i
zweryfikowanego cache Cargo/Rustup projektu. Binaria zapisane w receipcie mają
SHA-256:

- `fullmag-api`: `226926dfdf671d37d389443fa2018be1257542ce574915f7dd3e9fedac114e0b`;
- `fullmag`: `f628f221eefbeaeed69ccfe45555f5e070ea30655df176fbda59704191894bfe`.

Run otrzymał identyfikator `96725388626d45a6b475a56b3a97ba7a`, a końcowy receipt
znajduje się pod:

`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-active-run-runtime\windows-project-active-run-runtime\96725388626d45a6b475a56b3a97ba7a\receipt.json`

SHA-256 receiptu: `D8D77C15EF576820B0339A5199249301BFC482985BB071D16F7D0353DA64E9B3`.
Receipt ma `state=passed`, `build_exit_code=0`,
`source_changed_during_run=false`; kontrolowane zakończenie procesów zwróciło
`cli_exit_code=1` i `api_exit_code=1`, co jest wynikiem ścieżki terminate po
zakończeniu smoke, a nie błędem probe. Żaden proces recepty nie pozostał
uruchomiony.

## Scenariusz wykonawczy

Izolowany CLI uruchomił rzeczywisty FDM CPU `flat_relax` z `max_steps=100000`
na małej geometrii fixture'a. API miało osobny port `51503`, osobny stan i
osobny run root; zmiany nie dotknęły bieżącej sesji użytkownika.

Probe Node wykonał:

1. oczekiwanie na aktywny run i co najmniej jeden krok solvera;
2. odczyt HTTP `run`, `stages`, `solver` i `commands`;
3. handshake `fullmag.live.v1` i zapis pierwszego `hello`;
4. kontrolowane zamknięcie WebSocketu;
5. ponowne połączenie z `after_seq=12`;
6. porównanie tożsamości sesji/runu, stanu solvera, kroków i rewizji HTTP.

Wynik probe:

```text
state: passed
session_id: session-1789952713923-216300
run_id: run-session-1789952713923-216300
protocol: fullmag.live.v1
first hello: seq=12, current_seq=12
reconnect hello: seq=13, current_seq=13, after_seq=12
close codes: 1006, 1006 (kontrolowane zerwanie klienta)
solver: running przed i po reconnect
steps: 1 przed i po reconnect
HTTP resources: reachable przed, podczas i po reconnect
same session: true
same run: true
revisions non-decreasing: true
```

`active_run_probe.assertions` w receipcie potwierdza `same_session`, `same_run`,
`solver_continued`, `http_resources_reachable` i
`revisions_non_decreasing` jako `true`.

## Znaczenie i granice

To jest zarządzany dowód, że backendowy aktywny FDM run zachowuje tę samą
sesję i run po zerwaniu transportu oraz że snapshoty HTTP pozostają dostępne i
monotoniczne. W połączeniu z testem `RealtimeInvalidationBridge` potwierdza
ścieżkę: reconnect transportu → ponowna invalidacja → odczyt autorytatywnego
stanu HTTP.

Receipt nie kwalifikuje jeszcze całego CAE-41. Nadal osobno wymagają dowodu:

- fizyczne okno Tauri i hostowy Save/Open;
- browserowy dowód, że zamontowany DOM workspace i viewport pozostają tym
  samym węzłem podczas reconnectu;
- pełna session-recovery po awarii procesu, w tym trwałe snapshoty i polityka
  odtwarzania;
- naukowe i release gates P1/P3, w tym CPU/GPU oraz FDM/FEM.

Wcześniejszy lokalny przebieg bez managed provenance pozostaje w
[diagnostycznym raporcie](06-active-run-reconnect-diagnostic.md) jako historia
debugowania; ten dokument jest aktualnym dowodem zarządzanym.
