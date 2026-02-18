# Prompter Chrome (MV3)

Offline Chrome extension for managing prompt templates.

## Features

- Prompt library with categories, tags, favorites, and quick filtering.
- JSON import/export and backup flow.
- Quick-save widget on `chatgpt.com` and `claude.ai`.
- UI language switch: English and Polish (`Settings -> Language`).

## Data Storage

- Main data: `chrome.storage.local` (persistent across browser restarts/crashes).
- Backup file: `Downloads/prompter_chrome/prompts-latest.json`.
- Unsaved backup changes show a non-blocking notice in the app header.

## Quick Save (ChatGPT + Claude)

- Adds a `+ Save to Prompter` button on `chatgpt.com` and `claude.ai`.
- Opens a small form (title, content, tags).
- Saves directly into the same extension library (`chrome.storage.local`).
- Widget texts follow the selected app language (EN/PL).

## Setup

```bash
cd <path-to-repository>
npm install
npm run build
```

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `dist` directory from this project.
5. Open extension `Details` and click `Extension options`.

After code changes:

1. Run `npm run build`.
2. In `chrome://extensions`, click `Reload` for this extension.

## App Routes

- `#dashboard` - summary cards, recent prompts, top tags.
- `#prompts` - prompt library and full preview modal.
- `#create` - create/edit prompt view.
- `#categories` - category management.
- `#data` - import/export and data summary.
- `#settings` - language and site integration settings.

## Required Permissions

- `storage` - save app data and settings.
- `downloads` - write JSON backups.
- Host permissions for `https://chatgpt.com/*` and `https://claude.ai/*` - quick-save widget injection.
