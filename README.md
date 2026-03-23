# Prompter Chrome (MV3)

Offline Chrome extension for managing prompt templates.

## Features

- Prompt library with categories, tags, favorites, and quick filtering.
- Markdown folder import with automatic category/tag mapping.
- ZIP export for prompts.
- Optional legacy JSON import/export, hidden by default and available from `Settings`.
- Quick-save widget on `chatgpt.com` and `claude.ai`.
- UI language switch: English and Polish (`Settings -> Language`).

## Data Storage

- Main data: `chrome.storage.local` (persistent across browser restarts/crashes).

## Prompt Folder Import

- Use `Open prompts folder` in the `Data` section to import a whole Markdown directory.
- The root folder is ignored.
- The first folder under the root becomes the prompt category.
- Any following folders become tags.
- Example:
  `prompter/jira/api/create-plan.md`
  becomes category `jira` and tag `api`.

## Prompt Export

- Use `Export prompts` in the `Data` section to download the current library as a single ZIP file.
- Exported files are written as Markdown and grouped using this structure:
  `prompter/<category>/<tag...>/<prompt-title>.md`
- Legacy JSON import/export can be enabled from `Settings`.

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
- `#data` - prompt import/export and data summary.
- `#settings` - language and site integration settings.

## Required Permissions

- `storage` - save app data and settings.
- `downloads` - download exported prompt archives and optional legacy JSON exports.
- Host permissions for `https://chatgpt.com/*` and `https://claude.ai/*` - quick-save widget injection.
