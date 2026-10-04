# P1 — zamontowany workspace po reconnect WebSocket

Data: 21.09.2026. Recepta browserowa:
`pnpm --dir apps/control-room smoke:mounted-workspace-reconnect`.
Smoke używa rzeczywistego Control Room i API przez
`http://127.0.0.1:3104/workspace`, a Playwright routuje wyłącznie pierwszy
WebSocket `/v2/sessions/current/events/ws`, łączy go z prawdziwym serwerem,
po `hello` kontrolowanie zamyka socket i pozwala klientowi wykonać reconnect.

## Wynik

```text
state: passed
socket_count: 2
session_id: session-18d71ae83324c1e400020594
first hello: seq=14, current_seq=14
reconnect hello: seq=14, current_seq=14, after_seq=14
same_session: true
mounted_workspace_node_same: true
mounted_canvas_node_same: true
canvas before: 703x478, contextLost=false
canvas after: 703x478, contextLost=false
workspace_state_after_reconnect: null
```

Raport maszynowy znajduje się w:
`apps/control-room/.fullmag/reports/mounted-workspace-reconnect/report.json`.
Smoke sprawdził także, że nie wystąpił nieznany błąd HTTP. Powtarzające się
404 dotyczą wyłącznie jawnie dozwolonych, bezczynnych zasobów
`simulation/preparation` i `simulation/runs/current`, z limitem ośmiu
odpowiedzi na ścieżkę dla dwóch cykli odświeżenia.

## Znaczenie

Dowód potwierdza CAE-41 w zakresie browserowego reconnectu: ten sam element
`#fm-main-content` i ten sam canvas WebGL przeżywają kontrolowane zerwanie
transportu, a reconnect używa `after_seq` i zachowuje `session_id`. Jest to
uzupełnienie testów źródłowych `RealtimeClient`/
`RealtimeInvalidationBridge` oraz zarządzanego active-run smoke.

Nie jest to dowód fizycznego okna Tauri, awarii procesu API, trwałej
session-recovery ani kwalifikacji naukowej/release. Te bramki pozostają
odrębne.
