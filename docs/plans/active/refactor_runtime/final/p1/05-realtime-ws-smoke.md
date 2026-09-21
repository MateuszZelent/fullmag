# P1 — managed smoke transportu WebSocket

Data: 21.09.2026. Recepta: `just verify-project-realtime-runtime`. Smoke
uruchomiono na lokalnym `masterze` z HEAD
`14c8e73a6f3c55f4fc080835a6156f2a4db8f111`; źródło pozostało niezmienione w
trakcie całej budowy i wykonania.

## Zakres

Recepta zbudowała `fullmag-api` z izolowanym profilem
`windows-project-realtime-runtime`, sprawdziła health i build identity,
utworzyła pustą sesję scratch `fdm/cpu/double`, a następnie wykonała dwa
połączenia z kanonicznym endpointem:

1. `GET /v2/sessions/current/events/ws` z subprotokółem
   `fullmag.live.v1`; oczekiwano pierwszej ramki `hello`.
2. Kontrolowane zerwanie po odebraniu `hello`.
3. Ponowne połączenie z `after_seq=1`; oczekiwano kolejnej ramki `hello` i
   zachowania tej samej tożsamości sesji.

Nie uruchamiano meshera, solvera, GPU, Restore Runtime ani aktywnego runu.
Utworzenie pustej sesji jest jedyną mutacją runtime i jest jawnie oznaczone w
receipcie jako transport-only smoke.

## Wynik zarządzany

```text
just verify-project-realtime-runtime
state: passed
run_id: 65368bbc0b8b4e7997009500e8d36026
profile: windows-project-realtime-runtime
source_snapshot_sha256: 75761051f49a98e189adff153669a99a9a81d1add84a62a9a609ce647fba1cfc
source_changed_during_run: false
binary_sha256: 4509BD72DDCE34D3637D0B742AF91F368B132F63B0D867DCFE771F10013711D4
session_id: session-18d72c5b239d827c00035258
protocol: fullmag.live.v1
first hello: seq=1, current_seq=1, replay_available_after_seq=0
reconnect hello: seq=1, current_seq=1, after_seq=1
reconnect same_session_id: true
client close codes: 1006, 1006 (kontrolowane zerwanie transportu przez probe)
runtime_mutations: empty scratch session only; no solver or runtime restore
```

Receipt: `C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-realtime-runtime\project-api-runtime\65368bbc0b8b4e7997009500e8d36026\receipt.json`.
SHA-256 receiptu: `CACB7F5B18947AEC995D371855788617D048A58F1CBAA7BF5ADE0CBEEB460A1F`.
Log probe: `realtime-ws.log` w tym samym run root.

Ten wynik dowodzi negocjacji subprotokółu, pierwszej ramki `hello`, stabilności
`session_id` po reconnect i użycia `after_seq`. Nie dowodzi odtworzenia
aktywnego runu, rekonsyliacji statusu po zerwaniu podczas obliczeń, trwałości
sesji ani kwalifikacji release. Te scenariusze pozostają `NOT VERIFIED`.
