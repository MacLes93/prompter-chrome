const STORAGE_KEY = "prompter.prompts.v1";
const UNCATEGORIZED_ID = "uncategorized";
const ALLOWED_MESSAGE_HOSTS = new Set(["chatgpt.com", "claude.ai"]);

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  if (globalThis.crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultDb() {
  return {
    version: 1,
    categories: [{ id: UNCATEGORIZED_ID, name: "Bez kategorii", createdAt: nowIso() }],
    prompts: []
  };
}

function normalizeDb(input) {
  const base = input && typeof input === "object" ? input : defaultDb();
  const categories = Array.isArray(base.categories) ? [...base.categories] : [];
  if (!categories.some((cat) => cat && cat.id === UNCATEGORIZED_ID)) {
    categories.push({ id: UNCATEGORIZED_ID, name: "Bez kategorii", createdAt: nowIso() });
  }

  const categoryMap = new Map();
  for (const category of categories) {
    const id = typeof category?.id === "string" ? category.id.trim() : "";
    if (!id || categoryMap.has(id)) continue;

    categoryMap.set(id, {
      id,
      name:
        typeof category?.name === "string" && category.name.trim()
          ? category.name.trim()
          : "Bez nazwy",
      createdAt:
        typeof category?.createdAt === "string" && category.createdAt
          ? category.createdAt
          : nowIso()
    });
  }

  if (!categoryMap.has(UNCATEGORIZED_ID)) {
    categoryMap.set(UNCATEGORIZED_ID, {
      id: UNCATEGORIZED_ID,
      name: "Bez kategorii",
      createdAt: nowIso()
    });
  }

  const promptsInput = Array.isArray(base.prompts) ? base.prompts : [];
  const promptMap = new Map();

  for (const prompt of promptsInput) {
    const id = typeof prompt?.id === "string" && prompt.id.trim() ? prompt.id.trim() : randomId();
    if (promptMap.has(id)) continue;

    const tagsInput = Array.isArray(prompt?.tags) ? prompt.tags : [];
    const tags = [...new Set(tagsInput.map((tag) => String(tag).trim()).filter(Boolean))].sort();

    promptMap.set(id, {
      id,
      title:
        typeof prompt?.title === "string" && prompt.title.trim()
          ? prompt.title.trim()
          : "Nowy prompt",
      categoryId: categoryMap.has(prompt?.categoryId) ? prompt.categoryId : UNCATEGORIZED_ID,
      content:
        typeof prompt?.content === "string" && prompt.content.trim() ? prompt.content.trim() : "",
      tags,
      favorite: !!prompt?.favorite,
      createdAt:
        typeof prompt?.createdAt === "string" && prompt.createdAt ? prompt.createdAt : nowIso(),
      updatedAt:
        typeof prompt?.updatedAt === "string" && prompt.updatedAt
          ? prompt.updatedAt
          : typeof prompt?.createdAt === "string" && prompt.createdAt
            ? prompt.createdAt
            : nowIso(),
      lastUsedAt:
        typeof prompt?.lastUsedAt === "string" && prompt.lastUsedAt ? prompt.lastUsedAt : null
    });
  }

  return {
    version: 1,
    categories: Array.from(categoryMap.values()),
    prompts: Array.from(promptMap.values())
  };
}

async function getDb() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const raw = result?.[STORAGE_KEY];

  if (!raw) {
    const db = defaultDb();
    await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(db) });
    return db;
  }

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const normalized = normalizeDb(parsed);
    await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(normalized) });
    return normalized;
  } catch {
    const db = defaultDb();
    await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(db) });
    return db;
  }
}

async function saveDb(db) {
  await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(db) });
}

async function savePromptFromPage(payload) {
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  const content = typeof payload?.content === "string" ? payload.content.trim() : "";
  const tagsRaw = typeof payload?.tags === "string" ? payload.tags : "";

  if (!title) {
    throw new Error("Tytul jest wymagany");
  }
  if (!content) {
    throw new Error("Tresc promptu jest wymagana");
  }

  const db = await getDb();
  const now = nowIso();

  const tags = [...new Set(tagsRaw.split(",").map((tag) => tag.trim()).filter(Boolean))].sort();

  db.prompts.push({
    id: randomId(),
    title,
    categoryId: UNCATEGORIZED_ID,
    content,
    tags,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null
  });

  const normalized = normalizeDb(db);
  await saveDb(normalized);
  return { ok: true };
}

function isTrustedExtensionMessageSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!sender.url) return false;

  try {
    const url = new URL(sender.url);
    return ALLOWED_MESSAGE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isSavePromptPayload(payload) {
  return !!payload &&
    typeof payload === "object" &&
    typeof payload.title === "string" &&
    typeof payload.content === "string" &&
    typeof payload.tags === "string";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  if (!isTrustedExtensionMessageSender(sender)) return;

  if (message.type === "SAVE_PROMPT_FROM_PAGE") {
    if (!isSavePromptPayload(message.payload)) {
      sendResponse({ ok: false, error: "Invalid payload" });
      return;
    }

    void savePromptFromPage(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Blad zapisu" });
      });
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
