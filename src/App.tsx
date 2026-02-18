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

type LibraryApi = {
  loading: boolean;
  backupPending: boolean;
  db: DbFile;
  error: string | null;
  toast: string | null;
  clearError: () => void;
  dismissBackupNotice: () => void;
  backupNow: () => Promise<void>;
  createPrompt: () => PromptDraft;
  upsertPrompt: (draft: PromptDraft) => string;
  deletePrompt: (id: string) => void;
  duplicatePrompt: (id: string) => string;
  copyPrompt: (id: string) => Promise<void>;
  createCategory: (name: string) => void;
  renameCategory: (id: string, name: string) => void;
  deleteCategory: (id: string) => void;
  exportJson: () => string;
  importJson: (raw: string) => void;
};

const UNCATEGORIZED_ID = "uncategorized";
const STORAGE_KEY = "prompter.prompts.v1";
const QUICK_SAVE_ENABLED_KEY = "prompter.quickSaveEnabled";
const LANGUAGE_KEY = "prompter.language";
const SAVE_DEBOUNCE_MS = 400;
const chromeApi = (globalThis as { chrome?: any }).chrome;
const hasExtensionStorage = Boolean(chromeApi?.storage?.local);
const DEFAULT_UNCATEGORIZED_LABEL = "Bez kategorii";

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
      tags: Array.from(
        new Set((importedPrompt.tags ?? []).map((tag) => tag.trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b, "pl", { sensitivity: "base" }))
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

function useLibrary(language: Language): LibraryApi {
  const [loading, setLoading] = useState(true);
  const [backupPending, setBackupPending] = useState(false);
  const [db, setDb] = useState<DbFile>(() => defaultDb());
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void (async () => {
      const loaded = await loadDb();
      if (!active) return;
      setDb(loaded);
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const timer = window.setTimeout(() => {
      void writeStoredDbRaw(JSON.stringify(db));
    }, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [db, loading]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function commit(mutator: (prev: DbFile) => DbFile, toastMessage?: string) {
    setError(null);
    setDb((prev) => normalizeDb(mutator(prev)));
    setBackupPending(true);
    if (toastMessage) setToast(toastMessage);
  }

  function withValidation(action: () => void) {
    try {
      action();
    } catch (e) {
      const message = e instanceof Error ? e.message : txt(language, "Operacja nie powiodła się", "Operation failed");
      setError(message);
    }
  }

  return {
    loading,
    backupPending,
    db,
    error,
    toast,
    clearError: () => setError(null),
    dismissBackupNotice: () => setBackupPending(false),
    backupNow: async () => {
      const json = JSON.stringify(db, null, 2);

      if (hasExtensionStorage) {
        try {
          chromeApi.runtime?.sendMessage({ type: "BACKUP_NOW", json });
          setBackupPending(false);
          setToast(txt(language, "Backup zapisany do Downloads", "Backup saved to Downloads"));
        } catch {
          setError(txt(language, "Nie udało się utworzyć backupu pliku", "Could not create backup file"));
        }
        return;
      }

      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "prompts-latest.json";
      link.click();
      URL.revokeObjectURL(url);
      setBackupPending(false);
      setToast(txt(language, "Backup pobrany", "Backup downloaded"));
    },
    createPrompt: createDraft,
    upsertPrompt: (draft) => {
      if (!draft.title.trim()) throw new Error(txt(language, "Pole title jest wymagane", "Title is required"));
      if (!draft.categoryId.trim()) throw new Error(txt(language, "Pole categoryId jest wymagane", "Category is required"));
      if (!draft.content.trim()) throw new Error(txt(language, "Pole content jest wymagane", "Content is required"));

      const promptId = draft.id || uuid();
      withValidation(() => {
        commit((prev) => {
          const now = nowIso();
          const categoryId = prev.categories.some((c) => c.id === draft.categoryId)
            ? draft.categoryId
            : UNCATEGORIZED_ID;
          const tags = Array.from(new Set(draft.tags.map((tag) => tag.trim()).filter(Boolean))).sort(
            (a, b) => a.localeCompare(b, "pl", { sensitivity: "base" })
          );

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
                favorite: draft.favorite,
                createdAt: now,
                updatedAt: now,
                lastUsedAt: null
              }
            ]
          };
        }, txt(language, "Zapisano", "Saved"))
      });

      return promptId;
    },
    deletePrompt: (id) => {
      withValidation(() => {
        commit(
          (prev) => ({
            ...prev,
            prompts: prev.prompts.filter((p) => p.id !== id)
          }),
          txt(language, "Usunięto prompt", "Prompt deleted")
        );
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
      const prompt = db.prompts.find((p) => p.id === id);
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
    exportJson: () => JSON.stringify(db, null, 2),
    importJson: (raw) => {
      withValidation(() => {
        const parsed = JSON.parse(raw) as DbFile;
        const normalizedImported = normalizeDb(parsed);
        commit((prev) => mergeImported(prev, normalizedImported), txt(language, "Zaimportowano dane", "Imported data"));
      });
    }
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const cmd = event.metaKey || event.ctrlKey;
      if (!cmd) return;

      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        navigate("create");
      }
      if (event.key === "Enter" && selectedPromptId) {
        event.preventDefault();
        void lib.copyPrompt(selectedPromptId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lib, navigate, selectedPromptId]);

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
      const inTags = selectedTags.every((tag) => prompt.tags.includes(tag));
      return inSearch && inCategory && inFavorite && inTags;
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
  }, [favoriteOnly, locale, prompts, search, selectedCategory, selectedTags, sortMode]);

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
          <button className={favoriteOnly ? "ghost active-filter" : "ghost"} onClick={() => setFavoriteOnly((v) => !v)}>
            ⭐ {isPl ? "Ulubione" : "Favorites"}
          </button>
          <button onClick={() => navigate("create")}>{isPl ? "+ Dodaj prompt" : "+ Add prompt"}</button>
        </div>
      </section>

      <section className="library-toolbar">
        <input
          ref={searchRef}
          className="library-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isPl ? "Szukaj promptów... (Ctrl/Cmd+K)" : "Search prompts... (Ctrl/Cmd+K)"}
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
            <div className="row-between">
              <h3>{prompt.title}</h3>
              {prompt.favorite ? <span>⭐</span> : null}
            </div>
            <div className="tag-cloud">
              <span className="chip">
                {prompt.categoryId === UNCATEGORIZED_ID
                  ? (isPl ? "Bez kategorii" : "Uncategorized")
                  : (categoryMap.get(prompt.categoryId) ?? (isPl ? "Bez kategorii" : "Uncategorized"))}
              </span>
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
              <h2>{selectedPrompt.title}</h2>
              <button className="ghost" onClick={() => setSelectedPromptId(null)}>{isPl ? "Zamknij" : "Close"}</button>
            </div>

            <div className="tag-cloud">
              <span className="chip">
                {selectedPrompt.categoryId === UNCATEGORIZED_ID
                  ? (isPl ? "Bez kategorii" : "Uncategorized")
                  : (categoryMap.get(selectedPrompt.categoryId) ?? (isPl ? "Bez kategorii" : "Uncategorized"))}
              </span>
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
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const category of lib.db.categories) map.set(category.id, 0);
    for (const prompt of lib.db.prompts) {
      map.set(prompt.categoryId, (map.get(prompt.categoryId) || 0) + 1);
    }
    return map;
  }, [lib.db.categories, lib.db.prompts]);

  return (
    <div className="surface">
      <div className="section-title-row">
        <h2>{isPl ? "Zarządzanie kategoriami" : "Manage categories"}</h2>
        <div className="row-gap">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={isPl ? "Nowa kategoria" : "New category"} />
          <button onClick={() => { lib.createCategory(newName); setNewName(""); }}>{isPl ? "Dodaj" : "Add"}</button>
        </div>
      </div>

      <div className="category-grid">
        {lib.db.categories.map((category) => (
          <article key={category.id} className="category-card">
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
      </div>
    </div>
  );
}

function DataPage({ lib, language }: { lib: LibraryApi; language: Language }) {
  const isPl = language === "pl";
  const fileRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<DbFile | null>(null);
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

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

  const existingIds = useMemo(
    () => new Set(lib.db.prompts.map((prompt) => prompt.id)),
    [lib.db.prompts]
  );

  const selectedCount = selectedImportIds.length;
  const previewCount = importPreview?.prompts.length ?? 0;

  return (
    <div className="data-layout">
      <section className="surface">
        <h2>{isPl ? "Import / Eksport" : "Import / Export"}</h2>
        <p>
          {isPl
            ? "Export zapisuje pełny JSON biblioteki. Import scala dane: aktualizuje prompty o tym samym `id`, tworzy brakujące i dopasowuje kategorie po `id` i nazwie."
            : "Export saves the full library JSON. Import merges data: updates prompts with the same `id`, creates missing ones, and matches categories by `id` and name."}
        </p>
        <div className="row-gap">
          <button onClick={downloadExport}>{isPl ? "Eksport JSON" : "Export JSON"}</button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>{isPl ? "Import JSON" : "Import JSON"}</button>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFileImport} hidden />
        </div>
        {importError ? <p className="import-error">{importError}</p> : null}
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

      <section className="surface">
        <h2>{isPl ? "Jak działa import" : "How import works"}</h2>
        <ul className="stats-list">
          <li>{isPl ? "wybierasz plik," : "choose a file,"}</li>
          <li>{isPl ? "zaznaczasz prompty do dociągnięcia," : "select prompts to import,"}</li>
          <li>{isPl ? "importuje tylko zaznaczone rekordy." : "only selected records are imported."}</li>
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

      <section className="surface">
        <h2>{isPl ? "Skróty klawiszowe" : "Keyboard shortcuts"}</h2>
        <ul className="stats-list">
          <li>{isPl ? "Ctrl/Cmd + K: fokus na wyszukiwarce (na stronie promptów)" : "Ctrl/Cmd + K: focus search (on prompts page)"}</li>
          <li>{isPl ? "Ctrl/Cmd + N: nowy prompt (na stronie promptów)" : "Ctrl/Cmd + N: new prompt (on prompts page)"}</li>
          <li>{isPl ? "Ctrl/Cmd + Enter: kopiuj aktualny prompt (na stronie promptów)" : "Ctrl/Cmd + Enter: copy current prompt (on prompts page)"}</li>
        </ul>
      </section>
    </div>
  );
}

function SettingsPage({
  language,
  onLanguageChange,
  quickSaveEnabled,
  onQuickSaveToggle
}: {
  language: Language;
  onLanguageChange: (next: Language) => void;
  quickSaveEnabled: boolean;
  onQuickSaveToggle: (next: boolean) => Promise<void>;
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
    </div>
  );
}

function App() {
  const [language, setLanguage] = useLanguage();
  const { quickSaveEnabled, updateQuickSaveEnabled } = useQuickSaveSetting();
  const lib = useLibrary(language);
  const { route, navigate } = useRouteState();
  const [backupNoticeOpen, setBackupNoticeOpen] = useState(false);
  const isPl = language === "pl";

  useEffect(() => {
    if (!lib.backupPending) {
      setBackupNoticeOpen(false);
    }
  }, [lib.backupPending]);

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

        {lib.backupPending ? (
          <div className="backup-notice" onClick={() => setBackupNoticeOpen((prev) => !prev)}>
            <div>
              <strong>
                {isPl ? "Masz niezbackupowane zmiany." : "You have unbacked-up changes."}
              </strong>
              <span>
                {isPl ? "Kliknij, aby zapisać plik backupu JSON." : "Click to save a JSON backup file."}
              </span>
            </div>
            {backupNoticeOpen ? (
              <div className="backup-actions" onClick={(event) => event.stopPropagation()}>
                <button className="ghost" onClick={() => void lib.backupNow()}>
                  {isPl ? "Pobierz backup (nadpisz stary)" : "Download backup (overwrite old)"}
                </button>
                <button className="ghost" onClick={lib.dismissBackupNotice}>
                  {isPl ? "Ukryj" : "Hide"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

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
        {route.page === "data" ? <DataPage lib={lib} language={language} /> : null}
        {route.page === "settings" ? (
          <SettingsPage
            language={language}
            onLanguageChange={setLanguage}
            quickSaveEnabled={quickSaveEnabled}
            onQuickSaveToggle={updateQuickSaveEnabled}
          />
        ) : null}
      </section>

      {lib.toast ? <div className="toast">{lib.toast}</div> : null}
    </div>
  );
}

export default App;
