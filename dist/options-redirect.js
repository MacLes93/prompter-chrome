(() => {
  const target = chrome.runtime.getURL("index.html#data");
  const fallback = document.getElementById("fallback");
  if (fallback) {
    fallback.setAttribute("href", target);
  }

  window.location.replace(target);
})();
