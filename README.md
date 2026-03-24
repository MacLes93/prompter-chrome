# Prompter Chrome (MV3)

Offline Chrome extension for managing prompt templates.

## Features

- Prompt library with categories, tags, favorites, sync badges, and quick filtering.
- Category management with search, sorting, multi-select, bulk move, merge, and delete flows.
- Optional prompt folder sync with manual rescan and automatic write-back for prompts edited in the extension.
- Markdown folder import with automatic category/tag mapping.
- ZIP export for prompts.
- Optional legacy JSON import/export, hidden by default and available from `Settings`.
- Quick-save widget on `chatgpt.com` and `claude.ai`.
- UI language switch: English and Polish (`Settings -> Language`).

## Data Storage

- Main data: `chrome.storage.local` (primary prompt database and settings).
- Optional prompt folder: user-selected local directory used for Markdown sync.
- Folder handle persistence: stored separately from the main prompt database so the extension can reconnect to the selected directory.

## Prompt Folder Sync

- Folder sync is optional. Without a connected folder the extension works only with `chrome.storage.local`.
- Use `Connect folder` in the `Data` section to attach a local prompt directory.
- Use `Sync folder` to rescan the directory and import new or changed Markdown files.
- Prompts created or edited inside the extension are automatically written back to the connected folder.
- Prompt identity for folder sync is based on `sourcePath`.
- Conflict strategy: the extension does not overwrite automatically when both the file and local record changed since the last sync. Instead it marks the prompt as `Conflict`.
- If a file disappears from the connected folder, the prompt stays in `chrome.storage.local` and is marked as `Missing file`.
- Sync issue actions are available from the `Data` view:
  - `Import from file`
  - `Overwrite file`
  - `Disconnect file`
- Prompt sync states used by the UI:
  - `Synced`
  - `Local only`
  - `Missing file`
  - `Conflict`

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
- ZIP export is separate from folder sync and is always available.
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
- `#prompts` - prompt library, sync badges, preview modal, and local-only filtering.
- `#create` - create/edit prompt view.
- `#categories` - category management with bulk operations.
- `#data` - folder sync, sync issue handling, prompt import/export, and data summary.
- `#settings` - language and site integration settings.

## Required Permissions

- `storage` - save app data and settings.
- Host permissions for `https://chatgpt.com/*` and `https://claude.ai/*` - quick-save widget injection.

## Privacy

- The extension stores prompts, tags, categories, settings, and optional folder-sync metadata locally on the user's device.
- No analytics, tracking, or external network transmission is used by the extension.
- Publish [PRIVACY.md](https://github.com/MacLes93/prompter-chrome/blob/main/PRIVACY.md) at a public URL and use that URL in the Chrome Web Store privacy policy field before submission.
