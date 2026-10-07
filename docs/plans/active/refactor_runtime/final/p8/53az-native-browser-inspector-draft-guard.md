# P8-53AZ — ochrona szkicu Inspectora przy natywnym restarcie

Data: 06.10.2026. Zakres: bramka P8-53 dotycząca lokalnego szkicu i odmowy
przed wysłaniem restartu. Nie jest to restart aktywnego solvera ani pełna
kwalifikacja wydania.

## Kryteria

1. Własny workspace z rzeczywistym obiektem, regionem i przypisanym materiałem.
2. Capture niepustej sceny i otwartego dirty project document.
3. Edycja parametru w Inspectorze bez Apply.
4. Zwykła akcja Restart backend odmawia z powodu pending changes.
5. Ten sam API pin, sesja, kernel generation i model; szkic nadal w panelu.
6. Brak natywnego replacement i brak wyjścia starego API podczas odmowy.
7. Jawne rozstrzygnięcie szkicu, bez cichego Discard przez restart.
8. Następny restart odtwarza dokładną scenę i dokument; fresh API/session
   scope, widoczny canvas, aktywny WebGL i niezerowy drawing buffer.
9. Wszystkie własne procesy terminalnie odebrane.

## Granica źródłowa

`DevelopmentRestartActionService` tworzy ownerów z
`applyPendingChanges:false` i `carryUnsavedDocument:true`.
`DevelopmentKernelOwners.capture` odrzuca dirty/applying/guarded registry
przed przejęciem guardów; dirty bez pracy w toku ma reason `pending_changes`.
Nie wolno uznać samego tego odczytu za dowód rzeczywistego szkicu w UI.

Weryfikacja używa zarządzanej recepty
`just verify-windows-development-workspace-browser efc0a57a5be44d8894eee537d9b86298`.
Owner C i pakiet D pozostają przypięte do wcześniej sprawdzonych manifestów;
nie wykonuje się nowej kompilacji. Dysk R służy plikom kompilatora, a dowody
i sesja tej próby pozostają w trwałym storage.

## Stan

Pierwsza próba: **PASS** w zakresie rzeczywistej ochrony szkicu i późniejszego
restartu. Receipt `d2a15781eb33433f9fb358be718bc7c3`: completed, exit 0,
7 kontroli; wszystkie 13 native/source procesów i Next waited.

Na obiekcie `new-thin-film-muvxzq9v`, z regionem `Draft guard region`
i przypisanym `mat:new-thin-film`, zaznaczono Present i wpisano Ku1 `12345`
bez Apply. Apply Inspector był enabled. Restart zwrócił:
`Apply or revert pending Inspector changes before restarting. No restart was submitted.`
Wartość i zaznaczenie pozostały w panelu; ten sam API pin
`bf791adf-4dc8-47bf-a52b-450603ca6b4c`, session
`session-18dbc949229b731800016874`, generation 0, paused false i scena revision 4.
Log natywny nie zawierał replacement; świeże ready frames nadal pochodziły
od starego ownera, API PID 92276.

Po jawnym Revert pola wróciły do stanu committed, a Apply Inspector stał się
disabled. Pierwszy późniejszy capture odmówił bez wysłania restartu. Przyczyny
tej odmowy nie zidentyfikowano; nie przedstawiamy jej jako naprawionej.
Dopiero następna jawna akcja wysłała restart. Check restart uzgodnił ten
jedyny wysłany intent, bez ponownego submit po pending.

Nowe API: PID 111968, pin `b94398b2-1315-4568-b689-20658243680c`, session
`session-18dbc9960f0ad60c0001b560`, generation 1, paused false. Dokument
`project-16f8e4b9855b425296ec02bb4041175f`, revision 2, dirty true,
hash archiwum `8c6602d57d4fddba8aa315c106d5489797d3ec29773b9d5b090e594030206b9c`
i scena `2b5218d613c07370be1f2eda8dfe285bf0f5bfa3336930a7d4ec71de806806e5`
pozostały identyczne. WebGL visible, contextLost false, drawing buffer
655×297. Finish proof potwierdził wynik; własną kartę 12 zamknięto.
Stare API exit 0, replacement exit 1 w owned teardown, helpers exit 0.

Dowody DOM i screenshots zachowano w katalogu visualizations zadania:
`fullmag-draft-guard-refused-dom.txt`, `fullmag-draft-guard-refused.jpg`,
`fullmag-draft-guard-restored-dom.txt`, `fullmag-draft-guard-restored.jpg`.
Odmowa szkicu jest dowodem z UI/logu, a nie dodatkowym ósmym check receiptu.

## Korekta tożsamości strony diagnostycznej

W tej próbie driver kopiował fixture z zamrożonego pakietu D. Produkcyjny
kod D był poprawnie przypięty, ale późniejsze poprawki samej strony testowej
nie trafiały do route. Brak `material_ref` w podsumowaniu ujawnił ten problem.
Dotyczy to również wcześniejszego receiptu AY `6379d58c...`: jego rzeczywisty
model i odtworzenie są dowiedzione, lecz nie dowodzi on wykonania późniejszej
poprawki prywatnego overlayu. Nie zmieniono historycznych receipts.

Driver zachowuje produkcyjne źródła D, lecz odtąd oddzielnie utrwala bieżącą
diagnostyczną stronę z checkoutu. Snapshot i staged route mają w receipt
ścieżki i SHA-256; zmiana źródła podczas capture albo kopii blokuje próbę.
Interpretowane regresje drivera: **20/20 PASS**, w tym current vs frozen page,
mutation/tampered copy i odmowa linku przed resolve. Nowa próba runtime tej
korekty jest wymagana. Publiczny restart i cały plan pozostają otwarte.

## Ponowna próba z bieżącą diagnostyką — PASS

Receipt `4d829bea8f7746a78c889c99c4fddfdc`: **completed, exit 0**, 7 kontroli.
Typecheck noEmit i lint staged route exit 0. Driver utrwalił bieżący plik
diagnostyczny oraz staged route z identycznym SHA-256:
`6fea8ec8756c99b1ec980e754bab4ce631f74e1ed199bd960017a6fe59ca23b0`.
Produkcyjne źródła nadal pochodziły z zamrożonego D. Podsumowanie w UI
zawierało `material_ref: mat:new-thin-film` na obiekcie z geometrią i regionem,
co potwierdza wykonanie bieżącej kontroli linked scene.

| Bramka | Obserwacja |
|---|---|
| Rzeczywisty model | `new-thin-film-muvyfwa3`, region `Current fixture region`, materiał `mat:new-thin-film` |
| Lokalny szkic | Present checked, Ku1 `23456`, Apply Inspector enabled |
| Próba Restart | `Apply or revert pending Inspector changes before restarting. No restart was submitted.` |
| Zachowanie szkicu | Ku1 nadal `23456`; ten sam panel i model; screenshot i pełny DOM zapisane |
| Brak restartu przy odmowie | API PID 112400, pin `6300b6cd-52c6-47cc-a09c-438a57231b14`, generation 0, paused false; log bez replacement |
| Jawny Revert | Present unchecked, Ku1 disabled, Apply Inspector disabled |
| Następny Restart | Wysłany przy pierwszej próbie po Revert; potem tylko Check restart tego samego intentu |
| Nowy runtime | API PID 69768, pin `55e9b0c4-9e50-434f-9a79-6dc51a50353b`, session `session-18dbca2b2d3e76e800011088`, generation 1, paused false |
| Dokument | `project-efd918b9d6284ee3b7380052f578c616`, revision 2, dirty true, bez zmiany treści |
| Hash archiwum | `a7d32f151701c3ab591425f0bbea021736f3a0d2a9a9d4425f0a65e411766188`, identyczny przed/po |
| Hash sceny dokumentu | `2e26183f5bebf293e4ee8c15b5a369327f125c0cbdc0dc25ee76107292ca245f`, identyczny przed/po |
| WebGL | visible, contextLost false, drawing buffer 679×297 po odtworzeniu |
| Custody | Wszystkie 13 native/source procesów waited; stare API i helpers exit 0, replacement exit 1 w owned teardown; Next waited exit 1 |

Finish proof potwierdził odtworzenie. Własną kartę 13 zamknięto. Zachowane
screenshots i pełne DOM: `fullmag-current-draft-refused.jpg`,
`fullmag-current-draft-refused-dom.txt`, `fullmag-current-draft-restored.jpg`,
`fullmag-current-draft-restored-dom.txt` w katalogu visualizations zadania.
Odmowa i WebGL są dodatkowymi dowodami CUA, nie osobnymi checks receiptu.

W bieżącej próbie nie powtórzyła się wcześniejsza pojedyncza odmowa capture
po Revert. Nie ustalono jednak jej przyczyny, więc nie deklarujemy jej
naprawienia. Zamknięta bramka obejmuje jeden szkic anizotropii i jawny Revert,
nie wszystkie rodzaje szkiców, ścieżkę Apply ani aktywny solver. Publiczne
udostępnienie, pozostałe fault gates i pełny plan nadal wymagają dowodów.
