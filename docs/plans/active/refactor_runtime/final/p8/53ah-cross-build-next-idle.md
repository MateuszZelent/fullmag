# P8-53AH — kolejna rezerwacja po podmianie buildu

Data: 04.10.2026. Zakres: natywny Windows dev, następna rezerwacja cold-idle
po live completion. Bramka tego fragmentu przeszła; P8-53 i cały plan pozostają
w realizacji.

## Implementacja

Zweryfikowana tożsamość buildu ownera trafia do `OwnedDevelopmentApi`, następnie
do `AuthoringAcquisition` i cold-idle proof. `PinnedApiBuildIdentity` waliduje
format pinów; nie jest samodzielnym dowodem integralności pakietu. W launcherze
jej źródłem pozostaje skompilowana tożsamość początkowego API albo potwierdzony
manifest kandydata z P8-53AG.

`cold_idle_for_api_with_build` sprawdza wskazany build, API UUID i rzeczywisty
binding accepted store przed fencing oraz ponownie po rezerwacji. Dowód zachowuje
oczekiwany build dla późniejszego `verify_for_api`. Dotychczasowy konsument
`cold_idle_for_api` oraz runtime-service attach nadal wymagają lokalnego buildu.
Nie zmieniono metadata gate, globalnego idle, startup locks ani trwałego fence.
Niepewność po fencing nie usuwa blokady.

Adapter diagnostyczny po udanym completion przejmuje ponownie to samo API,
porównuje scenę, tworzy nowy staged handoff, sprawdza odmowę niezgodnego buildu
przed fencing, rezerwuje właściwy magazyn i ponownie sprawdza binding API.
Następnie jawnie zwalnia tę nową rezerwację i wysyła abort. Nie wykonuje drugiego
commit ani restartu. Proces staging helpera ma osobną ramkę wait/exit w receipcie.
Próba między buildami ma dodatkowo potwierdzić odmowę domyślnego pinu launchera.

## Weryfikacja

`just windows-workspace-build dev dev 3197 auto`: exit 0 po zamknięciu starego
workspace i recovery. Log `cross-build-next-idle-recovered-build.log` w
`windows-native-fdm-cpu-dev/windows-runtime`.

`just verify-windows-development-backend-api 809ee2d2d6ae48ee8fb20b0fb760b5dc`:
**300 kontroli, exit 0; wszystkie 104 zarejestrowane procesy odebrane**.
Receipt: `development-backend-api-checks/checks/8e91a480f1294b46a59839245bc21dff/receipt.json`.
Backend source przed/po:
`263901b07cd17f7d5d0fd1f542912d58157ab322b41ee5528d7a1637c5858e5d`.
Build commit: `9ffbb876cd9e20bde51c55144493804663566155`.
Snapshot launchera:
`ad47e211606468a5df5a7c2a0a63e6e2f5cb7eaaa159907dac4735b778db3c6d`.
Snapshot replacement API w próbie cross-build:
`273d37e3a9f7bf988cfdada8a10a3d148637066d9722eefe657ec9e905dccfaf`.

Warianty ACK/lost-ACK i rzeczywistego innego buildu przeszły ponowne przejęcie,
zachowanie sceny, staging asset-backed handoffu, odmowę błędnego buildu przed
fencing, poprawną rezerwację, ponowną kontrolę API/store oraz jawny abort.
W cross-build domyślne oczekiwanie tożsamości launchera zostało odrzucone;
potwierdzony pin kandydata działał. Końcowa mutacja HTTP potwierdza ponowne
otwarcie admission. Historia pierwszego completion pozostała zgodna, a jego
kapsuła nadal jest `staged`; nie wykonano drugiego commit ani restartu.
Trzy dodatkowe helpery staging mają potwierdzone wait i exit 0.

Ścieżki dowodów są względem storage resolvera dla bieżącego checkoutu.
Pozostałe formaty kapsuły i loader nie zmieniły się; zachowano poprzednią serię
133 interpretowanych kontroli bez skipów z P8-53AG. Review źródeł i końcowy
diff check przeszły. Nie kompilowano testów jednostkowych.

## Ochrona działającej sesji podczas integracji

Scoped rustfmt i diff check przeszły. Review źródeł nie wykazał actionable findings.
Pierwsza zarządzana kompilacja produkcyjnych EXE zakończyła Cargo z exit 0,
ale końcowa kontrola źródeł **odrzuciła cały build**. Nie wykorzystano go jako
kwalifikowanego pakietu ani do próby runtime.

Po zakończeniu buildu dwa odczyty backend fingerprint były zgodne:
`31d3e0e8bdb23dc6bba6636e9d28c253881e17809fa04a2b40da774afb11df04`.
Ponowne `just windows-workspace-build dev dev 3197 auto` odmówiło już w preflight:
`Python/frontend dependencies changed; save and close the active workspace before rebuilding`.
Hash zależności działającego pakietu:
`e606ad787b903a4a5f7076c68310ba89a2e71242447788f800b85dc0b4ab034d`.
Bieżący hash:
`c361eecac63c234be47472ac68db82a391d223b3789c5de2bc7ec2a458c2bde9`.
Przyczyna została potwierdzona: podczas buildu inna integracja scaliła
`origin/master`, zmieniając m.in. `apps/control-room/package.json`.
Aktualny HEAD: `9ffbb876cd9e20bde51c55144493804663566155`.
Sam brak lokalnego git diff po scaleniu nie dowodzi zgodności zależności
działającego pakietu. Nie omijano preflight. Przed zgodą użytkownika UI na 3197
pozostawało dostępne z HTTP 200.

Logi względem storage profilu `windows-native-fdm-cpu-dev/windows-runtime`:
`cross-build-next-idle-build.log` i `cross-build-next-idle-stable-build.log`.
Nie kompilowano testów jednostkowych. Użytkownik następnie polecił zakończyć
Fullmaga, jeśli nadal działa. Zweryfikowano bieżące PID, czas utworzenia,
ścieżkę EXE, drzewo potomne i właścicieli portów. Zatrzymano wyłącznie jego okno
`fullmag-ui.exe`; launcher zakończył backend i frontend. Potwierdzono zamknięcie
portów 3197/8081 oraz brak pierwotnych procesów. Ponownie użytego PID należącego
do nowego `pwsh.exe` nie zatrzymano.

`just windows-runtime-recover 3197`: exit 0, stan `recovered`. Zachowano
oryginał `native-runtime-prior-0a5a3b15d6834184bf510acfcbb00b7b.json` w runtime
resolvera; jego hash:
`b6285c37eca309e7d3d92add9036a9842452068b4a2393c7db15f5337d0cfd37`.
Recovery nie jest odtworzeniem modelu ani dowodem etapu. Po nim wykonano
odrębne pozytywne build/runtime gates opisane powyżej. Użytkowy Fullmag
pozostawiono zamknięty zgodnie z poleceniem; nie uruchamiano go automatycznie.

## Następny krok

Produkcyjny supervisor, powtórny live restart, Compute, warm service i hydration
UI pozostają otwarte. `restart_available` pozostaje `false`.
Druga rezerwacja nie dowodzi drugiego restartu ani odtworzenia szkiców.
Publikacja na publicznym remote pozostaje zablokowana przez wcześniejszą
automatyczną kontrolę zgody.
