let currentMode = "highlight";

chrome.storage.onChanged.addListener((changes) => {
  if (changes.slopMode) {
    currentMode = changes.slopMode.newValue;
  }
});

const memoryCache = new Map();

const checkUrlForSlop = async (appId) => {
  if (memoryCache.has(appId)) return memoryCache.get(appId);
  try {
    const response = await fetch(
      `https://store.steampowered.com/app/${appId}/`
    );
    const text = await response.text();
    const isSlop = text.includes("AI Generated Content Disclosure");
    memoryCache.set(appId, isSlop);
    return isSlop;
  } catch (e) {
    return false;
  }
};

const applySlopStyle = (rowElement, mode) => {
  const title = rowElement.querySelector(".title");

  if (mode === "hide") {
    rowElement.style.display = "none";
    return;
  }

  // Common badge logic
  if (title && !title.querySelector(".slop-badge")) {
    const badge = document.createElement("span");
    badge.className = "slop-badge";
    badge.innerText = " [AI CONTENT USED]";
    badge.style.fontWeight = "bold";
    badge.style.fontSize = "12px";
    badge.style.marginLeft = "10px";

    if (mode === "highlight") {
      badge.style.color = "#ff4444";
    } else {
      badge.style.color = "#888"; // subtler for text mode
    }
    title.appendChild(badge);
  }

  if (mode === "highlight") {
    rowElement.style.border = "2px solid #ff0000";
    rowElement.style.background = "rgba(50, 0, 0, 0.8)";
  }
};

const markSearchResult = (rowElement) => {
  if (rowElement.dataset.slopChecked) return;
  rowElement.dataset.slopChecked = "true";

  const appId = rowElement.dataset.dsAppid;
  if (!appId) return;

  checkUrlForSlop(appId).then((isSlop) => {
    if (isSlop) {
      applySlopStyle(rowElement, currentMode);
    }
  });
};

const handleStorePage = () => {
  if (document.getElementById("slop-warning-banner")) return;

  const disclosureDivs = document.querySelectorAll(
    "#game_area_content_descriptors"
  );

  for (const disclosureDiv of disclosureDivs) {
    const headers = Array.from(disclosureDiv.querySelectorAll("h2"));
    
    const aiHeader = headers.find((h) =>
      h.textContent.includes("AI Generated Content Disclosure")
    );

    if (aiHeader) {
      //console.log("Found AI content disclosure");
      if (currentMode === "hide") {
      }

      let details = "Unknown usage";
      let sibling = aiHeader.nextElementSibling;
      while (sibling && sibling.tagName !== "H2") {
        const iTag =
          sibling.tagName === "I" ? sibling : sibling.querySelector("i");
        if (iTag) {
          details = iTag.textContent.trim();
          break;
        }
        sibling = sibling.nextElementSibling;
      }

      const targetContainer = document.getElementById(
        "responsive_apppage_details_left_ctn"
      );
      if (targetContainer) {
        const banner = document.createElement("div");
        banner.id = "slop-warning-banner";

        banner.innerHTML = `<div style="font-size: 16px; color: #ff4444; margin-bottom: 5px;">AI Disclosure</div><div style="font-size: 13px;">${details}</div>`;
        Object.assign(banner.style, {
          background: "linear-gradient( 90deg, rgba(0,0,0,0.5) 5%,rgba(0,0,0,0.65) 95%)",
          border: "1px solid #ff4444",
          padding: "16px",
          marginBottom: "8px",
          color: "#c6d4df",
        });
        targetContainer.prepend(banner);
        return;
      }
    }
  }
};

const initSearchPageObserver = () => {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          markSearchResult(entry.target);
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "200px" }
  );

  const listObserver = new MutationObserver(() => {
    document
      .querySelectorAll(".search_result_row:not([data-slop-checked])")
      .forEach((row) => {
        observer.observe(row);
      });
  });

  const searchContainer = document.getElementById("search_results");
  if (searchContainer) {
    listObserver.observe(searchContainer, { childList: true, subtree: true });
  }

  document
    .querySelectorAll(".search_result_row")
    .forEach((row) => observer.observe(row));
};

chrome.storage.sync.get(["slopMode"], (res) => {
  if (res.slopMode) currentMode = res.slopMode;
console.log("Slop mode set to:", currentMode);
console.log("Current URL:", window.location.href);
  if (window.location.href.includes("/app/")) {
    handleStorePage();
    const observer = new MutationObserver(() => handleStorePage());
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  } else if (window.location.href.includes("/search")) {
    initSearchPageObserver();
  }
});
