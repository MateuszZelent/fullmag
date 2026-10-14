# P8-53BU — uwierzytelniona tożsamość odtworzenia w ramce natywnej

Data: 14.10.2026. Baza `9994141e806471c3c2a12038b64067a85a4a7c54`.
Status: **SOURCE / NATIVE BUILD PASS; RUNTIME NOT VERIFIED**. Kontynuacja [53BS](53bs-restart-remaining-gates.md)
i [53BT](53bt-browser-chain-ledger.md), bez zmiany publicznej dostępności.

## Przyrost

Natywny probe odczytuje autorytatywny immutable slot dla starego API,
worktree i generation. Przed emisją restoru uwierzytelnia jego wynik przez
istniejący `read_result`, wymaga Ready i zgodności request ID/generation/
starego API oraz przypięcia replacement do rzeczywistego owned API/PID.
Hash tokena pozostaje wewnętrznym argumentem; nie jest emitowany.

Ramka `fullmag.development-browser-native-restored.v2` dodaje request_id,
generation_id, old_api_instance_id i old_api_pid do dotychczasowej custody.
Pythonowy konsument w istniejącym loop korzysta ze ścisłego walidatora.
Źródłowy PID musi odpowiadać jedynemu potwierdzonemu logowi starego API;
obcy scope, unknown schema/fields, brak wait i duplikaty helperów odrzucane.
Jawny adapter v1 zachowuje odbiór wcześniejszych pakietów, ale nie dopisuje
im brakującego request ID. Walidator zwraca odłączoną kopię ramki.

Nowe interpretowane regresje obejmują v1/v2, obcy nonce/pin/request/PID,
brak pola, unknown fields w tym sekret, helper custody i source exit 1.
Source identity wrappera obejmuje nowy test oraz zmieniony Rust probe.
Rustfmt i Python AST przeszły. Końcowe managed checks:
`128b5b5b704d478cb392dd86a3345f38`, completed, exit 0, **209/209**,
zero pominiętych; source identity before=after:
`b8a3cb575baf27b0b9e6d22bf25c415be915d71225b97234d8e56d2414dc0776`.
Osiem nowych metod regresji dotyczy ramki, jej scope i custody.

Pierwsza seria `9bd1cfd6d21b472baf6eb0ce191c87e1` miała 207 checks OK,
ale receipt poprawnie zakończył failed/source_changed_during_checks po
usunięciu nieużywanego importu w trakcie próby. Nie zaliczono tego receiptu.
Kolejna stabilna seria `3b7155e941db4e74a75de7de55b733f4` przeszła 207/207;
po review dodano dwie regresje i wykonano końcową 209/209.

Bounded review potwierdziło kolejność publikacji Ready, prywatność tokena
i scope Rust. Warunkowy P1 dotyczący v1 skorygowano: receipt ma teraz jawny
`workspace_browser_restore_protocol` z legacy/non-authenticated dla v1.
Check `browser-authenticated-v2-request-and-source-custody` jest dodawany
wyłącznie dla v2. Dodano też rozdzielenie PID starego API od helper custody.

Zarządzany `just windows-workspace-build dev dev 3197 true` wystartował:
handle 40909, log `native-build-19f4db952dd949ada9e7a04549a4d71d.log`.
Snapshot `d921478f7771f18828f7b113c1ee0c7f9151f0382272726ee5a19004460fd9d9`.
Build zakończony **exit 0**: CLI/API 49,07 s, desktop 58,85 s.
Terminalny `windows-native-fdm-cpu-dev/build-status.json` oraz manifest
zapisano przez managed wrapper; nie uruchamiano kompilacji testów.
Manifest SHA-256:
`b08a564844f67ee1e7b150595e6a81ad482663cdfa3e29eb30229ac53032f040`.
Manifest source_snapshot_sha256:
`4489832ebdadc7b646f20431d3236d8faf5990b8e377dcb59285667de4ae1b88`;
backend_source_sha256:
`457dbd113dfe2f68316ba8f9860ef74e7181178f5f2ee510de0a48d19b566157`.
Niepuste artefakty: fullmag.exe 48 631 296 B, fullmag-api.exe 71 455 232 B,
fullmag-ui.exe 18 637 312 B. Frozen view ID d921478f... jest odrębny od
manifestowego source_snapshot_sha256; nie zamieniać tych tożsamości.

## Granice odbioru

Zmiana nie rozszerza jeszcze pojedynczego Finish readera do dwóch cykli.
Nie dowodzi runtime A→B→C, asset preservation, pełnego Inspectora ani release.
Kompilacja źródeł produkcyjnych nowego probe przeszła. Realny odbiór v2
nadal wymaga odrębnego receiptu; testy Rust/TS pozostają niekompilowane zgodnie z zakazem.
Publiczny restart nadal nieudostępniony. Workspace użytkownika 3197 nie jest
zatrzymywany ani zastępowany w tym przyroście.
