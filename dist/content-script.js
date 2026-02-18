(() => {
  if (window.__prompterInjected) return;
  window.__prompterInjected = true;

  const ROOT_ID = "prompter-quick-save-root";
  const QUICK_SAVE_ENABLED_KEY = "prompter.quickSaveEnabled";
  const LANGUAGE_KEY = "prompter.language";

  let root = null;
  let panel = null;
  let titleInput = null;
  let contentInput = null;
  let tagsInput = null;
  let launchButton = null;
  let headingEl = null;
  let minimizeButton = null;
  let saveButton = null;
  let cancelButton = null;
  let language = "pl";
  let isOpen = false;

  function t(pl, en) {
    return language === "pl" ? pl : en;
  }

  function getDraftContent() {
    const selected = window.getSelection()?.toString().trim();
    if (selected) return selected;

    const textSelectors = [
      "#prompt-textarea",
      "textarea",
      "form textarea",
      "div[contenteditable='true'][data-placeholder]",
      "div[contenteditable='true']"
    ];

    for (const selector of textSelectors) {
      const el = document.querySelector(selector);
      if (!el) continue;

      if (el instanceof HTMLTextAreaElement) {
        const value = el.value.trim();
        if (value) return value;
      }

      const content = (el.textContent || "").trim();
      if (content) return content;
    }

    return "";
  }

  function makeTitle(content) {
    const firstLine =
      content.split("\n").find((line) => line.trim().length > 0) || t("Nowy prompt", "New prompt");
    const clean = firstLine.trim();
    return clean.length > 72 ? `${clean.slice(0, 72)}...` : clean;
  }

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `prompter-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    window.setTimeout(() => {
      toast.classList.add("hide");
      window.setTimeout(() => toast.remove(), 280);
    }, 1800);
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .prompter-fab {
        border: 1px solid #685bff;
        background: linear-gradient(180deg, #6054ff, #4f3fe0);
        color: #eef0ff;
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 8px 22px rgba(25, 21, 88, 0.42);
      }
      .prompter-panel {
        margin-top: 8px;
        width: min(420px, calc(100vw - 32px));
        border: 1px solid #2f3d63;
        background: #0f1a33;
        color: #d8e2ff;
        border-radius: 12px;
        padding: 10px;
        display: none;
        flex-direction: column;
        gap: 8px;
      }
      .prompter-panel.open {
        display: flex;
      }
      .prompter-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .prompter-panel h4 {
        margin: 0;
        font-size: 14px;
      }
      .prompter-panel input,
      .prompter-panel textarea {
        width: 100%;
        border: 1px solid #3a4b73;
        background: #1a2744;
        color: #e4ebff;
        border-radius: 8px;
        padding: 8px 9px;
        font-size: 13px;
        box-sizing: border-box;
      }
      .prompter-panel textarea {
        min-height: 120px;
        resize: vertical;
      }
      .prompter-row {
        display: flex;
        gap: 8px;
      }
      .prompter-row button,
      .prompter-panel-header button {
        border: 1px solid #4c5f8d;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .prompter-row .primary {
        background: #5a4cff;
        color: #edf0ff;
        border-color: #6f64ff;
      }
      .prompter-row .ghost,
      .prompter-panel-header button {
        background: #1a2744;
        color: #d7e2ff;
      }
      .prompter-toast {
        position: fixed;
        right: 18px;
        top: 18px;
        z-index: 2147483647;
        padding: 9px 12px;
        border-radius: 9px;
        border: 1px solid #456081;
        background: #172b4b;
        color: #e3ecff;
        font-size: 12px;
        opacity: 1;
        transition: opacity .25s ease;
      }
      .prompter-toast.error {
        background: #4c1c2d;
        border-color: #8d3a58;
        color: #ffd4df;
      }
      .prompter-toast.hide {
        opacity: 0;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function setPanelOpen(nextOpen) {
    if (!panel) return;
    isOpen = nextOpen;
    panel.classList.toggle("open", nextOpen);
  }

  function closePanel() {
    setPanelOpen(false);
  }

  function openPanel() {
    if (!panel || !titleInput || !contentInput) return;
    const draft = getDraftContent();
    contentInput.value = draft;
    titleInput.value = makeTitle(draft);
    setPanelOpen(true);
    titleInput.focus();
  }

  function togglePanel() {
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function unmountWidget() {
    if (root && root.parentElement) {
      root.parentElement.removeChild(root);
    }
    root = null;
    panel = null;
    titleInput = null;
    contentInput = null;
    tagsInput = null;
    launchButton = null;
    headingEl = null;
    minimizeButton = null;
    saveButton = null;
    cancelButton = null;
    isOpen = false;
  }

  function applyLanguageTexts() {
    if (!launchButton || !headingEl || !minimizeButton || !saveButton || !cancelButton) return;
    if (!titleInput || !contentInput || !tagsInput) return;

    launchButton.textContent = t("+ Zapisz do Prompter", "+ Save to Prompter");
    headingEl.textContent = t("Dodaj prompt z tej rozmowy", "Add prompt from this conversation");
    minimizeButton.title = t("Minimalizuj", "Minimize");
    titleInput.placeholder = t("Tytuł", "Title");
    contentInput.placeholder = t("Treść promptu", "Prompt content");
    tagsInput.placeholder = t("Tagi (oddziel przecinkiem)", "Tags (comma-separated)");
    saveButton.textContent = t("Zapisz do biblioteki", "Save to library");
    cancelButton.textContent = t("Zamknij", "Close");
  }

  function translateRuntimeError(message) {
    const normalized = (message || "").trim().toLowerCase();
    if (!normalized) return t("Błąd zapisu", "Save error");
    if (language === "pl") return message;

    if (normalized === "tytul jest wymagany") return "Title is required";
    if (normalized === "tresc promptu jest wymagana") return "Prompt content is required";
    if (normalized === "blad zapisu") return "Save error";
    return message;
  }

  function mountWidget() {
    if (document.getElementById(ROOT_ID)) return;
    injectStyles();

    root = document.createElement("div");
    root.id = ROOT_ID;

    launchButton = document.createElement("button");
    launchButton.type = "button";
    launchButton.className = "prompter-fab";

    panel = document.createElement("div");
    panel.className = "prompter-panel";

    const header = document.createElement("div");
    header.className = "prompter-panel-header";

    headingEl = document.createElement("h4");

    minimizeButton = document.createElement("button");
    minimizeButton.type = "button";
    minimizeButton.textContent = "_";

    header.append(headingEl, minimizeButton);

    titleInput = document.createElement("input");

    contentInput = document.createElement("textarea");

    tagsInput = document.createElement("input");

    const actions = document.createElement("div");
    actions.className = "prompter-row";

    saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "primary";

    cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "ghost";

    applyLanguageTexts();

    actions.append(saveButton, cancelButton);
    panel.append(header, titleInput, contentInput, tagsInput, actions);

    launchButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePanel();
    });

    minimizeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    });

    cancelButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    });

    saveButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      chrome.runtime.sendMessage(
        {
          type: "SAVE_PROMPT_FROM_PAGE",
          payload: {
            title: titleInput?.value,
            content: contentInput?.value,
            tags: tagsInput?.value,
            source: window.location.hostname
          }
        },
        (response) => {
          if (chrome.runtime.lastError) {
            showToast(t("Nie udało się zapisać promptu", "Failed to save prompt"), "error");
            return;
          }

          if (!response?.ok) {
            showToast(translateRuntimeError(response?.error), "error");
            return;
          }

          showToast(t("Prompt zapisany w Prompter", "Prompt saved in Prompter"));
          closePanel();
          if (tagsInput) tagsInput.value = "";
        }
      );
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closePanel();
      }
    });

    document.addEventListener("click", (event) => {
      if (!isOpen || !root) return;
      const target = event.target;
      if (target instanceof Node && !root.contains(target)) {
        closePanel();
      }
    });

    root.append(launchButton, panel);
    document.body.appendChild(root);
  }

  async function isFeatureEnabled() {
    const result = await chrome.storage.local.get([QUICK_SAVE_ENABLED_KEY]);
    const value = result?.[QUICK_SAVE_ENABLED_KEY];
    return value === undefined ? true : Boolean(value);
  }

  async function loadLanguage() {
    const result = await chrome.storage.local.get([LANGUAGE_KEY]);
    const value = result?.[LANGUAGE_KEY];
    language = value === "en" ? "en" : "pl";
  }

  function listenForSettingChanges() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      if (changes[LANGUAGE_KEY]) {
        const nextLanguage = changes[LANGUAGE_KEY].newValue;
        language = nextLanguage === "en" ? "en" : "pl";
        applyLanguageTexts();
      }

      if (changes[QUICK_SAVE_ENABLED_KEY]) {
        const next = changes[QUICK_SAVE_ENABLED_KEY].newValue;
        const enabled = next === undefined ? true : Boolean(next);
        if (enabled) {
          mountWidget();
          applyLanguageTexts();
        } else {
          unmountWidget();
        }
      }
    });
  }

  async function init() {
    const [enabled] = await Promise.all([isFeatureEnabled(), loadLanguage()]);
    if (enabled) {
      mountWidget();
      applyLanguageTexts();
    }
    listenForSettingChanges();
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        void init();
      },
      { once: true }
    );
  } else {
    void init();
  }
})();
