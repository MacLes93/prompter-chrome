# Prompter Chrome (MV3)

Rozszerzenie Chrome z biblioteką promptów, działające offline.

## Co zapisuje dane

- Główne dane: `chrome.storage.local` (odporne na restart/crash przeglądarki).
- Backup pliku JSON: `Downloads/prompter_chrome/prompts-latest.json`.
- Po zmianach pojawia się nieblokujący pasek info u góry aplikacji.
- Klik paska rozwija akcję: `Pobierz backup (nadpisz stary)`.

## Quick save z ChatGPT i Claude

- Na `chatgpt.com` i `claude.ai` pojawia się przycisk `+ Save to Prompter`.
- Klik otwiera mały formularz (tytuł, treść, tagi).
- Zapis trafia od razu do tej samej biblioteki (`chrome.storage.local`).

## Uruchomienie

```bash
cd /Users/mlesniewski/Codex/prompter/prompter_chrome
npm install
npm run build
```

## Instalacja w Chrome

1. Otwórz `chrome://extensions`.
2. Włącz `Developer mode`.
3. Kliknij `Load unpacked`.
4. Wskaż folder: `/Users/mlesniewski/Codex/prompter/prompter_chrome/dist`.
5. Otwórz `Details` rozszerzenia i wejdź w `Extension options`.

## Routing

- `#prompts` - biblioteka kart + pełny podgląd po kliknięciu.
- `#create` - oddzielna strona dodawania/edycji promptu.
- `#categories` - kategorie.
- `#data` - import/export.
