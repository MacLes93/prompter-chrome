# Privacy Policy

## Prompter Chrome

Prompter Chrome stores prompt data locally so the extension can manage your prompt library offline.

## What data the extension handles

- Prompt titles, prompt content, tags, categories, favorites, and timestamps that you create in the extension
- Prompt text selected or read from supported pages when you use the quick-save widget on `chatgpt.com` or `claude.ai`
- Extension settings such as language, quick-save toggle, and legacy export toggle
- Optional folder-sync metadata and a persisted handle to a user-selected local folder when you enable folder sync

## How the data is used

- To display and manage your prompt library inside the extension
- To save prompts captured with the quick-save widget
- To sync prompts with a local folder only when you explicitly connect one

## Where data is stored

- `chrome.storage.local`
- IndexedDB for the optional local folder handle
- A user-selected local folder if you enable folder sync

## Data sharing

- Prompter Chrome does not send prompt data to external servers
- Prompter Chrome does not use analytics, tracking pixels, crash-reporting SDKs, or advertising services
- Prompter Chrome does not sell user data

## Permissions

- `storage` is used to save prompts and extension settings locally
- Host access to `https://chatgpt.com/*` and `https://claude.ai/*` is used only to show the quick-save widget on those supported pages

## User control

- You can edit or delete prompts at any time
- You can disable the quick-save widget in extension settings
- You can disconnect the optional synced folder at any time

