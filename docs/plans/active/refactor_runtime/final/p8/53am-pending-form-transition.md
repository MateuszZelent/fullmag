# P8-53AM — quiescence guard dla Pending Forms

Data: 04.10.2026. Status: guard zaimplementowany i podłączony do New Problem;
kontrole źródeł i przeglądarki PASS. Pełny restart pozostaje otwarty.

## Kontrakt

`PendingFormRegistry.getTransitionSnapshot()` ocenia wszystkie zarejestrowane
formularze, także nieaktywne w Inspectorze. Raportuje liczbę szkiców,
formularzy w trakcie Apply, niepoprawnych lub zablokowanych zmian oraz trybów
live/immediate. `blockedReason` opisuje pierwszą przeszkodę; `canApplyPendingChanges`
jest prawdziwe tylko wtedy, gdy wszystkie szkice są staged, poprawne,
odblokowane i żaden formularz nie wykonuje już Apply.

`prepareTransition({ applyPendingChanges })` jest wyłączną, asynchroniczną
operacją. `false` odmawia, gdy istnieje dowolny dirty form. `true` najpierw
sprawdza wszystkich właścicieli i dopiero potem wywołuje Apply wyłącznie dla
dirty formularzy staged, poprawnych i odblokowanych. Nie używa Reset ani nie
usuwa szkiców. Publiczne polecenia Apply/Reset są zablokowane podczas
przygotowania i do jawnego zwolnienia guardu.

Zwykłe Apply/Reset otrzymują własny token przed wywołaniem callbacku, więc
opóźniona publikacja flagi `applying` przez React nie pozwala uruchomić drugiego
Apply ani przygotować przejścia. Token pozostaje aktywny także po clear wpisów
do zakończenia konkretnego callbacku.

Guard powstaje dopiero po ponownym odczycie rejestru, gdy żaden formularz nie
jest dirty ani applying. Zachowuje generację rejestru i kontrolę tożsamości
formularzy oraz ich stanu. `assertCurrent()` odmawia po zmianie wpisu, callbacku
lub stanu formularza; wywołujący musi wykonać `release()` w `finally`. Rejestr
powiadamia subskrybentów na początku i końcu przygotowania, aby polecenia mogły
odświeżyć dostępność.

Zmiana innego wpisu, rejestracja/wyrejestrowanie, `clear()`, ponowna
aktualizacja ownera podczas tego samego Apply, wyjątek, odmowa callbacku albo
brak synchronicznie widocznego stanu quiescent kończy operację bez guardu.
Jedna aktualizacja bieżącego ownera do stanu clean z jego własnego callbacku
Apply jest dozwolona i zostaje przypięta do końcowego stanu rejestru. Nie ma
polling ani opóźnień. Jeżeli Apply zakończył się, ale panel nie opublikował
jeszcze czystego stanu w rejestrze, bieżąca próba odmawia;
wywołujący zachowuje otwarte workspace i może ponowić jawny wybór po aktualizacji
rejestru. Registry nie potrafi cofnąć skutków callbacku, który już wykonał
zapis. Nie przechowuje wartości draftów ani kanonicznej sceny.

## Integracja z New Problem

Otwarcie dialogu nie czyści już historii ani rejestru. Przed żądaniem utworzenia
sesji helper używa guardu bez automatycznego Apply. Cancel i odmowa dirty state
zachowują dane; dialog pozostaje modalny także przy Escape podczas żądania.
Przy zwykłym sukcesie rejestr i historia są czyszczone dopiero po ponownym
sprawdzeniu guardu przy pozytywnym ACK. Zmieniony rejestr nie jest czyszczony.
Helper zwraca zaakceptowaną tożsamość wraz z informacją o nieukończonej
finalizacji; dialog invaliduje zasoby tej sesji i blokuje następne Create.
Błąd listenera cleanup nie zamienia pozytywnego ACK w pozorną odmowę API.

To zachowuje wpisy rejestru przy wyścigu, ale nie jest serializacją wartości
szkiców ani dowodem hydration paneli po zmianie tożsamości. Publiczne create
nie ma jeszcze pełnego kontraktu reconcile nieznanego wyniku żądania;
ta poprawka nie dodaje automatycznych ponowień. Binding projektu, zachowanie
szkiców przy disconnect i transport restartu nadal wymagają integracji.

## Pozostałe granice

Ta zmiana nie włącza przycisku restartu ani nie dowodzi odtworzenia całego
workspace. Rejestr obejmuje wyłącznie zarejestrowanych właścicieli; nie jest
dowodem kompletnej inwentaryzacji wszystkich edytorów. Dla rzeczywistych paneli
opóźniona publikacja clean state po Apply powoduje odmowę guardu, a nie polling.

Kontrakt P8-53U przenosi scenę sesji i odrębny dokument projektu. Restart ma
zachować oba składniki; nie wymaga automatycznej synchronizacji dowolnego
archiwum z bieżącą sesją. Binding potrzebny do dalszego authoring P2 pozostaje
osobnym zadaniem. Następna implementacja restartu powinna podłączyć payload UI
do natywnego koordynatora i zweryfikować hydration przy świeżym pinie API.

## Bieżące dowody

Production TypeScript PASS: `12fcfa4cfe0542beb174df8485880aeb`.
Browser PASS: `2a1bc1f4deac47faad2f093d39572df0`, 23/23 grup, zero błędów strony
i konsoli, source digest przed/po
`74be38b03056b74e3220a05adf883c2aaa184bb7bded957dadc75ed63d6788e1`.
Własny serwer PID 31968 został zakończony. Fixture używa rzeczywistego kontrolera,
rejestru i produkcyjnego dialogu, a odpowiedzi API są mockami. Potwierdza Cancel,
dirty refusal, pending Escape, API failure, ACK race, foreign/in-place changes
oraz brak nakładania Apply/Reset przed publikacją React. Nie jest dowodem
backendowego zastąpienia sesji ani działania solvera.

Architecture hygiene PASS. Review znalezione wyścigi zamknięte; brak
nierozwiązanych findings. Lint PASS: `881702a4c53742b99bcd73658703a4b4`;
API hygiene PASS: `355082e0a4b846a4918e84e84a2df1d3`.
React Doctor (lokalny zakres changed), exit 0:
`1bbe8f428bf64258ac1faafddbe4dc80`. Dwie wskazówki przejrzano: chained array
iterations dotyczą małego rejestru formularzy, bez pól/topologii; sekwencyjne
`await` w Apply jest wymagane przez kontrolę ownera i recheck po każdym zapisie.
Równoległe Apply złamałoby tę granicę. Nie zmieniono konfiguracji ani nie
wyciszono reguł. Lint ma zero ostrzeżeń; wynik Doctor nie oznacza zero wskazówek.
Testy jednostkowe nie były kompilowane ani uruchamiane. Natywny backend nie
wymaga przebudowy dla tej zmiany frontendowej.
