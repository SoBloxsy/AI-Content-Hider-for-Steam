// #a30100 red used in the logo
// #00a357 

console.log( '%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;', '', "Content script loaded." );

let currentMode = "text";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
let flaggedCount = 0;

chrome.storage.onChanged.addListener((changes) => {
  if (changes.filterMode) {
    currentMode = changes.filterMode.newValue;

    // Re-apply styles for already-checked items when mode changes
    if (window.location.href.includes("/wishlist/")) {
      document
        .querySelectorAll('[data-slop-checked="true"]')
        .forEach((row) => {
          const appId = row.dataset.dsAppid;
          if (appId && memoryCache.get(appId)?.value) {
            applySlopStyleWishlist(row, currentMode);
          }
        });
    }
  }
});

const memoryCache = new Map();

const checkUrlForSlop = async (appId) => {
  if (memoryCache.has(appId)) {
    const entry = memoryCache.get(appId);
    if (entry.ts && (Date.now() - entry.ts > CACHE_TTL)) {
      memoryCache.delete(appId);
    } else {
      return entry.value;
    }
  }

  const storageKey = `slop_cache_${appId}`;
  const cached = await new Promise((resolve) =>
    chrome.storage.local.get([storageKey], (res) => {
      if (chrome.runtime.lastError) {
        console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;', '', 'Storage error:', chrome.runtime.lastError.message);
        resolve(undefined);
        return;
      }
      resolve((res || {})[storageKey]);
    }),
  );

  if (cached !== undefined) {
   
    const entry = typeof cached === 'object' && cached !== null
      ? cached
      : { value: cached, ts: 0 };

    if (entry.ts && (Date.now() - entry.ts <= CACHE_TTL)) {
      memoryCache.set(appId, entry);
      console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;','',`AppID ${appId} UseAI:`, entry.value);
      return entry.value;
    }

  }

  try {
    const response = await fetch(
      `https://store.steampowered.com/app/${appId}/`,
    );
    const text = await response.text();
    const isSlop = text.includes("AI Generated Content Disclosure");
    const entry = { value: isSlop, ts: Date.now() };
    memoryCache.set(appId, entry);
    console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;','',`AppID ${appId} UseAI:`, isSlop);
    chrome.storage.local.set({ [storageKey]: entry });

    // Track stats
    chrome.runtime.sendMessage({
      type: 'incrementStats',
      checked: 1,
      flagged: isSlop ? 1 : 0,
    });

    return isSlop;
  } catch (e) {
    return false;
  }
};

const applySlopStyle = (rowElement, mode) => {
  const title =
    rowElement.querySelector(".title") ||
    rowElement.querySelector(".tab_item_name") ||
    rowElement.querySelector(".tab_item_title") ||
    rowElement.querySelector(".match_name") ||
    rowElement.querySelector(".name");

  rowElement.style.display = "";

  if (mode === "hide") {
    rowElement.style.display = "none";
    return;
  }

  // Common badge logic
  let badge = rowElement.querySelector(".slop-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "slop-badge";
    badge.innerText = " [AI CONTENT USED]";
    badge.style.fontWeight = "bold";
    badge.style.fontSize = "12px";

    if (title) {
      title.style.overflow = "visible";
      title.style.whiteSpace = "normal";
      badge.style.marginLeft = "10px";
      title.appendChild(badge);
    } else {
      badge.style.display = "block";
      badge.style.textAlign = "center";
      badge.style.width = "100%";
      badge.style.backgroundColor = "rgba(0,0,0,0.8)";
      badge.style.position = "absolute";
      badge.style.bottom = "0";
      badge.style.left = "0";
      badge.style.zIndex = "10";
      
      const imgCtn = rowElement.querySelector(".capsule_image_ctn");
      if (imgCtn) {
        imgCtn.style.position = "relative";
        imgCtn.appendChild(badge);
      } else {
        rowElement.style.position = "relative";
        rowElement.appendChild(badge);
      }
    }
  }

  if (badge) {
    if (mode === "highlight") {
      badge.style.color = "#a30100";
    } else {
      badge.style.color = "#888"; 
    }
  }

  if (mode === "highlight") {
    rowElement.style.border = "2px solid #a30100";
    rowElement.style.setProperty(
      "background",
      "rgba(50, 0, 0, 0.8)",
      "important",
    );
  } else {
    rowElement.style.border = "";
    rowElement.style.removeProperty("background");
  }
};

// Wishlist items use obfuscated class names, so we find the title anchor
// by looking for links whose href contains /app/. The first such link with
// text content is treated as the title element.
const applySlopStyleWishlist = (rowElement, mode) => {
  rowElement.style.display = "";

  // "hide" mode falls through to highlight on the wishlist page
  // because display:none breaks the wishlist layout
  const effectiveMode = mode === "hide" ? "highlight" : mode;

  let badge = rowElement.querySelector(".slop-badge");
  if (!badge) {
    badge = document.createElement("a");
    badge.className = "slop-badge";
    badge.textContent = "AI Content Used";
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    // Style as a pill badge matching the "Demo Available" tag
    Object.assign(badge.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "2px 6px",
      borderRadius: "2px",
      fontSize: "11px",
      fontWeight: "bold",
      lineHeight: "normal",
      textDecoration: "none",
      cursor: "default",
      whiteSpace: "nowrap",
      alignSelf: "stretch",
    });

    // Place above the "Add to Cart" button
    const buttons = rowElement.querySelectorAll('button');
    let cartButton = null;
    for (const btn of buttons) {
      if (btn.textContent.trim() === "Add to Cart") {
        cartButton = btn;
        break;
      }
    }

    if (cartButton) {
      // Insert before the button's parent div (the cart button container)
      const cartContainer = cartButton.parentElement;
      cartContainer.parentElement.insertBefore(badge, cartContainer);
    } else {
      // Fallback: append to the row
      rowElement.appendChild(badge);
    }
  }

  if (badge) {
    if (effectiveMode === "highlight") {
      badge.style.backgroundColor = "#a30100";
      badge.style.color = "#fff";
      badge.style.border = "1px solid #a30100";
    } else {
      badge.style.backgroundColor = "rgba(255,255,255,0.1)";
      badge.style.color = "#c7d5e0";
      badge.style.border = "1px solid rgba(255,255,255,0.2)";
    }
  }

  if (effectiveMode === "highlight") {
    rowElement.style.border = "2px solid #a30100";
    rowElement.style.setProperty(
      "background",
      "rgba(50, 0, 0, 0.8)",
      "important",
    );
  } else {
    rowElement.style.border = "";
    rowElement.style.removeProperty("background");
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
      flaggedCount++;
      chrome.runtime.sendMessage({ type: 'updateBadge', count: flaggedCount });
    }
  });
};

const handleStorePage = () => {
  if (document.getElementById("slop-warning-banner")) return;

  const disclosureDivs = document.querySelectorAll(
    "#game_area_content_descriptors",
  );

  for (const disclosureDiv of disclosureDivs) {
    const headers = Array.from(disclosureDiv.querySelectorAll("h2"));

    const aiHeader = headers.find((h) =>
      h.textContent.includes("AI Generated Content Disclosure"),
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
        "responsive_apppage_details_left_ctn",
      );
      if (targetContainer) {
        const banner = document.createElement("div");
        banner.id = "slop-warning-banner";

        banner.innerHTML = `<img src="${chrome.runtime.getURL(
          "icons/iconsvg.svg",
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

      
        chrome.runtime.sendMessage({ type: 'updateBadge', count: 1 });
        chrome.runtime.sendMessage({
          type: 'incrementStats',
          checked: 1,
          flagged: 1,
        });

        return;
      }
    }/* else {
      //shows a banner saying no AI content detected

      let details = "No AI content usage";

      const targetContainer = document.getElementById(
        "responsive_apppage_details_left_ctn",
      );
      if (targetContainer) {
        const banner = document.createElement("div");
        banner.id = "slop-warning-banner";

        banner.innerHTML = `<img src="${chrome.runtime.getURL(
          "icons/iconsvg.svg",
        )}" style="width: 32px; height: 32px; float: right; margin-left: 10px; margin-bottom: 5px;"><div style="font-size: 16px; color: #00a357; margin-bottom: 5px;">AI Disclosure</div><div style="font-size: 13px;">${details}</div>`;
        Object.assign(banner.style, {
          background:
            "linear-gradient( 90deg, rgba(0,0,0,0.5) 5%,rgba(0,0,0,0.65) 95%)",
          border: "1px solid #00a357",
          padding: "16px",
          marginBottom: "8px",
          color: "#c6d4df",
        });
        targetContainer.prepend(banner);
        return;
      }
        
    }*/
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
    { rootMargin: "200px" },
  );

  const listObserver = new MutationObserver(() => {
    document
      .querySelectorAll(
        ".search_result_row:not([data-slop-checked]), .tab_item:not([data-slop-checked]), .tab_row_item:not([data-slop-checked]), .sale_capsule:not([data-slop-checked]), [data-ds-appid]:not([data-slop-checked])",
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
    .querySelectorAll(".search_result_row, .tab_item, .tab_row_item, .sale_capsule, [data-ds-appid]")
    .forEach((row) => observer.observe(row));
};

const addfilterModePanel = () => {
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
    '{"focusable":true,"clickOnActivate":true}',
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
      '{"focusable":true,"clickOnActivate":true}',
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
      chrome.storage.sync.set({ filterMode: mode.value }, () => {
        if (chrome.runtime.lastError) {
          console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;', '', 'Error saving mode:', chrome.runtime.lastError.message);
          return;
        }
        currentMode = mode.value;

        const panel = document.getElementById("slop-mode-filter");
        if (panel) {
          panel
            .querySelectorAll(".tab_filter_control_row, .tab_filter_control")
            .forEach((el) => {
              el.classList.toggle("checked", el.dataset.value === currentMode);
            });
        }

        document
          .querySelectorAll('[data-slop-checked="true"]')
          .forEach((row) => {
            const appId = row.dataset.dsAppid;
            if (appId && memoryCache.get(appId)?.value) {
              applySlopStyle(row, currentMode);
            }
          });
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
    addfilterModePanel();
    const observer = new MutationObserver(() => {
      if (!document.getElementById("slop-mode-filter")) {
        addfilterModePanel();
      }
    });
    observer.observe(optionsContainer, { childList: true, subtree: true });
  }
};

// --- Wishlist page support ---

// Extract the app ID from an href like /app/612470/Bio_Inc_Redemption
const extractAppIdFromHref = (href) => {
  const match = href && href.match(/\/app\/(\d+)/);
  return match ? match[1] : null;
};

// Find all wishlist item containers on the page.
// Wishlist items are div[role="button"][tabindex="0"] containers that
// contain at least one anchor linking to /app/. This avoids relying on
// obfuscated class names.
const getWishlistItems = () => {
  const candidates = document.querySelectorAll('div[role="button"][tabindex="0"]');
  const items = [];
  candidates.forEach((el) => {
    const link = el.querySelector('a[href*="/app/"]');
    if (link && extractAppIdFromHref(link.href)) {
      items.push(el);
    }
  });
  return items;
};

const markWishlistItem = (rowElement) => {
  if (rowElement.dataset.slopChecked) return;
  rowElement.dataset.slopChecked = "true";

  const link = rowElement.querySelector('a[href*="/app/"]');
  const appId = link ? extractAppIdFromHref(link.href) : null;
  if (!appId) return;

  // Store appId on the element so we can re-apply styles on mode change
  rowElement.dataset.dsAppid = appId;

  checkUrlForSlop(appId).then((isSlop) => {
    if (isSlop) {
      applySlopStyleWishlist(rowElement, currentMode);
      flaggedCount++;
      chrome.runtime.sendMessage({ type: 'updateBadge', count: flaggedCount });
    }
  });
};

const initWishlistObserver = () => {
  console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;', '', 'Wishlist page detected, initializing observer.');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          markWishlistItem(entry.target);
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "200px" },
  );

  // Observe existing items
  getWishlistItems().forEach((item) => observer.observe(item));

  // Watch for dynamically added items (wishlist lazy-loads on scroll)
  const listObserver = new MutationObserver(() => {
    getWishlistItems().forEach((item) => {
      if (!item.dataset.slopChecked) {
        observer.observe(item);
      }
    });
  });

  listObserver.observe(document.body, { childList: true, subtree: true });
};

// --- Main initialization ---

chrome.storage.sync.get(['filterMode'], (res) => {
  if (chrome.runtime.lastError) {
    console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;', '', 'Error loading settings:', chrome.runtime.lastError.message);
  }
  if (res.filterMode) currentMode = res.filterMode;
  console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;', '',"Slop mode set to:", currentMode);
  console.log('%c[AI Disclosure]%c', 'color:#a30100; font-weight:bold;', '',"Current URL:", window.location.href);
  if (window.location.href.includes("/app/")) {
    handleStorePage();
    const observer = new MutationObserver(() => handleStorePage());
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  } else if (window.location.href.includes("/wishlist/")) {
    initWishlistObserver();
  } else {
    initSearchPageObserver();
    observeAdditionalOptions();
  }
});

