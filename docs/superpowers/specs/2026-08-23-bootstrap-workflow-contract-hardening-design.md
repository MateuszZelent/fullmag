# Wzmocnienie kontraktu workflow bootstrap

## Kontekst

Pull request #56 przywraca bramki bootstrap repozytorium, ale review wykazało dwa
pozostałe przypadki wyników fałszywie ujemnych w
`scripts/test_bootstrap_workflow_contract.py`:

1. kontrole wersji akcji porównują liczbę akcji z nazwami kroków widocznymi dla
   człowieka, więc zmiana nazwy kroku może ukryć przestarzałą wersję `uses:`;
2. kontrole gitlinków wymagają tylko pasującego wpisu `path` i mogą zaakceptować
   sekcję `.gitmodules` bez adresu klonowania.

Implementacja musi pozostać bez dodatkowych zależności, działać na Windows i
Linux oraz zachować `.github/workflows/bootstrap.yml` jako źródło prawdy dla
workflow.

## Rozważane podejścia

### 1. Parsowanie odpowiednich kontraktów biblioteką standardową Pythona

Wyodrębnić wartości YAML `uses:` parserem zakotwiczonym na początku klucza oraz
odczytać `.gitmodules` przez `configparser`. Walidować rzeczywiste odwołania do
akcji i kompletne rekordy submodułów. To wybrane podejście, ponieważ nie zależy
od nazw kroków i nie dodaje zależności CI.

### 2. Użycie szerszych wyrażeń regularnych

Wyrażenia regularne mogą sprawdzić oba pliki mniejszą liczbą helperów, ale
cytowanie, wcięcia i granice sekcji czynią kontrolę `.gitmodules` niepotrzebnie
kruchą.

### 3. Dodanie parsera YAML

Parser YAML precyzyjnie odwzorowałby workflow, lecz wprowadziłby nową zależność
wyłącznie dla małego statycznego testu kontraktu. `.gitmodules` nadal wymagałby
osobnego parsera.

## Projekt

Moduł testowy udostępni małe prywatne helpery o pojedynczej odpowiedzialności:

- zebranie znormalizowanych wartości `uses:` z wierszy workflow, których
  pierwszym kluczem YAML jest `uses`;
- potwierdzenie, że każde odwołanie do objętej kontraktem rodziny akcji używa
  wymaganej wersji i że oczekiwana rodzina występuje;
- sparsowanie sekcji `.gitmodules` i zbudowanie mapowania znormalizowanej ścieżki
  na niepusty URL;
- wyliczenie śledzonych gitlinków z indeksu Git i wymaganie dokładnie jednego
  kompletnego rekordu metadanych dla każdej ścieżki.

Kontrole akcji obejmą `actions/checkout`, `actions/setup-node`,
`actions/setup-python`, `actions/upload-artifact` i `pnpm/action-setup`.
Niepowiązane akcje zewnętrzne pozostają poza tym kontraktem.

Kontrola gitlinków odrzuci brak sekcji, zduplikowaną ścieżkę, pusty URL lub
metadane wskazujące ścieżkę inną niż śledzony gitlink. Nie będzie wykonywać
połączeń sieciowych ani sprawdzać osiągalności remote.

## Zachowanie błędów

Błędy wskażą rodzinę akcji albo ścieżkę gitlinku i opiszą naruszony niezmiennik.
Niepoprawna składnia `.gitmodules` przerwie test zamiast zostać po cichu uznana
za brak metadanych.

## Weryfikacja

Testy najpierw odtworzą oba zgłoszone wyniki fałszywie ujemne:

- zmiana nazwy kroku połączona z obniżeniem wersji akcji musi zakończyć się
  błędem;
- usunięcie URL gitlinku przy zachowaniu ścieżki musi zakończyć się błędem.

Następnie test kontraktu repozytorium musi przejść dla rzeczywistych plików.
Pełna weryfikacja PR obejmuje również kontrakty Python API, typecheck TypeScript,
ukierunkowane ESLint i Vitest, `git diff --check` oraz świeże przebiegi GitHub
Actions. Kontrakt Rust DMI pozostaje zależny od CI na Linuxie, ponieważ lokalny
build Windows poprzednio wyczerpał miejsce przed zakończeniem.

## Granice zakresu

Zmiana nie modyfikuje zachowania workflow, wersji akcji, członkostwa submodułów,
kodu produktu, OpenAPI, semantyki runtime ani architektury frontendu. Wyłącznie
uodparnia istniejące niezmienniki bootstrap na dwa zgłoszone przypadki wyników
fałszywie ujemnych.
