import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Category = {
  id: string;
  name: string;
  createdAt: string;
};

type Prompt = {
  id: string;
  title: string;
  categoryId: string;
  content: string;
  tags: string[];
  sourcePath: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

type DbFile = {
  version: number;
  categories: Category[];
  prompts: Prompt[];
};

type SortMode = "newest" | "lastUsed" | "az";
type CategorySortMode = "az" | "countDesc" | "countAsc" | "newest";
type CategoryBulkAction = "move" | "merge" | "delete";
type PromptSyncStatus = "local_only" | "synced" | "missing_file" | "conflict";

type PromptDraft = {
  id?: string;
  title: string;
  categoryId: string;
  content: string;
  tags: string[];
  favorite: boolean;
};

type AppPage = "dashboard" | "prompts" | "create" | "categories" | "data" | "settings";
type Language = "pl" | "en";

type RouteState = {
  page: AppPage;
  params: URLSearchParams;
};

type MdImportCandidate = {
  sourcePath: string;
  categoryName: string;
  title: string;
  content: string;
  tags: string[];
};

type FolderSyncRecord = {
  sourcePath: string;
  lastSyncedHash: string;
  lastSyncedAt: string;
  missing: boolean;
  conflict: boolean;
  fileHash: string | null;
};

type FolderSyncState = {
  connected: boolean;
  folderName: string | null;
  lastScannedAt: string | null;
  records: Record<string, FolderSyncRecord>;
};

type LibraryApi = {
  loading: boolean;
  db: DbFile;
  sync: FolderSyncState;
  syncBusy: boolean;
  error: string | null;
  toast: string | null;
  clearError: () => void;
  createPrompt: () => PromptDraft;
  upsertPrompt: (draft: PromptDraft) => string;
  togglePromptFavorite: (id: string) => void;
  deletePrompt: (id: string) => void;
  duplicatePrompt: (id: string) => string;
  copyPrompt: (id: string) => Promise<void>;
  createCategory: (name: string) => void;
  renameCategory: (id: string, name: string) => void;
  deleteCategory: (id: string) => void;
  deleteCategories: (ids: string[]) => void;
  movePromptsToCategory: (sourceIds: string[], targetId: string) => void;
  mergeCategories: (sourceIds: string[], targetId: string) => void;
  exportJson: () => string;
  importJson: (raw: string) => void;
  importMarkdownPrompts: (candidates: MdImportCandidate[]) => void;
  connectPromptFolder: () => Promise<void>;
  disconnectPromptFolder: () => Promise<void>;
  rescanPromptFolder: () => Promise<void>;
  overwritePromptToFolder: (id: string) => Promise<void>;
  importPromptFromFolder: (id: string) => Promise<void>;
  disconnectPromptFromFolder: (id: string) => void;
  getPromptSyncStatus: (prompt: Prompt) => PromptSyncStatus;
};

const UNCATEGORIZED_ID = "uncategorized";
const STORAGE_KEY = "prompter.prompts.v1";
const FOLDER_SYNC_STATE_KEY = "prompter.folderSync.v1";
const QUICK_SAVE_ENABLED_KEY = "prompter.quickSaveEnabled";
const LANGUAGE_KEY = "prompter.language";
const LEGACY_JSON_EXPORT_ENABLED_KEY = "prompter.legacyJsonExportEnabled";
const HANDLE_DB_NAME = "prompter-handles";
const HANDLE_STORE_NAME = "handles";
const HANDLE_KEY = "prompt-folder";
const chromeApi = (globalThis as { chrome?: any }).chrome;
const hasExtensionStorage = Boolean(chromeApi?.storage?.local);
const DEFAULT_UNCATEGORIZED_LABEL = "Bez kategorii";
const MARKDOWN_EXPORT_ROOT = "prompter";

function txt(language: Language, pl: string, en: string) {
  return language === "pl" ? pl : en;
}

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function uniqueSortedTags(tags: string[]) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "pl", { sensitivity: "base" })
  );
}

function normalizeSourcePath(raw: string | null | undefined) {
  if (!raw) return null;
  const normalized = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return normalized || null;
}

function stripMarkdownExtension(fileName: string) {
  return fileName.replace(/\.md$/i, "");
}

function sanitizePathSegment(segment: string) {
  const sanitized = segment
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || "untitled";
}

function titleFromMarkdownFile(sourcePath: string, content: string) {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#\s+.+/.test(line));
  if (heading) return heading.replace(/^#\s+/, "").trim();

  const fileName = sourcePath.split("/").pop() || "prompt.md";
  return stripMarkdownExtension(fileName).replace(/[-_]+/g, " ").trim() || "Nowy prompt";
}

function tagsFromSourcePath(sourcePath: string) {
  const normalized = normalizeSourcePath(sourcePath);
  if (!normalized) return [];
  const parts = normalized.split("/");
  if (parts.length <= 2) return [];
  return uniqueSortedTags(parts.slice(2, -1));
}

function categoryNameFromSourcePath(sourcePath: string) {
  const normalized = normalizeSourcePath(sourcePath);
  if (!normalized) return DEFAULT_UNCATEGORIZED_LABEL;
  const parts = normalized.split("/");
  if (parts.length >= 3) return parts[1];
  return DEFAULT_UNCATEGORIZED_LABEL;
}

function markdownExportPath(prompt: Prompt, categoryName: string) {
  const folderParts = [
    MARKDOWN_EXPORT_ROOT,
    sanitizePathSegment(categoryName || DEFAULT_UNCATEGORIZED_LABEL),
    ...prompt.tags.map(sanitizePathSegment)
  ];
  const fileName = `${sanitizePathSegment(prompt.title)}.md`;
  return [...folderParts, fileName].join("/");
}

function folderPromptPath(prompt: Pick<Prompt, "title" | "tags">, categoryName: string) {
  const folderParts = [
    ...(categoryName && categoryName !== DEFAULT_UNCATEGORIZED_LABEL ? [sanitizePathSegment(categoryName)] : []),
    ...prompt.tags.map(sanitizePathSegment)
  ];
  const fileName = `${sanitizePathSegment(prompt.title)}.md`;
  return [...folderParts, fileName].join("/");
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dateToDosParts(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function createStoredZip(files: Array<{ path: string; content: string }>) {
  function toArrayBuffer(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  const encoder = new TextEncoder();
  const zipDate = dateToDosParts(new Date());
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const pathBytes = encoder.encode(file.path);
    const contentBytes = encoder.encode(file.content);
    const crc = crc32(contentBytes);

    const localHeader = new Uint8Array(30 + pathBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, zipDate.dosTime, true);
    localView.setUint16(12, zipDate.dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, contentBytes.length, true);
    localView.setUint32(22, contentBytes.length, true);
    localView.setUint16(26, pathBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(pathBytes, 30);
    localParts.push(localHeader, contentBytes);

    const centralHeader = new Uint8Array(46 + pathBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, zipDate.dosTime, true);
    centralView.setUint16(14, zipDate.dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, contentBytes.length, true);
    centralView.setUint32(24, contentBytes.length, true);
    centralView.setUint16(28, pathBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(pathBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + contentBytes.length;
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob(
    [...localParts, ...centralParts, endRecord].map((part) => toArrayBuffer(part)),
    { type: "application/zip" }
  );
}

async function markdownCandidateFromFile(file: File) {
  const pathSource = "webkitRelativePath" in file && typeof file.webkitRelativePath === "string"
    ? file.webkitRelativePath
    : file.name;
  const sourcePath = normalizeSourcePath(pathSource);
  if (!sourcePath) return null;

  const content = (await file.text()).trim();
  if (!content) return null;

  return {
    sourcePath,
    categoryName: categoryNameFromSourcePath(sourcePath),
    title: titleFromMarkdownFile(sourcePath, content),
    content,
    tags: tagsFromSourcePath(sourcePath)
  } satisfies MdImportCandidate;
}

function markdownCandidateFromRelativePath(sourcePath: string, content: string) {
  const normalized = normalizeSourcePath(sourcePath);
  if (!normalized) return null;
  const parts = normalized.split("/");
  const fileName = parts[parts.length - 1] || "prompt.md";
  const title = titleFromMarkdownFile(fileName, content);
  const categoryName = parts.length >= 2 ? parts[0] : DEFAULT_UNCATEGORIZED_LABEL;
  const tags = uniqueSortedTags(parts.length >= 3 ? parts.slice(1, -1) : []);

  return {
    sourcePath: normalized,
    categoryName,
    title,
    content: content.trim(),
    tags
  } satisfies MdImportCandidate;
}

function textHash(content: string) {
  const bytes = new TextEncoder().encode(content);
  return crc32(bytes).toString(16).padStart(8, "0");
}

function defaultFolderSyncState(): FolderSyncState {
  return {
    connected: false,
    folderName: null,
    lastScannedAt: null,
    records: {}
  };
}

function normalizeFolderSyncState(input: FolderSyncState | null | undefined): FolderSyncState {
  return {
    connected: Boolean(input?.connected),
    folderName: typeof input?.folderName === "string" && input.folderName.trim() ? input.folderName.trim() : null,
    lastScannedAt: typeof input?.lastScannedAt === "string" && input.lastScannedAt ? input.lastScannedAt : null,
    records: Object.fromEntries(
      Object.entries(input?.records ?? {})
        .map(([sourcePath, record]) => {
          const normalizedPath = normalizeSourcePath(sourcePath);
          if (!normalizedPath) return null;
          return [normalizedPath, {
            sourcePath: normalizedPath,
            lastSyncedHash: typeof record?.lastSyncedHash === "string" ? record.lastSyncedHash : "",
            lastSyncedAt: typeof record?.lastSyncedAt === "string" && record.lastSyncedAt ? record.lastSyncedAt : nowIso(),
            missing: Boolean(record?.missing),
            conflict: Boolean(record?.conflict),
            fileHash: typeof record?.fileHash === "string" && record.fileHash ? record.fileHash : null
          } satisfies FolderSyncRecord] as const;
        })
        .filter((entry): entry is readonly [string, FolderSyncRecord] => entry !== null)
    )
  };
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, "readonly");
    const store = tx.objectStore(HANDLE_STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, "readwrite");
    const store = tx.objectStore(HANDLE_STORE_NAME);
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, "readwrite");
    const store = tx.objectStore(HANDLE_STORE_NAME);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
  });
}

async function loadPromptFolderHandle(): Promise<any | null> {
  try {
    return await idbGet<any>(HANDLE_KEY);
  } catch {
    return null;
  }
}

async function savePromptFolderHandle(handle: any): Promise<void> {
  await idbSet(HANDLE_KEY, handle);
}

async function clearPromptFolderHandle(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

async function ensureHandlePermission(handle: any, mode: "read" | "readwrite") {
  if (!handle?.queryPermission || !handle?.requestPermission) return true;
  const options = { mode };
  if (await handle.queryPermission(options) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function getFileHandleByRelativePath(rootHandle: any, relativePath: string) {
  const normalized = normalizeSourcePath(relativePath);
  if (!normalized) return null;
  const parts = normalized.split("/");
  let currentHandle = rootHandle;
  for (const segment of parts.slice(0, -1)) {
    currentHandle = await currentHandle.getDirectoryHandle(segment);
  }
  return currentHandle.getFileHandle(parts[parts.length - 1]);
}

async function readFileContentFromDirectory(rootHandle: any, relativePath: string) {
  const fileHandle = await getFileHandleByRelativePath(rootHandle, relativePath);
  if (!fileHandle) return null;
  const file = await fileHandle.getFile();
  return file.text();
}

async function deleteFileFromDirectory(rootHandle: any, relativePath: string) {
  const normalized = normalizeSourcePath(relativePath);
  if (!normalized) return;
  const parts = normalized.split("/");
  let currentHandle = rootHandle;
  for (const segment of parts.slice(0, -1)) {
    currentHandle = await currentHandle.getDirectoryHandle(segment);
  }
  await currentHandle.removeEntry(parts[parts.length - 1]);
}

async function writePromptMarkdownToDirectory(rootHandle: any, relativePath: string, content: string) {
  const normalized = normalizeSourcePath(relativePath);
  if (!normalized) return;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return;

  let currentHandle = rootHandle;
  for (const segment of parts.slice(0, -1)) {
    currentHandle = await currentHandle.getDirectoryHandle(sanitizePathSegment(segment), { create: true });
  }

  const fileName = parts[parts.length - 1];
  const fileHandle = await currentHandle.getFileHandle(fileName.toLowerCase().endsWith(".md") ? fileName : `${fileName}.md`, {
    create: true
  });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function collectMarkdownCandidatesFromDirectoryHandle(rootHandle: any): Promise<MdImportCandidate[]> {
  const candidates: MdImportCandidate[] = [];

  async function walk(currentHandle: any, prefix = ""): Promise<void> {
    for await (const [name, handle] of currentHandle.entries()) {
      const nextPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        await walk(handle, nextPath);
        continue;
      }
      if (!/\.md$/i.test(name)) continue;
      const file = await handle.getFile();
      const content = (await file.text()).trim();
      if (!content) continue;
      const candidate = markdownCandidateFromRelativePath(nextPath, content);
      if (candidate) candidates.push(candidate);
    }
  }

  await walk(rootHandle);
  return candidates.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, "pl", { sensitivity: "base" }));
}

function createDraft(): PromptDraft {
  return {
    title: "",
    categoryId: UNCATEGORIZED_ID,
    content: "",
    tags: [],
    favorite: false
  };
}

function defaultDb(): DbFile {
  return {
    version: 1,
    categories: [{ id: UNCATEGORIZED_ID, name: DEFAULT_UNCATEGORIZED_LABEL, createdAt: nowIso() }],
    prompts: []
  };
}

function normalizeDb(input: DbFile): DbFile {
  const categories = [...(input.categories ?? [])];
  if (!categories.some((c) => c.id === UNCATEGORIZED_ID)) {
    categories.push({ id: UNCATEGORIZED_ID, name: DEFAULT_UNCATEGORIZED_LABEL, createdAt: nowIso() });
  }

  const categoryMap = new Map<string, Category>();
  for (const c of categories) {
    const id = (c.id ?? "").trim();
    if (!id || categoryMap.has(id)) continue;
    categoryMap.set(id, {
      id,
      name: c.name?.trim() || "Bez nazwy",
      createdAt: c.createdAt || nowIso()
    });
  }

  if (!categoryMap.has(UNCATEGORIZED_ID)) {
    categoryMap.set(UNCATEGORIZED_ID, {
      id: UNCATEGORIZED_ID,
      name: DEFAULT_UNCATEGORIZED_LABEL,
      createdAt: nowIso()
    });
  }

  const promptMap = new Map<string, Prompt>();
  for (const p of input.prompts ?? []) {
    const id = (p.id ?? "").trim() || uuid();
    if (promptMap.has(id)) continue;

    const tags = Array.from(new Set((p.tags ?? []).map((tag) => tag.trim()).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b, "pl", { sensitivity: "base" })
    );

    promptMap.set(id, {
      id,
      title: p.title?.trim() || "Nowy prompt",
      categoryId: categoryMap.has(p.categoryId) ? p.categoryId : UNCATEGORIZED_ID,
      content: p.content?.trim() || "",
      tags,
      sourcePath: normalizeSourcePath(p.sourcePath),
      favorite: !!p.favorite,
      createdAt: p.createdAt || nowIso(),
      updatedAt: p.updatedAt || p.createdAt || nowIso(),
      lastUsedAt: p.lastUsedAt || null
    });
  }

  return {
    version: 1,
    categories: Array.from(categoryMap.values()),
    prompts: Array.from(promptMap.values())
  };
}

function mergeImported(current: DbFile, imported: DbFile): DbFile {
  const next: DbFile = {
    version: 1,
    categories: [...current.categories],
    prompts: [...current.prompts]
  };

  const categoryIdMap = new Map(next.categories.map((c) => [c.id, c.id]));
  const categoryNameMap = new Map(next.categories.map((c) => [c.name.toLowerCase(), c.id]));

  for (const importedCategory of imported.categories) {
    const importedId = importedCategory.id || uuid();

    if (categoryIdMap.has(importedId)) {
      categoryIdMap.set(importedId, importedId);
      continue;
    }

    const existingByName = categoryNameMap.get(importedCategory.name.toLowerCase());
    if (existingByName) {
      categoryIdMap.set(importedId, existingByName);
      continue;
    }

    next.categories.push(importedCategory);
    categoryIdMap.set(importedId, importedId);
    categoryNameMap.set(importedCategory.name.toLowerCase(), importedId);
  }

  categoryIdMap.set(UNCATEGORIZED_ID, UNCATEGORIZED_ID);

  const promptById = new Map(next.prompts.map((p) => [p.id, p]));
  for (const importedPrompt of imported.prompts) {
    const normalized: Prompt = {
      ...importedPrompt,
      id: importedPrompt.id || uuid(),
      categoryId: categoryIdMap.get(importedPrompt.categoryId) ?? UNCATEGORIZED_ID,
      tags: uniqueSortedTags(importedPrompt.tags ?? []),
      sourcePath: normalizeSourcePath(importedPrompt.sourcePath)
    };

    promptById.set(normalized.id, normalized);
  }

  next.prompts = Array.from(promptById.values());
  return normalizeDb(next);
}

async function readStoredDbRaw(): Promise<string | null> {
  if (hasExtensionStorage) {
    const result = await chromeApi.storage.local.get([STORAGE_KEY]);
    const value = result?.[STORAGE_KEY];
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return JSON.stringify(value);
    return null;
  }

  return localStorage.getItem(STORAGE_KEY);
}

async function writeStoredDbRaw(json: string): Promise<void> {
  if (hasExtensionStorage) {
    await chromeApi.storage.local.set({ [STORAGE_KEY]: json });
    return;
  }

  localStorage.setItem(STORAGE_KEY, json);
}

async function readStoredFolderSyncRaw(): Promise<string | null> {
  if (hasExtensionStorage) {
    const result = await chromeApi.storage.local.get([FOLDER_SYNC_STATE_KEY]);
    const value = result?.[FOLDER_SYNC_STATE_KEY];
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return JSON.stringify(value);
    return null;
  }

  return localStorage.getItem(FOLDER_SYNC_STATE_KEY);
}

async function writeStoredFolderSyncRaw(json: string): Promise<void> {
  if (hasExtensionStorage) {
    await chromeApi.storage.local.set({ [FOLDER_SYNC_STATE_KEY]: json });
    return;
  }

  localStorage.setItem(FOLDER_SYNC_STATE_KEY, json);
}

async function loadDb(): Promise<DbFile> {
  const raw = await readStoredDbRaw();
  if (!raw) {
    const initial = defaultDb();
    await writeStoredDbRaw(JSON.stringify(initial));
    return initial;
  }

  try {
    const parsed = JSON.parse(raw) as DbFile;
    const normalized = normalizeDb(parsed);
    await writeStoredDbRaw(JSON.stringify(normalized));
    return normalized;
  } catch {
    const fallback = defaultDb();
    await writeStoredDbRaw(JSON.stringify(fallback));
    return fallback;
  }
}

async function loadFolderSyncState(): Promise<FolderSyncState> {
  const raw = await readStoredFolderSyncRaw();
  if (!raw) {
    const initial = defaultFolderSyncState();
    await writeStoredFolderSyncRaw(JSON.stringify(initial));
    return initial;
  }

  try {
    const parsed = JSON.parse(raw) as FolderSyncState;
    const normalized = normalizeFolderSyncState(parsed);
    await writeStoredFolderSyncRaw(JSON.stringify(normalized));
    return normalized;
  } catch {
    const fallback = defaultFolderSyncState();
    await writeStoredFolderSyncRaw(JSON.stringify(fallback));
    return fallback;
  }
}

function parseHash(): RouteState {
  const hashRaw = window.location.hash.replace(/^#/, "");
  const [pathPart, queryPart] = hashRaw.split("?");
  const page = (pathPart || "dashboard") as AppPage;
  const validPage: AppPage = ["dashboard", "prompts", "create", "categories", "data", "settings"].includes(page)
    ? page
    : "dashboard";

  return {
    page: validPage,
    params: new URLSearchParams(queryPart || "")
  };
}

function makeHash(page: AppPage, params?: URLSearchParams | Record<string, string>) {
  let query = "";
  if (params instanceof URLSearchParams) {
    query = params.toString();
  } else if (params) {
    query = new URLSearchParams(params).toString();
  }

  return query ? `#${page}?${query}` : `#${page}`;
}

function useRouteState() {
  const [route, setRoute] = useState<RouteState>(() => parseHash());

  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = "#dashboard";
    }

    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function navigate(page: AppPage, params?: URLSearchParams | Record<string, string>) {
    window.location.hash = makeHash(page, params);
  }

  return { route, navigate };
}

function useLanguage() {
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    return saved === "en" ? "en" : "pl";
  });

  useEffect(() => {
    let active = true;

    void (async () => {
      if (hasExtensionStorage) {
        const result = await chromeApi.storage.local.get([LANGUAGE_KEY]);
        if (!active) return;
        const value = result?.[LANGUAGE_KEY];
        const nextLanguage: Language = value === "en" ? "en" : "pl";
        setLanguage(nextLanguage);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language);
    if (hasExtensionStorage) {
      void chromeApi.storage.local.set({ [LANGUAGE_KEY]: language });
    }
    document.documentElement.lang = language;
  }, [language]);

  return [language, setLanguage] as const;
}

function useQuickSaveSetting() {
  const [quickSaveEnabled, setQuickSaveEnabled] = useState(true);

  useEffect(() => {
    let active = true;

    void (async () => {
      if (hasExtensionStorage) {
        const result = await chromeApi.storage.local.get([QUICK_SAVE_ENABLED_KEY]);
        if (!active) return;
        const value = result?.[QUICK_SAVE_ENABLED_KEY];
        setQuickSaveEnabled(value === undefined ? true : Boolean(value));
        return;
      }

      const raw = localStorage.getItem(QUICK_SAVE_ENABLED_KEY);
      if (!active) return;
      setQuickSaveEnabled(raw === null ? true : raw === "true");
    })();

    return () => {
      active = false;
    };
  }, []);

  async function updateQuickSaveEnabled(next: boolean) {
    setQuickSaveEnabled(next);
    if (hasExtensionStorage) {
      await chromeApi.storage.local.set({ [QUICK_SAVE_ENABLED_KEY]: next });
      return;
    }
    localStorage.setItem(QUICK_SAVE_ENABLED_KEY, String(next));
  }

  return { quickSaveEnabled, updateQuickSaveEnabled };
}

function useLegacyJsonExportSetting() {
  const [legacyJsonExportEnabled, setLegacyJsonExportEnabled] = useState(false);

  useEffect(() => {
    let active = true;

    void (async () => {
      if (hasExtensionStorage) {
        const result = await chromeApi.storage.local.get([LEGACY_JSON_EXPORT_ENABLED_KEY]);
        if (!active) return;
        setLegacyJsonExportEnabled(Boolean(result?.[LEGACY_JSON_EXPORT_ENABLED_KEY]));
        return;
      }

      const raw = localStorage.getItem(LEGACY_JSON_EXPORT_ENABLED_KEY);
      if (!active) return;
      setLegacyJsonExportEnabled(raw === "true");
    })();

    return () => {
      active = false;
    };
  }, []);

  async function updateLegacyJsonExportEnabled(next: boolean) {
    setLegacyJsonExportEnabled(next);
    if (hasExtensionStorage) {
      await chromeApi.storage.local.set({ [LEGACY_JSON_EXPORT_ENABLED_KEY]: next });
      return;
    }
    localStorage.setItem(LEGACY_JSON_EXPORT_ENABLED_KEY, String(next));
  }

  return { legacyJsonExportEnabled, updateLegacyJsonExportEnabled };
}

function ensureCategoryIdForName(
  categories: Category[],
  categoryIdByName: Map<string, string>,
  categoryName: string,
  now: string
) {
  const trimmed = categoryName.trim() || DEFAULT_UNCATEGORIZED_LABEL;
  if (trimmed === DEFAULT_UNCATEGORIZED_LABEL) return UNCATEGORIZED_ID;
  const lookupKey = trimmed.toLowerCase();
  const existingId = categoryIdByName.get(lookupKey);
  if (existingId) return existingId;
  const categoryId = uuid();
  categories.push({ id: categoryId, name: trimmed, createdAt: now });
  categoryIdByName.set(lookupKey, categoryId);
  return categoryId;
}

function promptSyncStatus(prompt: Prompt, sync: FolderSyncState): PromptSyncStatus {
  const sourcePath = normalizeSourcePath(prompt.sourcePath);
  if (!sourcePath) return "local_only";
  const record = sync.records[sourcePath];
  if (record?.conflict) return "conflict";
  if (record?.missing) return "missing_file";
  if (record?.lastSyncedHash && record.lastSyncedHash === textHash(prompt.content)) return "synced";
  return "local_only";
}

function syncLabel(status: PromptSyncStatus, isPl: boolean) {
  if (status === "conflict") return isPl ? "Konflikt" : "Conflict";
  if (status === "missing_file") return isPl ? "Brak pliku" : "Missing file";
  if (status === "synced") return isPl ? "Zsynchronizowany" : "Synced";
  return isPl ? "Tylko w rozszerzeniu" : "Local only";
}

function extensionOnlyFilterLabel(isPl: boolean) {
  return isPl ? "Tylko prompty zapisane w rozszerzeniu" : "Only prompts stored in extension";
}

function confirmPromptDeletion(title: string, isPl: boolean) {
  const message = isPl
    ? `Na pewno usunąć prompt "${title}"?`
    : `Delete prompt "${title}"?`;
  return window.confirm(message);
}

function generatePromptSourcePath(db: DbFile, prompt: Pick<Prompt, "id" | "title" | "tags" | "categoryId">) {
  const categoryName = db.categories.find((category) => category.id === prompt.categoryId)?.name ?? DEFAULT_UNCATEGORIZED_LABEL;
  const basePath = folderPromptPath(prompt, categoryName);
  const existingPaths = new Set(
    db.prompts
      .filter((item) => item.id !== prompt.id)
      .map((item) => normalizeSourcePath(item.sourcePath))
      .filter((path): path is string => Boolean(path))
  );

  if (!existingPaths.has(basePath)) return basePath;

  const fileName = basePath.split("/").pop() ?? "prompt.md";
  const fileBase = stripMarkdownExtension(fileName);
  const parent = basePath.includes("/") ? `${basePath.slice(0, basePath.lastIndexOf("/"))}/` : "";

  let suffix = 2;
  while (existingPaths.has(`${parent}${fileBase}-${suffix}.md`)) {
    suffix += 1;
  }
  return `${parent}${fileBase}-${suffix}.md`;
}

function applyFolderCandidatesToDb(
  current: DbFile,
  sync: FolderSyncState,
  candidates: MdImportCandidate[]
) {
  const categories = [...current.categories];
  const categoryIdByName = new Map(
    categories.map((category) => [category.name.trim().toLowerCase(), category.id] as const)
  );
  const prompts = [...current.prompts];
  const promptIndexBySourcePath = new Map<string, number>();
  const now = nowIso();
  const nextRecords = { ...sync.records };
  const seenPaths = new Set<string>();

  for (let index = 0; index < prompts.length; index += 1) {
    const sourcePath = normalizeSourcePath(prompts[index].sourcePath);
    if (sourcePath) promptIndexBySourcePath.set(sourcePath, index);
  }

  for (const candidate of candidates) {
    const sourcePath = normalizeSourcePath(candidate.sourcePath);
    if (!sourcePath) continue;
    seenPaths.add(sourcePath);
    const fileHash = textHash(candidate.content);
    const existingIndex = promptIndexBySourcePath.get(sourcePath);

    if (existingIndex === undefined) {
      const categoryId = ensureCategoryIdForName(categories, categoryIdByName, candidate.categoryName, now);
      prompts.push({
        id: uuid(),
        title: candidate.title.trim() || "Nowy prompt",
        categoryId,
        content: candidate.content.trim(),
        tags: uniqueSortedTags(candidate.tags),
        sourcePath,
        favorite: false,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null
      });
      promptIndexBySourcePath.set(sourcePath, prompts.length - 1);
      nextRecords[sourcePath] = {
        sourcePath,
        lastSyncedHash: fileHash,
        lastSyncedAt: now,
        missing: false,
        conflict: false,
        fileHash
      };
      continue;
    }

    const existingPrompt = prompts[existingIndex];
    const promptHash = textHash(existingPrompt.content);
    const record = nextRecords[sourcePath];
    const hasConflict = record
      ? fileHash !== record.lastSyncedHash && promptHash !== record.lastSyncedHash
      : fileHash !== promptHash;

    if (hasConflict) {
      nextRecords[sourcePath] = {
        sourcePath,
        lastSyncedHash: record?.lastSyncedHash ?? promptHash,
        lastSyncedAt: record?.lastSyncedAt ?? existingPrompt.updatedAt,
        missing: false,
        conflict: true,
        fileHash
      };
      continue;
    }

    if (fileHash !== promptHash || record?.missing || record?.conflict) {
      const categoryId = ensureCategoryIdForName(categories, categoryIdByName, candidate.categoryName, now);
      prompts[existingIndex] = {
        ...existingPrompt,
        title: candidate.title.trim() || existingPrompt.title,
        categoryId,
        content: candidate.content.trim(),
        tags: uniqueSortedTags(candidate.tags),
        sourcePath,
        updatedAt: now
      };
    }

    nextRecords[sourcePath] = {
      sourcePath,
      lastSyncedHash: fileHash,
      lastSyncedAt: now,
      missing: false,
      conflict: false,
      fileHash
    };
  }

  for (const prompt of prompts) {
    const sourcePath = normalizeSourcePath(prompt.sourcePath);
    if (!sourcePath || seenPaths.has(sourcePath)) continue;
    const currentRecord = nextRecords[sourcePath];
    nextRecords[sourcePath] = {
      sourcePath,
      lastSyncedHash: currentRecord?.lastSyncedHash ?? textHash(prompt.content),
      lastSyncedAt: currentRecord?.lastSyncedAt ?? prompt.updatedAt,
      missing: true,
      conflict: false,
      fileHash: null
    };
  }

  return {
    db: normalizeDb({
      ...current,
      categories,
      prompts
    }),
    sync: normalizeFolderSyncState({
      ...sync,
      lastScannedAt: now,
      records: nextRecords
    })
  };
}

function useLibrary(language: Language): LibraryApi {
  const [loading, setLoading] = useState(true);
  const [db, setDb] = useState<DbFile>(() => defaultDb());
  const [sync, setSync] = useState<FolderSyncState>(() => defaultFolderSyncState());
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dbRef = useRef(db);
  const syncRef = useRef(sync);
  const folderHandleRef = useRef<any | null>(null);

  useEffect(() => {
    dbRef.current = db;
  }, [db]);

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    let active = true;

    void (async () => {
      const [loadedDb, loadedSync, handle] = await Promise.all([
        loadDb(),
        loadFolderSyncState(),
        loadPromptFolderHandle()
      ]);
      if (!active) return;
      folderHandleRef.current = handle;
      setDb(loadedDb);
      setSync(handle ? loadedSync : defaultFolderSyncState());
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function commit(mutator: (prev: DbFile) => DbFile, toastMessage?: string) {
    setError(null);
    const next = normalizeDb(mutator(dbRef.current));
    dbRef.current = next;
    setDb(next);
    void writeStoredDbRaw(JSON.stringify(next));
    if (toastMessage) setToast(toastMessage);
    return next;
  }

  function commitSync(mutator: (prev: FolderSyncState) => FolderSyncState) {
    const next = normalizeFolderSyncState(mutator(syncRef.current));
    syncRef.current = next;
    setSync(next);
    void writeStoredFolderSyncRaw(JSON.stringify(next));
    return next;
  }

  function withValidation(action: () => void) {
    try {
      action();
    } catch (e) {
      const message = e instanceof Error ? e.message : txt(language, "Operacja nie powiodła się", "Operation failed");
      setError(message);
    }
  }

  function mergeMarkdownCandidates(current: DbFile, candidates: MdImportCandidate[]): DbFile {
    const categories = [...current.categories];
    const categoryIdByName = new Map(
      categories.map((category) => [category.name.trim().toLowerCase(), category.id] as const)
    );
    const prompts = [...current.prompts];
    const now = nowIso();
    const promptIndexBySourcePath = new Map<string, number>();

    for (let index = 0; index < prompts.length; index += 1) {
      const sourcePath = normalizeSourcePath(prompts[index].sourcePath);
      if (sourcePath) promptIndexBySourcePath.set(sourcePath, index);
    }

    for (const candidate of candidates) {
      const sourcePath = normalizeSourcePath(candidate.sourcePath);
      if (!sourcePath) continue;
      const categoryId = ensureCategoryIdForName(categories, categoryIdByName, candidate.categoryName, now);
      const tags = uniqueSortedTags(candidate.tags);
      const existingIndex = promptIndexBySourcePath.get(sourcePath);

      if (existingIndex !== undefined) {
        const existing = prompts[existingIndex];
        prompts[existingIndex] = {
          ...existing,
          title: candidate.title.trim() || existing.title,
          categoryId,
          content: candidate.content.trim(),
          tags,
          sourcePath,
          updatedAt: now
        };
        continue;
      }

      prompts.push({
        id: uuid(),
        title: candidate.title.trim() || "Nowy prompt",
        categoryId,
        content: candidate.content.trim(),
        tags,
        sourcePath,
        favorite: false,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null
      });
      promptIndexBySourcePath.set(sourcePath, prompts.length - 1);
    }

    return {
      ...current,
      categories,
      prompts
    };
  }

  async function writePromptToConnectedFolder(promptId: string) {
    const rootHandle = folderHandleRef.current;
    if (!rootHandle || !syncRef.current.connected) return;
    if (!await ensureHandlePermission(rootHandle, "readwrite")) {
      throw new Error(txt(language, "Brak dostępu do zapisu w katalogu promptów", "Write access to the prompts folder was not granted"));
    }

    const prompt = dbRef.current.prompts.find((item) => item.id === promptId);
    if (!prompt) return;
    const sourcePath = normalizeSourcePath(prompt.sourcePath);
    if (!sourcePath) return;

    await writePromptMarkdownToDirectory(rootHandle, sourcePath, prompt.content);
    const fileHash = textHash(prompt.content);
    commitSync((prev) => ({
      ...prev,
      connected: true,
      folderName: rootHandle.name ?? prev.folderName,
      records: {
        ...prev.records,
        [sourcePath]: {
          sourcePath,
          lastSyncedHash: fileHash,
          lastSyncedAt: nowIso(),
          missing: false,
          conflict: false,
          fileHash
        }
      }
    }));
  }

  async function deletePromptFromConnectedFolder(sourcePath: string | null) {
    const rootHandle = folderHandleRef.current;
    const normalizedPath = normalizeSourcePath(sourcePath);
    if (!rootHandle || !syncRef.current.connected || !normalizedPath) return;
    if (!await ensureHandlePermission(rootHandle, "readwrite")) return;
    try {
      await deleteFileFromDirectory(rootHandle, normalizedPath);
    } catch {
      return;
    }
    commitSync((prev) => {
      const nextRecords = { ...prev.records };
      delete nextRecords[normalizedPath];
      return { ...prev, records: nextRecords };
    });
  }

  async function rescanPromptFolder() {
    const rootHandle = folderHandleRef.current;
    if (!rootHandle) {
      setError(txt(language, "Nie podłączono katalogu promptów", "No prompts folder is connected"));
      return;
    }

    setSyncBusy(true);
    setError(null);
    try {
      if (!await ensureHandlePermission(rootHandle, "read")) {
        throw new Error(txt(language, "Brak dostępu do odczytu katalogu promptów", "Read access to the prompts folder was not granted"));
      }

      const candidates = await collectMarkdownCandidatesFromDirectoryHandle(rootHandle);
      const result = applyFolderCandidatesToDb(
        dbRef.current,
        {
          ...syncRef.current,
          connected: true,
          folderName: rootHandle.name ?? syncRef.current.folderName
        },
        candidates
      );

      dbRef.current = result.db;
      setDb(result.db);
      void writeStoredDbRaw(JSON.stringify(result.db));
      syncRef.current = result.sync;
      setSync(result.sync);
      void writeStoredFolderSyncRaw(JSON.stringify(result.sync));
      setToast(txt(language, "Zsynchronizowano katalog promptów", "Prompts folder synced"));
    } catch (e) {
      setError(e instanceof Error ? e.message : txt(language, "Synchronizacja katalogu nie powiodła się", "Folder sync failed"));
    } finally {
      setSyncBusy(false);
    }
  }

  return {
    loading,
    db,
    sync,
    syncBusy,
    error,
    toast,
    clearError: () => setError(null),
    createPrompt: createDraft,
    upsertPrompt: (draft) => {
      if (!draft.title.trim()) throw new Error(txt(language, "Pole title jest wymagane", "Title is required"));
      if (!draft.categoryId.trim()) throw new Error(txt(language, "Pole categoryId jest wymagane", "Category is required"));
      if (!draft.content.trim()) throw new Error(txt(language, "Pole content jest wymagane", "Content is required"));

      const promptId = draft.id || uuid();
      withValidation(() => {
        const nextDb = commit((prev) => {
          const now = nowIso();
          const categoryId = prev.categories.some((c) => c.id === draft.categoryId)
            ? draft.categoryId
            : UNCATEGORIZED_ID;
          const tags = uniqueSortedTags(draft.tags);
          const existing = prev.prompts.find((p) => p.id === promptId);

          if (existing) {
            return {
              ...prev,
              prompts: prev.prompts.map((p) =>
                p.id === promptId
                  ? {
                      ...p,
                      title: draft.title.trim(),
                      categoryId,
                      content: draft.content.trim(),
                      tags,
                      favorite: draft.favorite,
                      sourcePath: existing.sourcePath ?? (syncRef.current.connected
                        ? generatePromptSourcePath(prev, { id: promptId, title: draft.title.trim(), tags, categoryId })
                        : null),
                      updatedAt: now
                    }
                  : p
              )
            };
          }

          return {
            ...prev,
            prompts: [
              ...prev.prompts,
              {
                id: promptId,
                title: draft.title.trim(),
                categoryId,
                content: draft.content.trim(),
                tags,
                sourcePath: syncRef.current.connected
                  ? generatePromptSourcePath(prev, { id: promptId, title: draft.title.trim(), tags, categoryId })
                  : null,
                favorite: draft.favorite,
                createdAt: now,
                updatedAt: now,
                lastUsedAt: null
              }
            ]
          };
        }, txt(language, "Zapisano", "Saved"));

        if (syncRef.current.connected && nextDb.prompts.some((prompt) => prompt.id === promptId)) {
          void writePromptToConnectedFolder(promptId).catch((e) => {
            setError(e instanceof Error ? e.message : txt(language, "Nie udało się zapisać promptu do katalogu", "Could not save prompt to folder"));
          });
        }
      });

      return promptId;
    },
    togglePromptFavorite: (id) => {
      withValidation(() => {
        commit((prev) => {
          const existing = prev.prompts.find((p) => p.id === id);
          if (!existing) throw new Error(txt(language, "Prompt nie istnieje", "Prompt does not exist"));
          const now = nowIso();
          return {
            ...prev,
            prompts: prev.prompts.map((p) =>
              p.id === id ? { ...p, favorite: !p.favorite, updatedAt: now } : p
            )
          };
        }, txt(language, "Zaktualizowano ulubione", "Favorite updated"));
      });
    },
    deletePrompt: (id) => {
      withValidation(() => {
        const sourcePath = dbRef.current.prompts.find((p) => p.id === id)?.sourcePath ?? null;
        commit(
          (prev) => ({
            ...prev,
            prompts: prev.prompts.filter((p) => p.id !== id)
          }),
          txt(language, "Usunięto prompt", "Prompt deleted")
        );
        void deletePromptFromConnectedFolder(sourcePath);
      });
    },
    duplicatePrompt: (id) => {
      const copyId = uuid();
      withValidation(() => {
        commit((prev) => {
          const original = prev.prompts.find((p) => p.id === id);
          if (!original) throw new Error(txt(language, "Prompt nie istnieje", "Prompt does not exist"));
          const now = nowIso();
          return {
            ...prev,
            prompts: [
              ...prev.prompts,
              {
                ...original,
                id: copyId,
                title: `${original.title} ${txt(language, "(kopia)", "(copy)")}`,
                sourcePath: null,
                createdAt: now,
                updatedAt: now,
                lastUsedAt: null
              }
            ]
          };
        }, txt(language, "Zduplikowano", "Duplicated"));
      });
      return copyId;
    },
    copyPrompt: async (id) => {
      const prompt = dbRef.current.prompts.find((p) => p.id === id);
      if (!prompt) {
        setError(txt(language, "Prompt nie istnieje", "Prompt does not exist"));
        return;
      }
      try {
        await navigator.clipboard.writeText(prompt.content);
      } catch {
        setError(txt(language, "Nie udało się skopiować do schowka", "Could not copy to clipboard"));
        return;
      }

      commit(
        (prev) => {
          const now = nowIso();
          return {
            ...prev,
            prompts: prev.prompts.map((p) =>
              p.id === id ? { ...p, lastUsedAt: now, updatedAt: now } : p
            )
          };
        },
        txt(language, "Skopiowano", "Copied")
      );
    },
    createCategory: (name) => {
      withValidation(() => {
        const trimmed = name.trim();
        if (!trimmed) throw new Error(txt(language, "Nazwa kategorii jest wymagana", "Category name is required"));
        commit((prev) => {
          if (prev.categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
            throw new Error(txt(language, "Kategoria o tej nazwie już istnieje", "Category with this name already exists"));
          }
          return {
            ...prev,
            categories: [...prev.categories, { id: uuid(), name: trimmed, createdAt: nowIso() }]
          };
        }, txt(language, "Dodano kategorię", "Category added"));
      });
    },
    renameCategory: (id, name) => {
      withValidation(() => {
        const trimmed = name.trim();
        if (!trimmed) throw new Error(txt(language, "Nazwa kategorii jest wymagana", "Category name is required"));
        if (id === UNCATEGORIZED_ID) {
          throw new Error(txt(language, "Nie można zmienić nazwy kategorii Bez kategorii", "Cannot rename the default uncategorized category"));
        }
        commit((prev) => {
          if (prev.categories.some((c) => c.id !== id && c.name.toLowerCase() === trimmed.toLowerCase())) {
            throw new Error(txt(language, "Kategoria o tej nazwie już istnieje", "Category with this name already exists"));
          }
          if (!prev.categories.some((c) => c.id === id)) {
            throw new Error(txt(language, "Kategoria nie istnieje", "Category does not exist"));
          }
          return {
            ...prev,
            categories: prev.categories.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
          };
        }, txt(language, "Zmieniono nazwę kategorii", "Category renamed"));
      });
    },
    deleteCategory: (id) => {
      withValidation(() => {
        if (id === UNCATEGORIZED_ID) {
          throw new Error(txt(language, "Nie można usunąć kategorii Bez kategorii", "Cannot delete the default uncategorized category"));
        }
        commit((prev) => {
          if (!prev.categories.some((c) => c.id === id)) {
            throw new Error(txt(language, "Kategoria nie istnieje", "Category does not exist"));
          }
          return {
            ...prev,
            categories: prev.categories.filter((c) => c.id !== id),
            prompts: prev.prompts.map((p) =>
              p.categoryId === id ? { ...p, categoryId: UNCATEGORIZED_ID, updatedAt: nowIso() } : p
            )
          };
        }, txt(language, "Usunięto kategorię", "Category deleted"));
      });
    },
    deleteCategories: (ids) => {
      withValidation(() => {
        const uniqueIds = Array.from(new Set(ids)).filter((id) => id !== UNCATEGORIZED_ID);
        if (uniqueIds.length === 0) {
          throw new Error(txt(language, "Nie wybrano kategorii do usunięcia", "No categories selected for deletion"));
        }
        commit((prev) => {
          const existingIds = new Set(prev.categories.map((c) => c.id));
          const missingId = uniqueIds.find((id) => !existingIds.has(id));
          if (missingId) {
            throw new Error(txt(language, "Kategoria nie istnieje", "Category does not exist"));
          }
          const idsToDelete = new Set(uniqueIds);
          const now = nowIso();
          return {
            ...prev,
            categories: prev.categories.filter((c) => !idsToDelete.has(c.id)),
            prompts: prev.prompts.map((p) =>
              idsToDelete.has(p.categoryId) ? { ...p, categoryId: UNCATEGORIZED_ID, updatedAt: now } : p
            )
          };
        }, txt(language, "Usunięto zaznaczone kategorie", "Selected categories deleted"));
      });
    },
    movePromptsToCategory: (sourceIds, targetId) => {
      withValidation(() => {
        const uniqueSourceIds = Array.from(new Set(sourceIds)).filter(Boolean);
        if (uniqueSourceIds.length === 0) {
          throw new Error(txt(language, "Nie wybrano kategorii źródłowych", "No source categories selected"));
        }
        commit((prev) => {
          const existingIds = new Set(prev.categories.map((c) => c.id));
          if (!existingIds.has(targetId)) {
            throw new Error(txt(language, "Kategoria docelowa nie istnieje", "Target category does not exist"));
          }
          if (uniqueSourceIds.includes(targetId)) {
            throw new Error(txt(language, "Kategoria docelowa nie może być jedną z zaznaczonych", "Target category cannot be selected"));
          }
          const missingId = uniqueSourceIds.find((id) => !existingIds.has(id));
          if (missingId) {
            throw new Error(txt(language, "Kategoria nie istnieje", "Category does not exist"));
          }
          const sourceSet = new Set(uniqueSourceIds);
          const now = nowIso();
          return {
            ...prev,
            prompts: prev.prompts.map((p) =>
              sourceSet.has(p.categoryId) ? { ...p, categoryId: targetId, updatedAt: now } : p
            )
          };
        }, txt(language, "Przeniesiono prompty do wybranej kategorii", "Prompts moved to selected category"));
      });
    },
    mergeCategories: (sourceIds, targetId) => {
      withValidation(() => {
        const uniqueSourceIds = Array.from(new Set(sourceIds)).filter((id) => id && id !== UNCATEGORIZED_ID);
        if (uniqueSourceIds.length === 0) {
          throw new Error(txt(language, "Nie wybrano kategorii do scalenia", "No categories selected to merge"));
        }
        commit((prev) => {
          const existingIds = new Set(prev.categories.map((c) => c.id));
          if (!existingIds.has(targetId)) {
            throw new Error(txt(language, "Kategoria docelowa nie istnieje", "Target category does not exist"));
          }
          if (uniqueSourceIds.includes(targetId)) {
            throw new Error(txt(language, "Kategoria docelowa nie może być jedną z zaznaczonych", "Target category cannot be selected"));
          }
          const missingId = uniqueSourceIds.find((id) => !existingIds.has(id));
          if (missingId) {
            throw new Error(txt(language, "Kategoria nie istnieje", "Category does not exist"));
          }
          const sourceSet = new Set(uniqueSourceIds);
          const now = nowIso();
          return {
            ...prev,
            categories: prev.categories.filter((c) => !sourceSet.has(c.id)),
            prompts: prev.prompts.map((p) =>
              sourceSet.has(p.categoryId) ? { ...p, categoryId: targetId, updatedAt: now } : p
            )
          };
        }, txt(language, "Scalono kategorie", "Categories merged"));
      });
    },
    exportJson: () => JSON.stringify(dbRef.current, null, 2),
    importJson: (raw) => {
      withValidation(() => {
        const parsed = JSON.parse(raw) as DbFile;
        const normalizedImported = normalizeDb(parsed);
        commit((prev) => mergeImported(prev, normalizedImported), txt(language, "Zaimportowano dane", "Imported data"));
      });
    },
    importMarkdownPrompts: (candidates) => {
      withValidation(() => {
        if (candidates.length === 0) {
          throw new Error(txt(language, "Nie znaleziono plików Markdown", "No Markdown files found"));
        }
        commit(
          (prev) => mergeMarkdownCandidates(prev, candidates),
          txt(language, "Zaimportowano pliki Markdown", "Imported Markdown files")
        );
      });
    },
    connectPromptFolder: async () => {
      setError(null);
      try {
        const picker = (window as Window & { showDirectoryPicker?: () => Promise<any> }).showDirectoryPicker;
        if (!picker) {
          throw new Error(txt(language, "Ta przeglądarka nie wspiera wyboru katalogu", "This browser does not support folder picking"));
        }
        const handle = await picker();
        if (!await ensureHandlePermission(handle, "readwrite")) {
          throw new Error(txt(language, "Nie przyznano dostępu do katalogu", "Folder access was not granted"));
        }
        await savePromptFolderHandle(handle);
        folderHandleRef.current = handle;
        commitSync(() => ({
          connected: true,
          folderName: handle.name ?? null,
          lastScannedAt: null,
          records: {}
        }));
        await rescanPromptFolder();
      } catch (e) {
        setError(e instanceof Error ? e.message : txt(language, "Nie udało się podłączyć katalogu", "Could not connect the folder"));
      }
    },
    disconnectPromptFolder: async () => {
      await clearPromptFolderHandle();
      folderHandleRef.current = null;
      commitSync((prev) => ({
        ...prev,
        connected: false,
        folderName: null,
        lastScannedAt: null
      }));
      setToast(txt(language, "Odłączono katalog promptów", "Prompts folder disconnected"));
    },
    rescanPromptFolder,
    overwritePromptToFolder: async (id) => {
      try {
        await writePromptToConnectedFolder(id);
        setToast(txt(language, "Nadpisano plik promptu", "Prompt file overwritten"));
      } catch (e) {
        setError(e instanceof Error ? e.message : txt(language, "Nie udało się nadpisać pliku", "Could not overwrite the file"));
      }
    },
    importPromptFromFolder: async (id) => {
      const rootHandle = folderHandleRef.current;
      const prompt = dbRef.current.prompts.find((item) => item.id === id);
      const sourcePath = normalizeSourcePath(prompt?.sourcePath);
      if (!rootHandle || !sourcePath || !prompt) {
        setError(txt(language, "Nie można wczytać pliku dla tego promptu", "Cannot import the file for this prompt"));
        return;
      }
      try {
        if (!await ensureHandlePermission(rootHandle, "read")) {
          throw new Error(txt(language, "Brak dostępu do odczytu katalogu promptów", "Read access to the prompts folder was not granted"));
        }
        const content = await readFileContentFromDirectory(rootHandle, sourcePath);
        if (content === null) {
          throw new Error(txt(language, "Plik promptu nie istnieje", "Prompt file does not exist"));
        }
        const candidate = markdownCandidateFromRelativePath(sourcePath, content);
        if (!candidate) {
          throw new Error(txt(language, "Nie udało się odczytać pliku promptu", "Could not parse the prompt file"));
        }
        const result = applyFolderCandidatesToDb(dbRef.current, syncRef.current, [candidate]);
        dbRef.current = result.db;
        setDb(result.db);
        void writeStoredDbRaw(JSON.stringify(result.db));
        syncRef.current = result.sync;
        setSync(result.sync);
        void writeStoredFolderSyncRaw(JSON.stringify(result.sync));
        setToast(txt(language, "Wczytano zmiany z pliku", "Imported changes from file"));
      } catch (e) {
        setError(e instanceof Error ? e.message : txt(language, "Nie udało się wczytać pliku", "Could not import the file"));
      }
    },
    disconnectPromptFromFolder: (id) => {
      withValidation(() => {
        const sourcePath = normalizeSourcePath(dbRef.current.prompts.find((prompt) => prompt.id === id)?.sourcePath);
        commit((prev) => ({
          ...prev,
          prompts: prev.prompts.map((prompt) =>
            prompt.id === id ? { ...prompt, sourcePath: null, updatedAt: nowIso() } : prompt
          )
        }), txt(language, "Odłączono prompt od pliku", "Prompt disconnected from file"));
        if (sourcePath) {
          commitSync((prev) => {
            const nextRecords = { ...prev.records };
            delete nextRecords[sourcePath];
            return { ...prev, records: nextRecords };
          });
        }
      });
    },
    getPromptSyncStatus: (prompt) => promptSyncStatus(prompt, syncRef.current)
  };
}

function pageTitle(page: AppPage, language: Language) {
  if (page === "dashboard") return language === "pl" ? "Dashboard" : "Dashboard";
  if (page === "prompts") return language === "pl" ? "Biblioteka promptów" : "Prompt library";
  if (page === "create") return language === "pl" ? "Nowy prompt" : "New prompt";
  if (page === "categories") return language === "pl" ? "Kategorie" : "Categories";
  if (page === "data") return language === "pl" ? "Dane i kopie" : "Data and backups";
  if (page === "settings") return language === "pl" ? "Ustawienia" : "Settings";
  return "Prompter";
}

function NavButton({
  page,
  current,
  onClick,
  children
}: {
  page: AppPage;
  current: AppPage;
  onClick: (page: AppPage) => void;
  children: string;
}) {
  return (
    <button className={current === page ? "nav-active" : "nav-default"} onClick={() => onClick(page)}>
      {children}
    </button>
  );
}

function DashboardPage({
  db,
  navigate,
  language
}: {
  db: DbFile;
  navigate: (page: AppPage, params?: Record<string, string>) => void;
  language: Language;
}) {
  const isPl = language === "pl";
  const recent = [...db.prompts]
    .sort((a, b) => {
      if (a.lastUsedAt && b.lastUsedAt) {
        return new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime();
      }
      if (a.lastUsedAt) return -1;
      if (b.lastUsedAt) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, 5);

  const topTags = Array.from(
    db.prompts
      .flatMap((p) => p.tags)
      .reduce((acc, tag) => {
        acc.set(tag, (acc.get(tag) || 0) + 1);
        return acc;
      }, new Map<string, number>())
      .entries()
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  return (
    <div className="dashboard-grid">
      <article className="metric-card"><h3>{isPl ? "Łącznie promptów" : "Total prompts"}</h3><strong>{db.prompts.length}</strong></article>
      <article className="metric-card"><h3>{isPl ? "Ulubione" : "Favorites"}</h3><strong>{db.prompts.filter((p) => p.favorite).length}</strong></article>
      <article className="metric-card"><h3>{isPl ? "Kategorie" : "Categories"}</h3><strong>{db.categories.length}</strong></article>
      <article className="metric-card"><h3>{isPl ? "Aktywne tagi" : "Active tags"}</h3><strong>{new Set(db.prompts.flatMap((p) => p.tags)).size}</strong></article>

      <section className="surface recent-panel">
        <div className="section-title-row">
          <h2>{isPl ? "Ostatnio używane" : "Recently used"}</h2>
          <button className="ghost" onClick={() => navigate("prompts")}>{isPl ? "Zobacz wszystkie" : "View all"}</button>
        </div>
        {recent.length === 0 ? <p>{isPl ? "Brak używanych promptów." : "No recently used prompts."}</p> : recent.map((prompt) => (
          <button key={prompt.id} className="list-item" onClick={() => navigate("prompts", { prompt: prompt.id })}>
            <span>{prompt.title}</span>
            <small>{prompt.lastUsedAt ? new Date(prompt.lastUsedAt).toLocaleString() : (isPl ? "nigdy" : "never")}</small>
          </button>
        ))}
      </section>

      <section className="surface tags-panel">
        <h2>{isPl ? "Najczęstsze tagi" : "Top tags"}</h2>
        <div className="tag-cloud">
          {topTags.map(([tag, count]) => (
            <button key={tag} className="tag-pill" onClick={() => navigate("prompts", { tag })}>
              {tag} <small>({count})</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function PromptsPage({
  lib,
  params,
  clearParams,
  navigate,
  language
}: {
  lib: LibraryApi;
  params: URLSearchParams;
  clearParams: () => void;
  navigate: (page: AppPage, params?: Record<string, string>) => void;
  language: Language;
}) {
  const isPl = language === "pl";
  const locale = isPl ? "pl" : "en";
  const searchRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [extensionOnly, setExtensionOnly] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);

  const prompts = lib.db.prompts;
  const categories = lib.db.categories;
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  useEffect(() => {
    const promptId = params.get("prompt");
    const tagParam = params.get("tag");
    const focusSearch = params.get("focus") === "search";

    if (promptId && prompts.some((p) => p.id === promptId)) {
      setSelectedPromptId(promptId);
    }
    if (tagParam) {
      setSelectedTags((prev) => (prev.includes(tagParam) ? prev : [...prev, tagParam]));
    }
    if (focusSearch) {
      searchRef.current?.focus();
    }

    if (promptId || tagParam || focusSearch) {
      clearParams();
    }
  }, [clearParams, params, prompts]);

  useEffect(() => {
    if (selectedPromptId && !prompts.some((p) => p.id === selectedPromptId)) {
      setSelectedPromptId(null);
    }
  }, [prompts, selectedPromptId]);

  const tagsUniverse = useMemo(() => {
    const unique = new Set<string>();
    for (const prompt of prompts) {
      for (const tag of prompt.tags) unique.add(tag);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b, locale, { sensitivity: "base" }));
  }, [locale, prompts]);

  const visibleTags = useMemo(() => {
    const query = tagSearch.trim().toLowerCase();
    if (!query) return tagsUniverse;
    return tagsUniverse.filter((tag) => tag.toLowerCase().includes(query));
  }, [tagSearch, tagsUniverse]);

  const filteredPrompts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = prompts.filter((prompt) => {
      const inSearch = !q || prompt.title.toLowerCase().includes(q) || prompt.content.toLowerCase().includes(q);
      const inCategory = selectedCategory === "all" || prompt.categoryId === selectedCategory;
      const inFavorite = !favoriteOnly || prompt.favorite;
      const inExtension = !extensionOnly || lib.getPromptSyncStatus(prompt) === "local_only";
      const inTags = selectedTags.every((tag) => prompt.tags.includes(tag));
      return inSearch && inCategory && inFavorite && inExtension && inTags;
    });

    const sorted = [...list];
    if (sortMode === "newest") sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (sortMode === "az") sorted.sort((a, b) => a.title.localeCompare(b.title, locale, { sensitivity: "base" }));
    if (sortMode === "lastUsed") {
      sorted.sort((a, b) => {
        if (a.lastUsedAt && b.lastUsedAt) return new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime();
        if (a.lastUsedAt) return -1;
        if (b.lastUsedAt) return 1;
        return 0;
      });
    }

    return sorted;
  }, [extensionOnly, favoriteOnly, lib, locale, prompts, search, selectedCategory, selectedTags, sortMode]);

  const selectedPrompt = useMemo(
    () => prompts.find((prompt) => prompt.id === selectedPromptId) ?? null,
    [prompts, selectedPromptId]
  );

  return (
    <div className="library-page">
      <section className="library-hero">
        <div>
          <h2>{isPl ? "Biblioteka promptów" : "Prompts Library"}</h2>
          <p>{isPl ? "Przeglądaj i wyszukuj swoje szablony promptów" : "Browse and search through your prompt templates"}</p>
        </div>
        <div className="library-controls">
          <label>
            {isPl ? "Kolekcja" : "Collection"}
            <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)}>
              <option value="all">{isPl ? "Wszystkie kolekcje" : "All collections"}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.id === UNCATEGORIZED_ID ? (isPl ? "Bez kategorii" : "Uncategorized") : category.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {isPl ? "Sortowanie" : "Sort"}
            <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
              <option value="newest">{isPl ? "Najnowsze" : "Newest"}</option>
              <option value="lastUsed">{isPl ? "Ostatnio używane" : "Last used"}</option>
              <option value="az">A-Z</option>
            </select>
          </label>
        </div>
        <div className="library-filter-toggles" aria-label={isPl ? "Dodatkowe filtry" : "Additional filters"}>
          <button
            type="button"
            className={favoriteOnly ? "ghost compact-filter active-filter active-filter-favorite" : "ghost compact-filter"}
            aria-pressed={favoriteOnly}
            onClick={() => setFavoriteOnly((v) => !v)}
          >
            <span className="compact-filter-icon" aria-hidden="true">★</span>
            <span>{isPl ? "Tylko ulubione" : "Favorites only"}</span>
          </button>
          <button
            type="button"
            className={extensionOnly ? "ghost compact-filter active-filter active-filter-local" : "ghost compact-filter"}
            aria-pressed={extensionOnly}
            onClick={() => setExtensionOnly((v) => !v)}
          >
            <span className="compact-filter-icon" aria-hidden="true">⌂</span>
            <span>{extensionOnlyFilterLabel(isPl)}</span>
          </button>
        </div>
      </section>

      <section className="library-toolbar">
        <input
          ref={searchRef}
          className="library-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isPl ? "Szukaj promptów..." : "Search prompts..."}
        />
        <input
          className="tag-search"
          value={tagSearch}
          onChange={(e) => setTagSearch(e.target.value)}
          placeholder={isPl ? "Szukaj tagów..." : "Search tags..."}
        />
        <div className="library-tags">
          {visibleTags.map((tag) => (
            <button
              key={tag}
              className={selectedTags.includes(tag) ? "tag-pill active" : "tag-pill"}
              onClick={() =>
                setSelectedTags((prev) =>
                  prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                )
              }
            >
              {tag}
            </button>
          ))}
          {visibleTags.length === 0 ? <span className="chip">{isPl ? "Brak tagów" : "No tags"}</span> : null}
        </div>
      </section>

      <section className="library-grid">
        {filteredPrompts.map((prompt) => (
          <article
            key={prompt.id}
            className={selectedPromptId === prompt.id ? "library-card selected" : "library-card"}
            onClick={() => setSelectedPromptId(prompt.id)}
          >
            {lib.sync.connected && lib.getPromptSyncStatus(prompt) !== "synced" ? (
              <div className="library-card-status">
                <span className="chip chip-warning">{syncLabel(lib.getPromptSyncStatus(prompt), isPl)}</span>
              </div>
            ) : null}
            <div className="row-between">
              <h3>{prompt.title}</h3>
              <button
                type="button"
                className={prompt.favorite ? "favorite-toggle active" : "favorite-toggle"}
                aria-label={prompt.favorite
                  ? (isPl ? "Usuń z ulubionych" : "Remove from favorites")
                  : (isPl ? "Dodaj do ulubionych" : "Add to favorites")}
                title={prompt.favorite
                  ? (isPl ? "Usuń z ulubionych" : "Remove from favorites")
                  : (isPl ? "Dodaj do ulubionych" : "Add to favorites")}
                onClick={(event) => {
                  event.stopPropagation();
                  lib.togglePromptFavorite(prompt.id);
                }}
              >
                ★
              </button>
            </div>
            <div className="tag-cloud">
              {prompt.categoryId !== UNCATEGORIZED_ID ? (
                <span className="chip">
                  {categoryMap.get(prompt.categoryId) ?? (isPl ? "Bez kategorii" : "Uncategorized")}
                </span>
              ) : null}
              {prompt.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="chip chip-purple">
                  {tag}
                </span>
              ))}
            </div>
            <p>{prompt.content.slice(0, 170)}{prompt.content.length > 170 ? "..." : ""}</p>
            <small>{isPl ? "Aktualizacja" : "Updated"}: {new Date(prompt.updatedAt).toLocaleDateString()}</small>
          </article>
        ))}
        {filteredPrompts.length === 0 ? <div className="surface">{isPl ? "Brak wyników dla aktualnych filtrów." : "No results for current filters."}</div> : null}
      </section>

      {selectedPrompt ? (
        <section className="prompt-preview-backdrop" onClick={() => setSelectedPromptId(null)}>
          <article className="prompt-preview" onClick={(event) => event.stopPropagation()}>
            <div className="row-between">
              <div className="prompt-preview-title">
                <h2>{selectedPrompt.title}</h2>
                <button
                  type="button"
                  className={selectedPrompt.favorite ? "favorite-toggle active" : "favorite-toggle"}
                  aria-label={selectedPrompt.favorite
                    ? (isPl ? "Usuń z ulubionych" : "Remove from favorites")
                    : (isPl ? "Dodaj do ulubionych" : "Add to favorites")}
                  title={selectedPrompt.favorite
                    ? (isPl ? "Usuń z ulubionych" : "Remove from favorites")
                    : (isPl ? "Dodaj do ulubionych" : "Add to favorites")}
                  onClick={() => lib.togglePromptFavorite(selectedPrompt.id)}
                >
                  ★
                </button>
              </div>
              <button className="ghost" onClick={() => setSelectedPromptId(null)}>{isPl ? "Zamknij" : "Close"}</button>
            </div>

            <div className="tag-cloud">
              {lib.sync.connected && lib.getPromptSyncStatus(selectedPrompt) !== "synced" ? (
                <span className="chip chip-warning">{syncLabel(lib.getPromptSyncStatus(selectedPrompt), isPl)}</span>
              ) : null}
              {selectedPrompt.categoryId !== UNCATEGORIZED_ID ? (
                <span className="chip">
                  {categoryMap.get(selectedPrompt.categoryId) ?? (isPl ? "Bez kategorii" : "Uncategorized")}
                </span>
              ) : null}
              {selectedPrompt.tags.map((tag) => (
                <span key={tag} className="chip chip-purple">{tag}</span>
              ))}
            </div>

            <pre>{selectedPrompt.content}</pre>

            <div className="row-gap">
              <button onClick={() => void lib.copyPrompt(selectedPrompt.id)}>{isPl ? "Kopiuj" : "Copy"}</button>
              <button className="ghost" onClick={() => navigate("create", { id: selectedPrompt.id })}>{isPl ? "Edytuj" : "Edit"}</button>
              <button
                className="ghost"
                onClick={() => {
                  const copyId = lib.duplicatePrompt(selectedPrompt.id);
                  setSelectedPromptId(copyId);
                }}
              >
                {isPl ? "Duplikuj" : "Duplicate"}
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (!confirmPromptDeletion(selectedPrompt.title, isPl)) return;
                  lib.deletePrompt(selectedPrompt.id);
                  setSelectedPromptId(null);
                }}
              >
                {isPl ? "Usuń" : "Delete"}
              </button>
            </div>
          </article>
        </section>
      ) : null}
    </div>
  );
}

function CreatePromptPage({
  lib,
  params,
  navigate,
  language
}: {
  lib: LibraryApi;
  params: URLSearchParams;
  navigate: (page: AppPage, params?: Record<string, string>) => void;
  language: Language;
}) {
  const isPl = language === "pl";
  const locale = isPl ? "pl" : "en";
  const editId = params.get("id");
  const editingPrompt = useMemo(
    () => (editId ? lib.db.prompts.find((prompt) => prompt.id === editId) ?? null : null),
    [editId, lib.db.prompts]
  );

  const [draft, setDraft] = useState<PromptDraft>(lib.createPrompt());
  const [newTagInput, setNewTagInput] = useState("");

  useEffect(() => {
    if (!editingPrompt) {
      setDraft(lib.createPrompt());
      return;
    }

    setDraft({
      id: editingPrompt.id,
      title: editingPrompt.title,
      categoryId: editingPrompt.categoryId,
      content: editingPrompt.content,
      tags: editingPrompt.tags,
      favorite: editingPrompt.favorite
    });
  }, [editingPrompt, lib]);

  const tagsUniverse = useMemo(() => {
    const unique = new Set<string>();
    for (const prompt of lib.db.prompts) {
      for (const tag of prompt.tags) unique.add(tag);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b, locale, { sensitivity: "base" }));
  }, [lib.db.prompts, locale]);

  function addTag() {
    const tag = newTagInput.trim();
    if (!tag || draft.tags.includes(tag)) {
      setNewTagInput("");
      return;
    }
    setDraft((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    setNewTagInput("");
  }

  function removeTag(tag: string) {
    setDraft((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const promptId = lib.upsertPrompt(draft);
    navigate("prompts", { prompt: promptId });
  }

  return (
    <section className="surface create-page">
      <div className="section-title-row">
        <h2>{editingPrompt ? (isPl ? "Edytuj prompt" : "Edit prompt") : (isPl ? "Nowy prompt" : "New prompt")}</h2>
        <button className="ghost" onClick={() => navigate("prompts")}>{isPl ? "Wróć do biblioteki" : "Back to library"}</button>
      </div>

      <form className="editor-form" onSubmit={onSubmit}>
        <label>
          {isPl ? "Tytuł" : "Title"} *
          <input
            value={draft.title}
            onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
            required
          />
        </label>

        <label>
          {isPl ? "Kategoria" : "Category"} *
          <select
            value={draft.categoryId}
            onChange={(e) => setDraft((prev) => ({ ...prev, categoryId: e.target.value }))}
          >
            {lib.db.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.id === UNCATEGORIZED_ID ? (isPl ? "Bez kategorii" : "Uncategorized") : category.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          {isPl ? "Treść" : "Content"} *
          <textarea
            value={draft.content}
            onChange={(e) => setDraft((prev) => ({ ...prev, content: e.target.value }))}
            rows={16}
            required
          />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.favorite}
            onChange={(e) => setDraft((prev) => ({ ...prev, favorite: e.target.checked }))}
          />
          {isPl ? "Ulubiony" : "Favorite"}
        </label>

        <label>
          {isPl ? "Tagi" : "Tags"}
          <div className="row-gap">
            <input
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              list="all-tags-create"
              placeholder={isPl ? "Wpisz tag i Enter" : "Type a tag and press Enter"}
            />
            <button type="button" className="ghost" onClick={addTag}>{isPl ? "Dodaj tag" : "Add tag"}</button>
          </div>
          <datalist id="all-tags-create">
            {tagsUniverse.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        </label>

        <div className="tag-cloud">
          {draft.tags.map((tag) => (
            <button key={tag} type="button" className="tag-pill" onClick={() => removeTag(tag)}>
              {tag} ×
            </button>
          ))}
        </div>

        <div className="row-gap">
          <button type="submit">
            {editingPrompt ? (isPl ? "Zapisz zmiany" : "Save changes") : (isPl ? "Dodaj prompt" : "Add prompt")}
          </button>
          {editingPrompt ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!confirmPromptDeletion(editingPrompt.title, isPl)) return;
                lib.deletePrompt(editingPrompt.id);
                navigate("prompts");
              }}
            >
              {isPl ? "Usuń prompt" : "Delete prompt"}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function CategoriesPage({ lib, language }: { lib: LibraryApi; language: Language }) {
  const isPl = language === "pl";
  const locale = isPl ? "pl" : "en";
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<CategorySortMode>("az");
  const [bulkAction, setBulkAction] = useState<CategoryBulkAction | null>(null);
  const [targetCategoryId, setTargetCategoryId] = useState<string>(UNCATEGORIZED_ID);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const category of lib.db.categories) map.set(category.id, 0);
    for (const prompt of lib.db.prompts) {
      map.set(prompt.categoryId, (map.get(prompt.categoryId) || 0) + 1);
    }
    return map;
  }, [lib.db.categories, lib.db.prompts]);

  const selectableCategories = useMemo(
    () => lib.db.categories.filter((category) => category.id !== UNCATEGORIZED_ID),
    [lib.db.categories]
  );

  useEffect(() => {
    const validIds = new Set(selectableCategories.map((category) => category.id));
    setSelectedIds((prev) => prev.filter((id) => validIds.has(id)));
  }, [selectableCategories]);

  const visibleCategories = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = lib.db.categories.filter((category) => {
      if (!query) return true;
      const label = category.id === UNCATEGORIZED_ID ? (isPl ? "Bez kategorii" : "Uncategorized") : category.name;
      return label.toLowerCase().includes(query);
    });

    const sorted = [...filtered];
    if (sortMode === "az") {
      sorted.sort((a, b) => {
        const aName = a.id === UNCATEGORIZED_ID ? (isPl ? "Bez kategorii" : "Uncategorized") : a.name;
        const bName = b.id === UNCATEGORIZED_ID ? (isPl ? "Bez kategorii" : "Uncategorized") : b.name;
        return aName.localeCompare(bName, locale, { sensitivity: "base" });
      });
    }
    if (sortMode === "countDesc") {
      sorted.sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
    }
    if (sortMode === "countAsc") {
      sorted.sort((a, b) => (counts.get(a.id) || 0) - (counts.get(b.id) || 0));
    }
    if (sortMode === "newest") {
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    return sorted;
  }, [counts, isPl, lib.db.categories, locale, search, sortMode]);

  const visibleSelectableIds = useMemo(
    () => visibleCategories.filter((category) => category.id !== UNCATEGORIZED_ID).map((category) => category.id),
    [visibleCategories]
  );

  const allVisibleSelected = visibleSelectableIds.length > 0 && visibleSelectableIds.every((id) => selectedIds.includes(id));

  useEffect(() => {
    if (selectedIds.includes(targetCategoryId)) {
      const fallback = lib.db.categories.find((category) => !selectedIds.includes(category.id))?.id ?? UNCATEGORIZED_ID;
      setTargetCategoryId(fallback);
    }
  }, [lib.db.categories, selectedIds, targetCategoryId]);

  const availableTargetCategories = useMemo(
    () => lib.db.categories.filter((category) => !selectedIds.includes(category.id)),
    [lib.db.categories, selectedIds]
  );

  const selectedPromptCount = useMemo(
    () => selectedIds.reduce((sum, id) => sum + (counts.get(id) || 0), 0),
    [counts, selectedIds]
  );

  const selectedCategories = useMemo(
    () => lib.db.categories.filter((category) => selectedIds.includes(category.id)),
    [lib.db.categories, selectedIds]
  );

  function categoryLabel(category: Category) {
    return category.id === UNCATEGORIZED_ID ? (isPl ? "Bez kategorii" : "Uncategorized") : category.name;
  }

  function closeBulkAction() {
    setBulkAction(null);
  }

  function confirmBulkAction() {
    if (bulkAction === "move") {
      lib.movePromptsToCategory(selectedIds, targetCategoryId);
      closeBulkAction();
      return;
    }
    if (bulkAction === "merge") {
      lib.mergeCategories(selectedIds, targetCategoryId);
      setSelectedIds([]);
      closeBulkAction();
      return;
    }
    if (bulkAction === "delete") {
      lib.deleteCategories(selectedIds);
      setSelectedIds([]);
      closeBulkAction();
    }
  }

  return (
    <div className="surface">
      <div className="section-title-row">
        <h2>{isPl ? "Zarządzanie kategoriami" : "Manage categories"}</h2>
        <div className="row-gap">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={isPl ? "Nowa kategoria" : "New category"} />
          <button onClick={() => { lib.createCategory(newName); setNewName(""); }}>{isPl ? "Dodaj" : "Add"}</button>
        </div>
      </div>

      <div className="category-filters">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isPl ? "Szukaj kategorii..." : "Search categories..."}
        />
        <select value={sortMode} onChange={(e) => setSortMode(e.target.value as CategorySortMode)}>
          <option value="az">{isPl ? "Nazwa A-Z" : "Name A-Z"}</option>
          <option value="countDesc">{isPl ? "Najwięcej promptów" : "Most prompts"}</option>
          <option value="countAsc">{isPl ? "Najmniej promptów" : "Fewest prompts"}</option>
          <option value="newest">{isPl ? "Najnowsze" : "Newest"}</option>
        </select>
      </div>

      <div className="category-bulk-toolbar">
        <div className="row-gap">
          <button
            type="button"
            className="ghost"
            onClick={() =>
              setSelectedIds((prev) =>
                allVisibleSelected
                  ? prev.filter((id) => !visibleSelectableIds.includes(id))
                  : Array.from(new Set([...prev, ...visibleSelectableIds]))
              )
            }
            disabled={visibleSelectableIds.length === 0}
          >
            {allVisibleSelected
              ? (isPl ? "Odznacz wszystko" : "Clear all")
              : (isPl ? "Zaznacz wszystko" : "Select all")}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setSelectedIds([])}
            disabled={selectedIds.length === 0}
          >
            {isPl ? "Wyczyść zaznaczenie" : "Clear selection"}
          </button>
        </div>
        <div className="category-stats">
          <small>
            {isPl
              ? `Zaznaczone: ${selectedIds.length}`
              : `Selected: ${selectedIds.length}`}
          </small>
          <small>
            {isPl
              ? `Prompty objęte akcją: ${selectedPromptCount}`
              : `Prompts affected: ${selectedPromptCount}`}
          </small>
          <small>
            {isPl
              ? `Widoczne: ${visibleCategories.length}`
              : `Visible: ${visibleCategories.length}`}
          </small>
        </div>
      </div>

      {selectedIds.length > 0 ? (
        <div className="category-selection-bar">
          <div>
            <strong>
              {isPl
                ? `Wybrano ${selectedIds.length} kategorii`
                : `${selectedIds.length} categories selected`}
            </strong>
            <p>
              {isPl
                ? `Akcja obejmie ${selectedPromptCount} promptów.`
                : `${selectedPromptCount} prompts will be affected.`}
            </p>
          </div>
          <div className="row-gap">
            <button
              type="button"
              className="ghost"
              onClick={() => setBulkAction("move")}
              disabled={availableTargetCategories.length === 0}
            >
              {isPl ? "Przenieś prompty" : "Move prompts"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setBulkAction("merge")}
              disabled={availableTargetCategories.length === 0}
            >
              {isPl ? "Scal kategorie" : "Merge categories"}
            </button>
            <button type="button" className="danger" onClick={() => setBulkAction("delete")}>
              {isPl ? "Usuń kategorie" : "Delete categories"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="category-grid">
        {visibleCategories.map((category) => (
          <article
            key={category.id}
            className={selectedIds.includes(category.id) ? "category-card selected" : "category-card"}
          >
            {editingId === category.id ? (
              <>
                <input value={editingName} onChange={(e) => setEditingName(e.target.value)} />
                <div className="row-gap">
                  <button className="ghost" onClick={() => { lib.renameCategory(category.id, editingName); setEditingId(null); setEditingName(""); }}>{isPl ? "Zapisz" : "Save"}</button>
                  <button className="ghost" onClick={() => { setEditingId(null); setEditingName(""); }}>{isPl ? "Anuluj" : "Cancel"}</button>
                </div>
              </>
            ) : (
              <>
                <div className="row-between">
                  <label className="category-select">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(category.id)}
                      onChange={(e) => {
                        if (category.id === UNCATEGORIZED_ID) return;
                        setSelectedIds((prev) =>
                          e.target.checked ? [...prev, category.id] : prev.filter((id) => id !== category.id)
                        );
                      }}
                      disabled={category.id === UNCATEGORIZED_ID}
                    />
                    <span>{isPl ? "Zaznacz" : "Select"}</span>
                  </label>
                </div>
                <h3>{category.id === UNCATEGORIZED_ID ? (isPl ? "Bez kategorii" : "Uncategorized") : category.name}</h3>
                <p>{counts.get(category.id) || 0} {isPl ? "promptów" : "prompts"}</p>
                <small>{isPl ? "Utworzono" : "Created"}: {new Date(category.createdAt).toLocaleDateString()}</small>
                <div className="row-gap">
                  {category.id !== UNCATEGORIZED_ID ? (
                    <>
                      <button className="ghost" onClick={() => { setEditingId(category.id); setEditingName(category.name); }}>{isPl ? "Zmień nazwę" : "Rename"}</button>
                      <button className="danger" onClick={() => lib.deleteCategory(category.id)}>{isPl ? "Usuń" : "Delete"}</button>
                    </>
                  ) : (
                    <button className="ghost" disabled>{isPl ? "Kategoria systemowa" : "System category"}</button>
                  )}
                </div>
              </>
            )}
          </article>
        ))}
        {visibleCategories.length === 0 ? (
          <div className="surface">{isPl ? "Brak kategorii dla aktualnego filtra." : "No categories match the current filter."}</div>
        ) : null}
      </div>

      {bulkAction ? (
        <section className="prompt-preview-backdrop" onClick={closeBulkAction}>
          <article className="prompt-preview category-action-modal" onClick={(event) => event.stopPropagation()}>
            <div className="row-between">
              <div>
                <h2>
                  {bulkAction === "move"
                    ? (isPl ? "Przenieś prompty" : "Move prompts")
                    : bulkAction === "merge"
                      ? (isPl ? "Scal kategorie" : "Merge categories")
                      : (isPl ? "Usuń kategorie" : "Delete categories")}
                </h2>
                <p className="category-modal-copy">
                  {bulkAction === "move"
                    ? (isPl ? "Prompty zostaną przeniesione, a same kategorie pozostaną bez zmian." : "Prompts will be moved while the categories stay unchanged.")
                    : bulkAction === "merge"
                      ? (isPl ? "Prompty zostaną przeniesione, a zaznaczone kategorie źródłowe zostaną usunięte." : "Prompts will be moved and the selected source categories will be removed.")
                      : (isPl ? "Zaznaczone kategorie zostaną usunięte, a ich prompty trafią do kategorii Bez kategorii." : "Selected categories will be removed and their prompts will move to Uncategorized.")}
                </p>
              </div>
              <button className="ghost" onClick={closeBulkAction}>{isPl ? "Zamknij" : "Close"}</button>
            </div>

            <div className="category-modal-summary">
              <small>{isPl ? `Kategorie: ${selectedIds.length}` : `Categories: ${selectedIds.length}`}</small>
              <small>{isPl ? `Prompty: ${selectedPromptCount}` : `Prompts: ${selectedPromptCount}`}</small>
            </div>

            <div className="tag-cloud">
              {selectedCategories.map((category) => (
                <span key={category.id} className="chip">
                  {categoryLabel(category)}
                </span>
              ))}
            </div>

            {bulkAction !== "delete" ? (
              <label className="category-modal-field">
                {bulkAction === "move"
                  ? (isPl ? "Przenieś do" : "Move to")
                  : (isPl ? "Scal do" : "Merge into")}
                <select
                  value={targetCategoryId}
                  onChange={(e) => setTargetCategoryId(e.target.value)}
                  disabled={availableTargetCategories.length === 0}
                >
                  {availableTargetCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {categoryLabel(category)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="row-gap">
              <button
                type="button"
                onClick={confirmBulkAction}
                disabled={bulkAction !== "delete" && !availableTargetCategories.some((category) => category.id === targetCategoryId)}
              >
                {bulkAction === "move"
                  ? (isPl ? "Potwierdź przeniesienie" : "Confirm move")
                  : bulkAction === "merge"
                    ? (isPl ? "Potwierdź scalenie" : "Confirm merge")
                    : (isPl ? "Potwierdź usunięcie" : "Confirm delete")}
              </button>
              <button type="button" className="ghost" onClick={closeBulkAction}>
                {isPl ? "Anuluj" : "Cancel"}
              </button>
            </div>
          </article>
        </section>
      ) : null}
    </div>
  );
}

function DataPage({
  lib,
  language,
  legacyJsonExportEnabled
}: {
  lib: LibraryApi;
  language: Language;
  legacyJsonExportEnabled: boolean;
}) {
  const isPl = language === "pl";
  const fileRef = useRef<HTMLInputElement>(null);
  const markdownFolderRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<DbFile | null>(null);
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [markdownImportPreview, setMarkdownImportPreview] = useState<MdImportCandidate[] | null>(null);
  const [selectedMarkdownPaths, setSelectedMarkdownPaths] = useState<string[]>([]);
  const [markdownImportName, setMarkdownImportName] = useState("");
  const [markdownImportError, setMarkdownImportError] = useState<string | null>(null);
  const [markdownExportBusy, setMarkdownExportBusy] = useState(false);

  useEffect(() => {
    if (lib.sync.connected) {
      void lib.rescanPromptFolder();
    }
  }, []);

  function downloadExport() {
    const blob = new Blob([lib.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `prompts-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function onFileImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportError(null);

    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as DbFile;
      const normalized = normalizeDb(parsed);
      const existingIds = new Set(lib.db.prompts.map((prompt) => prompt.id));
      const defaultSelection = normalized.prompts
        .filter((prompt) => !existingIds.has(prompt.id))
        .map((prompt) => prompt.id);

      setImportFileName(file.name);
      setImportPreview(normalized);
      setSelectedImportIds(defaultSelection);
    } catch {
      setImportError(isPl ? "Niepoprawny plik JSON" : "Invalid JSON file");
      setImportPreview(null);
      setSelectedImportIds([]);
      setImportFileName("");
    }

    event.target.value = "";
  }

  async function onMarkdownFolderImport(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setMarkdownImportError(null);

    try {
      const markdownFiles = files.filter((file) => /\.md$/i.test(file.name));
      const candidatesRaw = await Promise.all(markdownFiles.map((file) => markdownCandidateFromFile(file)));
      const candidates = candidatesRaw.filter((candidate): candidate is MdImportCandidate => candidate !== null);

      if (candidates.length === 0) {
        setMarkdownImportError(isPl ? "Nie znaleziono plików Markdown w wybranym katalogu" : "No Markdown files found in the selected folder");
        setMarkdownImportPreview(null);
        setSelectedMarkdownPaths([]);
        setMarkdownImportName("");
        return;
      }

      const directoryName = files[0] && "webkitRelativePath" in files[0] && typeof files[0].webkitRelativePath === "string"
        ? files[0].webkitRelativePath.split("/")[0] || files[0].name
        : files[0]?.name || "";

      const uniqueCandidates = Array.from(
        new Map(candidates.map((candidate) => [candidate.sourcePath, candidate])).values()
      ).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, "pl", { sensitivity: "base" }));

      setMarkdownImportName(directoryName);
      setMarkdownImportPreview(uniqueCandidates);
      setSelectedMarkdownPaths(uniqueCandidates.map((candidate) => candidate.sourcePath));
    } catch {
      setMarkdownImportError(isPl ? "Nie udało się wczytać katalogu Markdown" : "Could not read the Markdown folder");
      setMarkdownImportPreview(null);
      setSelectedMarkdownPaths([]);
      setMarkdownImportName("");
    }

    event.target.value = "";
  }

  function applySelectedImport() {
    if (!importPreview) return;
    const selectedPrompts = importPreview.prompts.filter((prompt) =>
      selectedImportIds.includes(prompt.id)
    );
    if (selectedPrompts.length === 0) {
      setImportError(isPl ? "Wybierz co najmniej jeden prompt" : "Select at least one prompt");
      return;
    }

    const usedCategoryIds = new Set<string>([UNCATEGORIZED_ID]);
    for (const prompt of selectedPrompts) {
      usedCategoryIds.add(prompt.categoryId);
    }
    const selectedCategories = importPreview.categories.filter((category) =>
      usedCategoryIds.has(category.id)
    );

    const payload: DbFile = {
      version: 1,
      categories: selectedCategories,
      prompts: selectedPrompts
    };

    lib.importJson(JSON.stringify(payload));
    setImportPreview(null);
    setSelectedImportIds([]);
    setImportFileName("");
    setImportError(null);
  }

  function applySelectedMarkdownImport() {
    if (!markdownImportPreview) return;

    const selectedCandidates = markdownImportPreview.filter((candidate) =>
      selectedMarkdownPaths.includes(candidate.sourcePath)
    );
    if (selectedCandidates.length === 0) {
      setMarkdownImportError(isPl ? "Wybierz co najmniej jeden plik Markdown" : "Select at least one Markdown file");
      return;
    }

    lib.importMarkdownPrompts(selectedCandidates);
    setMarkdownImportPreview(null);
    setSelectedMarkdownPaths([]);
    setMarkdownImportName("");
    setMarkdownImportError(null);
  }

  async function exportPromptsZip() {
    setMarkdownImportError(null);
    setMarkdownExportBusy(true);
    try {
      const categoryNameById = new Map(
        lib.db.categories.map((category) => [category.id, category.name] as const)
      );
      const files = lib.db.prompts.map((prompt) => ({
        path: markdownExportPath(
          prompt,
          categoryNameById.get(prompt.categoryId) ?? DEFAULT_UNCATEGORIZED_LABEL
        ),
        content: prompt.content
      }));
      const zipBlob = createStoredZip(files);
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `prompts-export-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMarkdownImportError(
        isPl ? "Nie udało się wyeksportować promptów" : "Could not export prompts"
      );
    } finally {
      setMarkdownExportBusy(false);
    }
  }

  const existingIds = useMemo(
    () => new Set(lib.db.prompts.map((prompt) => prompt.id)),
    [lib.db.prompts]
  );
  const existingSourcePaths = useMemo(
    () =>
      new Set(
        lib.db.prompts
          .map((prompt) => normalizeSourcePath(prompt.sourcePath))
          .filter((path): path is string => Boolean(path))
      ),
    [lib.db.prompts]
  );

  const selectedCount = selectedImportIds.length;
  const previewCount = importPreview?.prompts.length ?? 0;
  const selectedMarkdownCount = selectedMarkdownPaths.length;
  const markdownPreviewCount = markdownImportPreview?.length ?? 0;
  const syncIssues = useMemo(
    () => lib.db.prompts.filter((prompt) => {
      const status = lib.getPromptSyncStatus(prompt);
      return status === "conflict" || status === "missing_file";
    }),
    [lib]
  );
  const localOnlyCount = useMemo(
    () => lib.db.prompts.filter((prompt) => lib.getPromptSyncStatus(prompt) === "local_only").length,
    [lib]
  );
  const syncedCount = useMemo(
    () => lib.db.prompts.filter((prompt) => lib.getPromptSyncStatus(prompt) === "synced").length,
    [lib]
  );

  return (
    <div className="data-layout">
      <section className="surface">
        <h2>{isPl ? "Synchronizacja katalogu" : "Folder sync"}</h2>
        <p>
          {isPl
            ? "Chrome storage pozostaje główną bazą. Podłączony katalog służy do importu nowych lub zmienionych plików Markdown i do automatycznego zapisu promptów zmienionych w rozszerzeniu."
            : "Chrome storage remains the primary database. A connected folder is used to import new or changed Markdown files and to automatically save prompts edited in the extension."}
        </p>
        <div className="row-gap">
          <button onClick={() => void lib.connectPromptFolder()}>
            {lib.sync.connected ? (isPl ? "Zmień katalog" : "Change folder") : (isPl ? "Podłącz katalog" : "Connect folder")}
          </button>
          <button className="ghost" onClick={() => void lib.rescanPromptFolder()} disabled={!lib.sync.connected || lib.syncBusy}>
            {lib.syncBusy
              ? (isPl ? "Synchronizacja..." : "Syncing...")
              : (isPl ? "Synchronizuj katalog" : "Sync folder")}
          </button>
          <button className="ghost" onClick={() => void lib.disconnectPromptFolder()} disabled={!lib.sync.connected}>
            {isPl ? "Odłącz katalog" : "Disconnect folder"}
          </button>
        </div>
        <ul className="stats-list">
          <li>{isPl ? "Status" : "Status"}: {lib.sync.connected ? (isPl ? "podłączony" : "connected") : (isPl ? "niepodłączony" : "not connected")}</li>
          <li>{isPl ? "Katalog" : "Folder"}: {lib.sync.folderName ?? (isPl ? "brak" : "none")}</li>
          <li>{isPl ? "Ostatni skan" : "Last scan"}: {lib.sync.lastScannedAt ? new Date(lib.sync.lastScannedAt).toLocaleString() : (isPl ? "jeszcze nie" : "not yet")}</li>
          <li>{isPl ? "Zsynchronizowane" : "Synced"}: {syncedCount}</li>
          <li>{isPl ? "Tylko w rozszerzeniu" : "Local only"}: {localOnlyCount}</li>
          <li>{isPl ? "Problemy synchronizacji" : "Sync issues"}: {syncIssues.length}</li>
        </ul>
      </section>

      <section className="surface">
        <h2>{isPl ? "Import / Eksport" : "Import / Export"}</h2>
        <p>
          {isPl
            ? "Open prompts folder importuje pliki Markdown z całego katalogu. Katalog główny jest ignorowany, pierwszy folder pod nim staje się kategorią, a kolejne foldery stają się tagami. Export prompts zapisuje całą bibliotekę do jednego pliku ZIP z tą samą strukturą."
            : "Open prompts folder imports Markdown files from a whole directory. The root folder is ignored, the first nested folder becomes the category, and the following folders become tags. Export prompts writes the whole library to a single ZIP file using the same structure."}
        </p>
        <div className="row-gap">
          {legacyJsonExportEnabled ? (
            <button onClick={downloadExport}>{isPl ? "Eksport JSON (legacy)" : "Export JSON (legacy)"}</button>
          ) : null}
          {legacyJsonExportEnabled ? (
            <button className="ghost" onClick={() => fileRef.current?.click()}>{isPl ? "Import JSON (legacy)" : "Import JSON (legacy)"}</button>
          ) : null}
          <button className="ghost" onClick={() => markdownFolderRef.current?.click()}>
            {isPl ? "Open prompts folder" : "Open prompts folder"}
          </button>
          <button className="ghost" onClick={() => void exportPromptsZip()} disabled={markdownExportBusy}>
            {markdownExportBusy
              ? (isPl ? "Eksport promptów..." : "Exporting prompts...")
              : "Export prompts"}
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFileImport} hidden />
          <input
            ref={markdownFolderRef}
            type="file"
            accept=".md,text/markdown"
            multiple
            onChange={onMarkdownFolderImport}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            hidden
          />
        </div>
        {importError ? <p className="import-error">{importError}</p> : null}
        {markdownImportError ? <p className="import-error">{markdownImportError}</p> : null}
      </section>

      <section className="surface">
        <h2>{isPl ? "Problemy synchronizacji" : "Sync issues"}</h2>
        {syncIssues.length === 0 ? (
          <p>{isPl ? "Brak konfliktów i brakujących plików." : "No conflicts or missing files."}</p>
        ) : (
          <div className="import-list">
            {syncIssues.map((prompt) => {
              const status = lib.getPromptSyncStatus(prompt);
              return (
                <div key={prompt.id} className="import-item selected">
                  <div>
                    <div className="row-between">
                      <strong>{prompt.title}</strong>
                      <span className="import-badge update">{syncLabel(status, isPl)}</span>
                    </div>
                    <small className="import-path">{prompt.sourcePath}</small>
                    <p>{prompt.content.slice(0, 120)}{prompt.content.length > 120 ? "..." : ""}</p>
                    <div className="row-gap">
                      {status === "conflict" ? (
                        <>
                          <button className="ghost" onClick={() => void lib.importPromptFromFolder(prompt.id)}>
                            {isPl ? "Wczytaj z pliku" : "Import from file"}
                          </button>
                          <button onClick={() => void lib.overwritePromptToFolder(prompt.id)}>
                            {isPl ? "Nadpisz plik" : "Overwrite file"}
                          </button>
                        </>
                      ) : null}
                      {status === "missing_file" ? (
                        <>
                          <button onClick={() => void lib.overwritePromptToFolder(prompt.id)}>
                            {isPl ? "Zapisz ponownie do katalogu" : "Write back to folder"}
                          </button>
                          <button className="ghost" onClick={() => lib.disconnectPromptFromFolder(prompt.id)}>
                            {isPl ? "Odłącz plik" : "Disconnect file"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {importPreview ? (
        <section className="surface import-preview">
          <div className="section-title-row">
            <h2>{isPl ? "Podgląd importu" : "Import preview"}: {importFileName}</h2>
            <small>{selectedCount} / {previewCount} {isPl ? "zaznaczone" : "selected"}</small>
          </div>
          <div className="row-gap">
            <button
              className="ghost"
              onClick={() => setSelectedImportIds(importPreview.prompts.map((prompt) => prompt.id))}
            >
              {isPl ? "Zaznacz wszystko" : "Select all"}
            </button>
            <button
              className="ghost"
              onClick={() =>
                setSelectedImportIds(
                  importPreview.prompts
                    .filter((prompt) => !existingIds.has(prompt.id))
                    .map((prompt) => prompt.id)
                )
              }
            >
              {isPl ? "Tylko nowe" : "Only new"}
            </button>
            <button className="ghost" onClick={() => setSelectedImportIds([])}>
              {isPl ? "Wyczyść" : "Clear"}
            </button>
            <button onClick={applySelectedImport}>{isPl ? "Importuj zaznaczone" : "Import selected"}</button>
          </div>

          <div className="import-list">
            {importPreview.prompts.map((prompt) => {
              const isUpdate = existingIds.has(prompt.id);
              const checked = selectedImportIds.includes(prompt.id);
              return (
                <label key={prompt.id} className={checked ? "import-item selected" : "import-item"}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setSelectedImportIds((prev) => [...prev, prompt.id]);
                      } else {
                        setSelectedImportIds((prev) => prev.filter((id) => id !== prompt.id));
                      }
                    }}
                  />
                  <div>
                    <div className="row-between">
                      <strong>{prompt.title}</strong>
                      <span className={isUpdate ? "import-badge update" : "import-badge new"}>
                        {isUpdate ? (isPl ? "aktualizacja" : "update") : (isPl ? "nowy" : "new")}
                      </span>
                    </div>
                    <p>{prompt.content.slice(0, 120)}{prompt.content.length > 120 ? "..." : ""}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </section>
      ) : null}

      {markdownImportPreview ? (
        <section className="surface import-preview">
          <div className="section-title-row">
            <h2>{isPl ? "Podgląd importu Markdown" : "Markdown import preview"}: {markdownImportName}</h2>
            <small>{selectedMarkdownCount} / {markdownPreviewCount} {isPl ? "zaznaczone" : "selected"}</small>
          </div>
          <div className="row-gap">
            <button
              className="ghost"
              onClick={() => setSelectedMarkdownPaths(markdownImportPreview.map((candidate) => candidate.sourcePath))}
            >
              {isPl ? "Zaznacz wszystko" : "Select all"}
            </button>
            <button
              className="ghost"
              onClick={() =>
                setSelectedMarkdownPaths(
                  markdownImportPreview
                    .filter((candidate) => !existingSourcePaths.has(candidate.sourcePath))
                    .map((candidate) => candidate.sourcePath)
                )
              }
            >
              {isPl ? "Tylko nowe ścieżki" : "Only new paths"}
            </button>
            <button className="ghost" onClick={() => setSelectedMarkdownPaths([])}>
              {isPl ? "Wyczyść" : "Clear"}
            </button>
            <button onClick={applySelectedMarkdownImport}>
              {isPl ? "Importuj pliki Markdown" : "Import Markdown files"}
            </button>
          </div>

          <div className="import-list">
            {markdownImportPreview.map((candidate) => {
              const isUpdate = existingSourcePaths.has(candidate.sourcePath);
              const checked = selectedMarkdownPaths.includes(candidate.sourcePath);
              return (
                <label key={candidate.sourcePath} className={checked ? "import-item selected" : "import-item"}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setSelectedMarkdownPaths((prev) => [...prev, candidate.sourcePath]);
                      } else {
                        setSelectedMarkdownPaths((prev) => prev.filter((path) => path !== candidate.sourcePath));
                      }
                    }}
                  />
                  <div>
                    <div className="row-between">
                      <strong>{candidate.title}</strong>
                      <span className={isUpdate ? "import-badge update" : "import-badge new"}>
                        {isUpdate ? (isPl ? "aktualizacja" : "update") : (isPl ? "nowy" : "new")}
                      </span>
                    </div>
                    <small className="import-path">
                      {isPl ? "Kategoria" : "Category"}: {candidate.categoryName}
                    </small>
                    <small className="import-path">{candidate.sourcePath}</small>
                    <p>{candidate.content.slice(0, 120)}{candidate.content.length > 120 ? "..." : ""}</p>
                    <div className="tag-cloud">
                      {candidate.tags.length === 0 ? (
                        <span className="chip">{isPl ? "Brak tagów z folderów" : "No folder tags"}</span>
                      ) : (
                        candidate.tags.map((tag) => (
                          <span key={`${candidate.sourcePath}-${tag}`} className="chip chip-purple">{tag}</span>
                        ))
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="surface">
        <h2>{isPl ? "Jak działa import" : "How import works"}</h2>
        <ul className="stats-list">
          <li>{isPl ? "otwierasz katalog z promptami," : "open a prompts folder,"}</li>
          <li>{isPl ? "sprawdzasz podgląd i zaznaczasz rekordy do importu," : "review the preview and select records to import,"}</li>
          <li>{isPl ? "przy imporcie Markdown katalog główny jest ignorowany, pierwszy pod nim tworzy kategorię, kolejne tworzą tagi," : "during Markdown import the root folder is ignored, the first nested folder becomes the category, and the following folders become tags,"}</li>
          <li>{isPl ? "eksport promptów tworzy jeden plik ZIP z odtworzoną strukturą katalogów." : "prompt export creates a single ZIP file with the reconstructed folder structure."}</li>
        </ul>
      </section>

      <section className="surface">
        <h2>{isPl ? "Podsumowanie danych" : "Data summary"}</h2>
        <ul className="stats-list">
          <li>{isPl ? "Wersja formatu" : "Format version"}: {lib.db.version}</li>
          <li>{isPl ? "Liczba promptów" : "Prompts count"}: {lib.db.prompts.length}</li>
          <li>{isPl ? "Liczba kategorii" : "Categories count"}: {lib.db.categories.length}</li>
          <li>{isPl ? "Unikalne tagi" : "Unique tags"}: {new Set(lib.db.prompts.flatMap((p) => p.tags)).size}</li>
        </ul>
      </section>

    </div>
  );
}

function SettingsPage({
  language,
  onLanguageChange,
  quickSaveEnabled,
  onQuickSaveToggle,
  legacyJsonExportEnabled,
  onLegacyJsonExportToggle
}: {
  language: Language;
  onLanguageChange: (next: Language) => void;
  quickSaveEnabled: boolean;
  onQuickSaveToggle: (next: boolean) => Promise<void>;
  legacyJsonExportEnabled: boolean;
  onLegacyJsonExportToggle: (next: boolean) => Promise<void>;
}) {
  const isPl = language === "pl";

  return (
    <div className="data-layout">
      <section className="surface">
        <h2>{isPl ? "Język" : "Language"}</h2>
        <p>{isPl ? "Wybierz język interfejsu rozszerzenia." : "Choose the extension interface language."}</p>
        <div className="row-gap">
          <label htmlFor="language-select-settings">{isPl ? "Język" : "Language"}</label>
          <select
            id="language-select-settings"
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as Language)}
          >
            <option value="pl">Polski</option>
            <option value="en">English</option>
          </select>
        </div>
      </section>

      <section className="surface">
        <h2>{isPl ? "Integracje stron" : "Site integrations"}</h2>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={quickSaveEnabled}
            onChange={(event) => void onQuickSaveToggle(event.target.checked)}
          />
          {isPl
            ? "Pokazuj przycisk `Save to Prompter` na ChatGPT i Claude"
            : "Show the `Save to Prompter` button on ChatGPT and Claude"}
        </label>
      </section>

      <section className="surface">
        <h2>{isPl ? "Funkcje legacy" : "Legacy features"}</h2>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={legacyJsonExportEnabled}
            onChange={(event) => void onLegacyJsonExportToggle(event.target.checked)}
          />
          {isPl
            ? "Pokaż eksport JSON (legacy) w sekcji Dane"
            : "Show JSON export (legacy) in the Data section"}
        </label>
      </section>
    </div>
  );
}

function App() {
  const [language, setLanguage] = useLanguage();
  const { quickSaveEnabled, updateQuickSaveEnabled } = useQuickSaveSetting();
  const { legacyJsonExportEnabled, updateLegacyJsonExportEnabled } = useLegacyJsonExportSetting();
  const lib = useLibrary(language);
  const { route, navigate } = useRouteState();
  const isPl = language === "pl";

  if (lib.loading) {
    return (
      <div className="shell">
        <section className="workspace">
          <div className="surface">
            {isPl ? "Ładowanie danych rozszerzenia..." : "Loading extension data..."}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-dot" />
          <div>
            <strong>Prompter</strong>
            <small>{isPl ? "workspace offline" : "offline workspace"}</small>
          </div>
        </div>

        <nav className="nav-links">
          <NavButton page="dashboard" current={route.page} onClick={(page) => navigate(page)}>Dashboard</NavButton>
          <NavButton page="prompts" current={route.page} onClick={(page) => navigate(page)}>
            {isPl ? "Prompty" : "Prompts"}
          </NavButton>
          <NavButton page="create" current={route.page} onClick={(page) => navigate(page)}>
            {isPl ? "Nowy prompt" : "New prompt"}
          </NavButton>
          <NavButton page="categories" current={route.page} onClick={(page) => navigate(page)}>
            {isPl ? "Kategorie" : "Categories"}
          </NavButton>
          <NavButton page="data" current={route.page} onClick={(page) => navigate(page)}>
            {isPl ? "Dane" : "Data"}
          </NavButton>
          <NavButton page="settings" current={route.page} onClick={(page) => navigate(page)}>
            {isPl ? "Ustawienia" : "Settings"}
          </NavButton>
        </nav>

        <div className="sidebar-card">
          <p>
            {lib.db.prompts.length} {isPl ? "promptów" : "prompts"}
          </p>
          <p>
            {lib.db.categories.length} {isPl ? "kategorii" : "categories"}
          </p>
          <p>
            {lib.db.prompts.filter((p) => p.favorite).length} {isPl ? "ulubionych" : "favorites"}
          </p>
        </div>
      </aside>

      <section className="workspace">
        <header className="page-header">
          <div>
            <h1>{pageTitle(route.page, language)}</h1>
            <p>
              {isPl
                ? "Nowoczesna organizacja promptów z szybkim dostępem i filtrowaniem."
                : "Modern prompt organization with fast access and filtering."}
            </p>
          </div>
          <div className="header-actions">
            <button onClick={() => navigate("create")}>{isPl ? "+ Nowy prompt" : "+ New prompt"}</button>
            <button className="ghost" onClick={() => navigate("data")}>{isPl ? "Import / Export" : "Import / Export"}</button>
          </div>
        </header>

        {lib.error ? <div className="error-banner" onClick={lib.clearError}>{lib.error}</div> : null}

        {route.page === "dashboard" ? <DashboardPage db={lib.db} navigate={navigate} language={language} /> : null}
        {route.page === "prompts" ? (
          <PromptsPage
            lib={lib}
            params={route.params}
            clearParams={() => navigate("prompts")}
            navigate={navigate}
            language={language}
          />
        ) : null}
        {route.page === "create" ? <CreatePromptPage lib={lib} params={route.params} navigate={navigate} language={language} /> : null}
        {route.page === "categories" ? <CategoriesPage lib={lib} language={language} /> : null}
        {route.page === "data" ? <DataPage lib={lib} language={language} legacyJsonExportEnabled={legacyJsonExportEnabled} /> : null}
        {route.page === "settings" ? (
          <SettingsPage
            language={language}
            onLanguageChange={setLanguage}
            quickSaveEnabled={quickSaveEnabled}
            onQuickSaveToggle={updateQuickSaveEnabled}
            legacyJsonExportEnabled={legacyJsonExportEnabled}
            onLegacyJsonExportToggle={updateLegacyJsonExportEnabled}
          />
        ) : null}
      </section>

      {lib.toast ? <div className="toast">{lib.toast}</div> : null}
    </div>
  );
}

export default App;
