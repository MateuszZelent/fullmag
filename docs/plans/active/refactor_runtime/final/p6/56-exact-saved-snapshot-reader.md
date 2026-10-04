# P6-56 — odczyt receiptu zapisanego tensora

Data: 01.10.2026. Baza: `9e18e9634e1de7416317eb21a849040863601a5d`.
Status: przyrost źródłowy; P6 około **52%**, cały plan około **49%**.

## Zmiana

`fullmag_runtime_control::read_pinned_study_tensor_snapshot` rozwiązuje exact
historyczną rewizję/member/tensor przez istniejący typed resolver. Źródłowy
artefakt musi należeć do tego samego historycznego membera. Sprawdzane są
source CAS, schema/codec, accepted state, pełny immutable field binding,
producer semantics i fingerprint obejmujący źródło, run, RunSpec, case i port.
Application codec waliduje receipt względem endpointu i wartości źródła.

Reader sprawdza następnie CAS każdego chunka i hash wszystkich bajtów F64 LE
w porządku logicznych offsetów względem hasha receiptu. Zmieniony tensor z
poprawnym własnym CAS nie przechodzi tej bramki. Odwrócony porządek listy
chunków nie zmienia logicznego pola. Każdy chunk ma limit producenta
196 608 B; źródłowy JSON zachowuje istniejący limit 64 MiB. Wektor wartości
źródłowych jest zwalniany przed odczytem payloadu tensora. Nie deklarujemy
zmierzonego peak RAM ani bounded streaming JSON.

Legacy bez receiptu zwraca None po weryfikacji źródła i bindingu, bez dowodu
integralności całego tensora. Operacja jest jawna i odrębna od zwykłego slice;
nie została podłączona do API ani renderera. Nie zmienia schematów CAS,
geometrii ani statusu `representation_evidence = not_verified`.

Kontrakt: [ADR 0042](../../../../../adr/0042-native-final-field-snapshot-receipt.md).

## Dowody i ograniczenia

- Produkcyjny `just check-api-source`: PASS, exit 0,
  `48020c4f74b041d0a266218ba5090717` w
  `storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/`.
- Źródła regresji: logical chunk order, zmiana znaku zera przy poprawnym CAS,
  błędna długość i odrzucenie nadmiernego chunka przed odczytem. Unit tests
  nie były kompilowane ani uruchamiane zgodnie z aktualnym zakazem.
- Integracja historycznego ownera/source/tensora w runtime: NOT VERIFIED.
- Niezależny review końcowy: brak P0/P1; zgodność exact owner/source,
  bindingu, logicznego pokrycia i pełnego hasha potwierdzona źródłowo.
- Actual native map/digest, renderer, RAM, physics i release: otwarte.

Build native CPU P6-55, sequence 189, job
`529ac93e81744c5faf50494306d50a11`, pozostaje queued. Health koordynatora
ujawnił `waiting_for_existing_fullmag_container`; odczyt Docker potwierdził
działający `fullmag-dispersion-51bd666b84a52a187b61dd4a1881990c`.
Koordynator chroni współdzielone zasoby przed równoległym ciężkim buildem.
Nie zatrzymano kontenera, nie zmieniono profili i nie zgłoszono duplikatu.
Job 189 buduje commit P6-55; nie będzie dowodem źródeł P6-56.

## Następny krok

Uzyskać terminalny wynik istniejącego buildu, wykonać osobną bramkę
snapshot/runtime i dodać trwałą natywną mapę indeksów powiązaną z canonical
MeshIR. Dopiero wtedy geometry API i przestrzenny renderer mogą otrzymać
mocniejsze gwarancje reprezentacji.
