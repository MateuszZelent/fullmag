# P8-53AO — natywny konsument restartu i pauza obserwatorów

Data: 04.10.2026. Stan: **IMPLEMENTED / COLD NATIVE PATH VERIFIED**.
Zakres rozwija [P8-53AN](53an-ui-restart-request-transport.md) w ramach
[P8-53](53-development-restart-workspace.md). Nie zamyka P8 ani całego planu.

## Zachowanie

Pętla natywnego launchera odczytuje trwałe żądanie przypięte do własnego API
i generacji. Oznacza próbę przed rozpoczęciem operacji; ponowne tyknięcie
pętli nie wykonuje tego samego żądania drugi raz. Niepotwierdzona publikacja
wyniku ponawia wyłącznie publikację tego samego zapisu.

Selector sprawdza świeży status `ready`, bieżące źródła, surowy manifest
builda i namespace zarządzanego profilu. Kopiuje zweryfikowany pakiet EXE,
sprawdza jego pliki, ponownie sprawdza źródła i status, a niezależny verifier
przypina ownera kandydata. Błąd nie usuwa danych częściowej próby.

Po uzyskaniu zimnej rezerwacji, przed commitem, scratch observer potwierdza
pauzę wyłącznie bez aktywnego dziecka ani nierozliczonego polecenia.
Aktywna praca odmawia pauzy. Timeout odwołuje ticket, więc spóźniony ACK
nie zatrzymuje obserwatora. Znany abort przed commitem wznawia ten sam
obserwator. Niepotwierdzony abort albo handoff zachowuje stan niepewny,
procesy i fence; nie uruchamia automatycznej kolejnej próby.

Po potwierdzonym replacement stary zapauzowany obserwator jest odebrany,
a nowe obserwatory dostają świeży pin API i EXE z zapieczętowanego pakietu.
Terminalny wynik przenosi odrębne editor, workspace i project_document.
Zakończenie attach observera nie zatrzymuje resident service.

Znany exit przed wysłaniem commita kończy żądanie jako `failed` i zamyka
zapauzowany observer; nie próbuje replacement. Chwilowy błąd ponownego attach
po abort pozostawia retry wyłącznie obserwacji tego samego, przypiętego API.
Przy `OutcomeUnknown` zamknięcie okna zachowuje żywy launcher i owner guard,
zamiast porzucać uchwyt procesu. Crash/force-kill recovery pozostaje osobną bramką.

## Weryfikacja

- `just windows-workspace-build dev dev 3197 auto`: wymagany build produkcyjnych
  EXE; testy jednostkowe nie są kompilowane.
- `just verify-windows-development-observer-pause`: rzeczywiste wątki,
  odmowa przy zajętości, timeout, terminalny worker, wznowienie po Drop
  i odebranie zapauzowanego workera.
- `just verify-windows-development-restart-consumer`: własne procesy API,
  pusty workspace i scena, publiczne żądanie HTTP, produkcyjny konsument,
  świeża tożsamość, dokładny payload, mutacje po odtworzeniu i brak powtórnego
  wykonania. Status próby jest odrębny od statusu prawdziwego watchera.

Finalny zarządzany build Windows: **PASS**, terminalny `build-status.json`,
exit 0. Profil `windows-native-fdm-cpu-dev`, namespace
`fullmag-0950f4dca4ffe38f`, build commit
`22e3b5f580f964b0082e42811c2c1b7afd203be5`, dirty snapshot
`03736ed970b9a9720c75673044700b1ef0a861419d6b4fe17e74ca5798d2880c`.
Backend source SHA przed/po próbach:
`9d10377cc31fbb0e12fc79f3661a7b1032947cbeea64483e70e91e7861df58c4`.
Raw build manifest SHA:
`9d09b0071f8906e12c4991fbfe8f0e6e99f89d93f6bc4f14400a38c559dc1e94`.

| Bramka | Wynik | Receipt w `development-backend-api-checks/checks` |
|---|---|---|
| Konsument: empty + scene, selector i canonical codegen identity | **39 PASS**; wszystkie 20 procesów odebrane | `b05f68d8b2a840e0b3fa0f742086c646/receipt.json` |
| Pauza rzeczywistych wątków i identity finalnego pakietu | **6 PASS** | `69f3719044bb4fe6b323f3321bce2382/receipt.json` |
| Transport HTTP: Origin/token/pin/session/replay/conflict | **20 PASS** | `921d6d9b4cde48db801a92a5b947d72b/receipt.json` |

Konsument obejmuje 24 kontrole kontraktu selektora, po 7 kontroli przebiegu
empty/scene oraz identity eksportu. Sprawdza rzeczywisty publiczny POST,
trwały terminalny wynik, fresh API/session, dokładne trzy payloady, stary pin,
ponowne tyknięcie pętli i mutację po odtworzeniu. Fixture jawnie kończy nowy
własny proces przez supervisor shutdown; Windows zwraca wtedy exit 1,
odrębny od naturalnego exit 0 starego API po commicie. Nie jest to awaria solve.

Review źródeł wskazało trzy błędy lifecycle; poprawki zostały ponownie
przejrzane bez otwartych Required findings. Ich gałęzie błędów nie mają
jeszcze natywnego fault-injection proof. AST/rustfmt/diff checks: PASS.
Nie kompilowano testów jednostkowych ani nie zmieniano UI/API schema.

Nieudane receipty `5646bcc5163f4069bdaa93d7cd43c9e3`,
`0de1f9e24d27437daee849a5f6cb5220` i `90c15a8533dc44b2b8e915182d73bfce`
zachowano. Próby wykryły prefiks verbatim Windows na granicy Rust→Python
oraz błędne oczekiwanie kodu jawnego teardown w verifierze. Kanoniczne
porównanie fizycznego położenia pozostaje; helper otrzymuje ścieżkę
wyprowadzoną z zatwierdzonego rootu środowiska. Żadnego zapisu z niepewnym
wynikiem ani starego fence nie usunięto.

## Pozostałe bramki

`restart_available` pozostaje `false`. Hydration rzeczywistych paneli,
zmiana facade/cache scope, pełny Windows/browser flow z geometrią,
regionami i materiałami oraz aktywną symulacją pozostają **NOT VERIFIED**.
Zimna ścieżka nie kwalifikuje restartu skonfigurowanego resident service.
Jeden immutable slot starego API po błędzie nadal wymaga jawnego recovery;
nie jest to ukończony produktowy retry. Walidacja fizyki i wydanie są odrębne.
