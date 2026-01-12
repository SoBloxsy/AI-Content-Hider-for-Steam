// #a30100 is the red used in the logo
let currentMode = "highlight";

chrome.storage.onChanged.addListener((changes) => {
  if (changes.slopMode) {
    currentMode = changes.slopMode.newValue;
  }
});

const memoryCache = new Map();

const checkUrlForSlop = async (appId) => {
  if (memoryCache.has(appId)) return memoryCache.get(appId);

  const storageKey = `slop_cache_${appId}`;
  const cached = await new Promise((resolve) =>
    chrome.storage.local.get([storageKey], (res) =>
      resolve((res || {})[storageKey])
    )
  );
  if (cached !== undefined) {
    memoryCache.set(appId, cached);
    console.log(`AppID ${appId} isSlop:`, cached);
    return cached;
  }

  try {
    const response = await fetch(
      `https://store.steampowered.com/app/${appId}/`
    );
    const text = await response.text();
    const isSlop = text.includes("AI Generated Content Disclosure");
    memoryCache.set(appId, isSlop);
    console.log(`AppID ${appId} isSlop:`, isSlop);
    chrome.storage.local.set({ [storageKey]: isSlop });
    return isSlop;
  } catch (e) {
    return false;
  }
};

const applySlopStyle = (rowElement, mode) => {
  const title =
    rowElement.querySelector(".title") ||
    rowElement.querySelector(".tab_item_name") ||
    rowElement.querySelector(".match_name") ||
    rowElement.querySelector(".name");

  if (mode === "hide") {
    rowElement.style.display = "none";
    return;
  }

  // Common badge logic
  if (title && !title.querySelector(".slop-badge")) {
    title.style.overflow = "visible";
    title.style.whiteSpace = "normal";

    const badge = document.createElement("span");
    badge.className = "slop-badge";
    badge.innerText = " [AI CONTENT USED]";
    badge.style.fontWeight = "bold";
    badge.style.fontSize = "12px";
    badge.style.marginLeft = "10px";

    if (mode === "highlight") {
      badge.style.color = "#a30100";
    } else {
      badge.style.color = "#888"; // subtler for text mode
    }
    title.appendChild(badge);
  }

  if (mode === "highlight") {
    rowElement.style.border = "2px solid #a30100";
    rowElement.style.setProperty(
      "background",
      "rgba(50, 0, 0, 0.8)",
      "important"
    );
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

        banner.innerHTML = `<img src="${chrome.runtime.getURL(
          "icons/iconsvg.svg"
        )}" style="width: 32px; height: 32px; float: right; margin-left: 10px; margin-bottom: 5px;"><div style="font-size: 16px; color: #a30100; margin-bottom: 5px;">AI Disclosure</div><div style="font-size: 13px;">${details}</div>`;
        Object.assign(banner.style, {
          background:
            "linear-gradient( 90deg, rgba(0,0,0,0.5) 5%,rgba(0,0,0,0.65) 95%)",
          border: "1px solid #a30100",
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
      .querySelectorAll(
        ".search_result_row:not([data-slop-checked]), .tab_item:not([data-slop-checked])"
      )
      .forEach((row) => {
        observer.observe(row);
      });
  });

  const searchContainer = document.getElementById("search_results");
  const targetNode = searchContainer || document.body;
  if (targetNode) {
    listObserver.observe(targetNode, { childList: true, subtree: true });
  }

  document
    .querySelectorAll(".search_result_row, .tab_item")
    .forEach((row) => observer.observe(row));
};

const addSlopModePanel = () => {
  const optionsContainer = document.getElementById("additional_search_options");
  if (!optionsContainer || document.getElementById("slop-mode-filter")) return;

  const modes = [
    { value: "hide", label: "Hide AI content" },
    { value: "highlight", label: "Highlight AI content" },
    { value: "text", label: "Show AI label" },
  ];

  const panelDiv = document.createElement("div");
  panelDiv.className = "block search_collapse_block";
  panelDiv.id = "slop-mode-filter";
  panelDiv.style.position = "relative";
  panelDiv.setAttribute("data-collapse-name", "slop_filter");
  panelDiv.setAttribute("data-gpnav", "rows");
  panelDiv.setAttribute("data-gpfocus", "group");

  const header = document.createElement("div");
  header.setAttribute(
    "data-panel",
    '{"focusable":true,"clickOnActivate":true}'
  );
  header.setAttribute("role", "button");
  header.className = "block_header labs_block_header";
  header.style.position = "relative";
  // const logo = document.createElement("img");
  // logo.src = chrome.runtime.getURL("icons/iconsvg.svg");
  // logo.style.width = "24px";
  // logo.style.height = "24px";
  // logo.style.position = "absolute";
  // logo.style.right = "1px";
  // logo.style.top = "50%";
  // logo.style.transform = "translateY(-50%)";
  // header.appendChild(logo);
  // might add logo later
  const headerText = document.createElement("div");
  headerText.textContent = "Narrow by AI Usage";
  header.appendChild(headerText);

  const content = document.createElement("div");
  content.className = "block_content block_content_inner";

  header.addEventListener("click", () => {
    if (content.style.display === "none") {
      content.style.display = "block";
    } else {
      content.style.display = "none";
    }
  });

  modes.forEach((mode) => {
    const row = document.createElement("div");
    row.className =
      "tab_filter_control_row " + (currentMode === mode.value ? "checked" : "");
    row.setAttribute("data-param", "slop_mode");
    row.setAttribute("data-value", mode.value);
    row.setAttribute("data-clientside", "1");

    const control = document.createElement("span");
    control.setAttribute(
      "data-panel",
      '{"focusable":true,"clickOnActivate":true}'
    );
    control.setAttribute("role", "button");
    control.className =
      "tab_filter_control tab_filter_control_include " +
      (currentMode === mode.value ? "checked" : "");
    control.setAttribute("data-param", "slop_mode");
    control.setAttribute("data-value", mode.value);
    control.setAttribute("data-clientside", "1");
    control.setAttribute("data-gpfocus", "item");

    const labelContainer = document.createElement("span");
    labelContainer.className = "tab_filter_label_container";

    const checkbox = document.createElement("span");
    checkbox.className = "tab_filter_control_checkbox";

    const label = document.createElement("span");
    label.className = "tab_filter_control_label";
    label.textContent = mode.label;

    labelContainer.appendChild(checkbox);
    labelContainer.appendChild(label);
    control.appendChild(labelContainer);
    row.appendChild(control);
    content.appendChild(row);

    control.addEventListener("click", () => {
      chrome.storage.sync.set({ slopMode: mode.value }, () => {
        window.location.reload();
      });
    });
  });

  panelDiv.appendChild(header);
  panelDiv.appendChild(content);

  const children = optionsContainer.children;
  if (children.length >= 2) {
    optionsContainer.insertBefore(panelDiv, children[2]);
  } else {
    optionsContainer.appendChild(panelDiv);
  }
};

const observeAdditionalOptions = () => {
  const optionsContainer = document.getElementById("additional_search_options");
  if (optionsContainer) {
    addSlopModePanel();
    const observer = new MutationObserver(() => {
      if (!document.getElementById("slop-mode-filter")) {
        addSlopModePanel();
      }
    });
    observer.observe(optionsContainer, { childList: true, subtree: true });
  }
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
  } else {
    initSearchPageObserver();
    observeAdditionalOptions();
  }
});
