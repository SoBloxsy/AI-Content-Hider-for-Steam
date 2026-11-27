// Accessible high-visibility theme colors
// Warning Red: #d32f2f (released non-tolerated AI content)
// Accent Blue: #1976d2 (informational / tolerated items)
// Early Access / Pre-Release Purple: #9c27b0 (red + blue blend)

console.log('%c[AI Disclosure]%c', 'color:#d32f2f; font-weight:bold;', '', 'Content script loaded.');

let currentMode = 'text';
let filterSettings = {
  ignoreLocalization: false,
  ignoreCode: false,
  ignoreConceptArt: false,
  ignoreMarketing: false,
  ignoreEarlyAccess: false,
  ignorePreRelease: false,
};

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
let flaggedCount = 0;

// Memory cache stores: { value: boolean, categories: string[], details: string, ts: number }
const memoryCache = new Map();
const inFlightFetches = new Map();

// --- Cache Warm-Up Promise (P1: Eliminates N+1 initial storage IPC queries) ---
let isCacheWarm = false;
let warmResolver = null;
const cacheWarmPromise = new Promise((resolve) => {
  warmResolver = resolve;
});

// Single bulk read on startup to populate memoryCache and batch prune expired entries
chrome.storage.local.get(null, (items) => {
  if (!chrome.runtime.lastError && items) {
    const expiredKeys = [];
    const now = Date.now();
    for (const [key, val] of Object.entries(items)) {
      if (key.startsWith('slop_cache_v3_') && val) {
        const appId = key.slice(14);
        if (val.ts && now - val.ts > CACHE_TTL) {
          expiredKeys.push(key);
        } else if (typeof val.isEarlyAccess === 'boolean') {
          memoryCache.set(appId, val);
        }
      }
    }
    if (expiredKeys.length > 0) {
      chrome.storage.local.remove(expiredKeys);
    }
  }
  isCacheWarm = true;
  if (warmResolver) warmResolver();
});

// Current page AppID if on a store page (e.g. /app/4262460/)
const getCurrentPageAppId = () => {
  const match = window.location.pathname.match(/\/app\/(\d+)/);
  return match ? match[1] : null;
};
const currentPageAppId = getCurrentPageAppId();

// --- Request Queue & Concurrency Limiter ---
const MAX_CONCURRENT_FETCHES = 10;
let activeFetches = 0;
const fetchQueue = [];

const processQueue = () => {
  while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
    const { task, resolve, reject } = fetchQueue.shift();
    activeFetches++;
    task()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeFetches--;
        processQueue();
      });
  }
};

const enqueueFetch = (task) => {
  return new Promise((resolve, reject) => {
    fetchQueue.push({ task, resolve, reject });
    processQueue();
  });
};

// --- Category Patterns & Classification Engine ---
const CATEGORY_PATTERNS = {
  localization: /(?:\b(?:translat|localis|localiz|subtitl|multilingual|language|deepl|grammat(?:ic)?|grammar)\w*\b|翻译|本地化|翻訳|ローカライズ|번역|현지화)/i,
  art_in_game: /(?:\b(?:art|artwork|texture|sprite|illustration|portrait|backgrounds?(?!\s+(?:music|audio|sound|track|score|ambience|noise|story|lore|history))|backdrop|3d\s*model|character\s*model|character\s*design|key\s*art|cg|image|imagery|wallpaper|visual|animation|cutscene|icon|painting|poster|cinematic|video|upscal|card\s*design|render|asset|(?:hand-)?drawn|drawing|midjourney|stable\s*diffusion|dall-?e|firefly|leonardo|flux|sora|kling|runway|meshy|tripo|comfyui|imagen|text-to-image|image-to-image|img2img)\w*\b|立绘|美术|插画|图片|画像|イラスト|立ち絵|背景|이미지|일러스트)/i,
  concept_art: /\b(concept\s*art|early\s*concept|ideat\w*|brainstorm\w*|pre-production|in-dev|early\s*dev\w*|prototyp\w*|inspiration|moodboard|reference\s*(only|image|material)?|placeholder|not\s*(used\s*in|in)\s*(the\s*)?(final\s*)?game|replaced\s*(in|with|for)\s*(the\s*)?(final\s*)?game)\b/i,
  audio_music: /(?:\b(?:voice|audio|music|musical|bgm|soundtrack|sound|sfx|voiceover|voice\s*acting|voice\s*line|\bvo\b|dubbing|narration|narrator|speech|tts|text-to-speech|vocal|song|track|jingle|instrumental|spoken|elevenlabs|suno|udio|aiva)\w*\b|音乐|音效|配音|语音|音楽|効果音|音声|보이스|음악|효과음)/i,
  live_generation: /\b(during\s+(game)?play|real-time|in\s+real\s+time|on\s+the\s+fly|live-generate|dynamic(ally)?\s+generate|chatbot|llm|interrogat|conversation|respond|response|tailored\s+to\s+player|player\s+input|talk\s+(to|with))\w*\b/i,
  code: /\b(code|coding|programming|copilot|scripting|mechanic)\w*\b/i,
  text_narrative: /\b(story|dialog(ue)?|script|writing|scenario|monologue|narrative|lore|quest|text-generate|generated\s+text)\w*\b/i,
  marketing: /\b(store\s*page|trailer|capsule|promotional|banner|marketing)\w*\b/i,
};

const CLAUSE_SPLIT_REGEX =
  /[.!?;:\n。！？；]+|,?\s+\b(?:but|however|whereas)\b\s+|,\s*\bwhile\b\s+|,\s*(?=(?:and\s+|while\s+)?(?:no|not|none|nothing|neither|zero)\b)/i;
const DENY_REGEX =
  /(?:\b(?:no|never|not|without|neither|none|nothing|zero)\b|n't\b|不使用|未使用|没有使用|使用していません|사용하지)/i;
const AI_MENTION_REGEX =
  /(?:\b(?:ai|a\.i\.|artificial\s*intelligence|genai|generative|midjourney|stable\s*diffusion|dall-?e|firefly|leonardo|flux|sora|kling|runway|meshy|tripo|comfyui|suno|udio|elevenlabs)\b|生成|ＡＩ|人工智能)/i;
const POSITIVE_USAGE_REGEX =
  /(?:\b(?:used|uses|using|utiliz\w*|generat\w*|creat\w*|made|assist\w*|employ\w*|powered\s+by|built\s+with|talking\s+(?:to|with)|interact\w*\s+with|running)\b|使用|生成|采用)/i;
const DIRECT_AI_NEGATION_REGEX =
  /(?:\b(?:no|none)\s+(?:[a-z]+\s+){0,2}(?:generative\s+)?(?:ai|a\.i\.|artificial\s+intelligence)\b|\b(?:not|never|without)\s+(?:be(?:en)?\s+)?(?:us(?:e|ed|ing)|utiliz\w*|generat\w*|creat\w*|made|assist\w*)\b|n't\s+(?:be(?:en)?\s+)?(?:us(?:e|ed|ing)|utiliz\w*|generat\w*|creat\w*|made)\b|不使用|未使用|没有使用|使用していません|사용하지)/i;

// Pre-compiled global regular expressions (P3: Eliminates dynamic RegExp allocation overhead)
const CATEGORY_PATTERNS_GLOBAL = {};
for (const [cat, regex] of Object.entries(CATEGORY_PATTERNS)) {
  CATEGORY_PATTERNS_GLOBAL[cat] = new RegExp(regex.source, 'gi');
}
const CLAUSE_SPLIT_GLOBAL = new RegExp(CLAUSE_SPLIT_REGEX.source, 'gi');
const DENY_GLOBAL = new RegExp(DENY_REGEX.source, 'gi');

const classifyAiDisclosure = (text) => {
  if (!text) {
    return {
      value: false,
      categories: [],
      details: '',
    };
  }

  const detected = [];
  const lowerText = text.toLowerCase();

  for (const [cat, globalRegex] of Object.entries(CATEGORY_PATTERNS_GLOBAL)) {
    globalRegex.lastIndex = 0;
    let match;
    let matched = false;

    while ((match = globalRegex.exec(text)) !== null) {
      const idx = match.index;
      const matchedWord = match[0].toLowerCase();

      // Disambiguation: 'model' in AI context means Machine Learning Model (LLM/SLM), NOT 3D art
      if (cat === 'art_in_game' && (matchedWord === 'model' || matchedWord === 'models')) {
        const precedingShort = text.substring(Math.max(0, idx - 30), idx).toLowerCase();
        if (/\b(ai|language|local|small|large|llm|slm|diffusion|audio|speech|voice|text-to-speech|tts)\s+$/i.test(precedingShort)) {
          continue; // Skip AI/ML model
        }
      }

      // Extract clause around match using contrastive & sentence boundaries
      const rawPreceding = text.substring(Math.max(0, idx - 140), idx);
      CLAUSE_SPLIT_GLOBAL.lastIndex = 0;
      let lastSplitEnd = 0;
      let splitMatch;
      while ((splitMatch = CLAUSE_SPLIT_GLOBAL.exec(rawPreceding)) !== null) {
        lastSplitEnd = splitMatch.index + splitMatch[0].length;
      }
      const precedingClause = rawPreceding.substring(lastSplitEnd);

      const rawFollowing = text.substring(idx + match[0].length, Math.min(text.length, idx + match[0].length + 120));
      const nextSplit = rawFollowing.search(CLAUSE_SPLIT_REGEX);
      const followingClause = nextSplit !== -1 ? rawFollowing.substring(0, nextSplit) : rawFollowing;
      const fullClause = precedingClause + match[0] + followingClause;

      let isNegatedPreceding = false;
      DENY_GLOBAL.lastIndex = 0;
      let lastDenyEnd = -1;
      let denyMatch;
      while ((denyMatch = DENY_GLOBAL.exec(precedingClause)) !== null) {
        lastDenyEnd = denyMatch.index + denyMatch[0].length;
      }
      if (lastDenyEnd !== -1) {
        const afterDeny = precedingClause.substring(lastDenyEnd);
        const isOverriddenByPositiveUsage =
          !DIRECT_AI_NEGATION_REGEX.test(precedingClause) && POSITIVE_USAGE_REGEX.test(afterDeny);
        isNegatedPreceding = !isOverriddenByPositiveUsage;
      }

      // Human-made exemptions only hold if that same clause doesn't also admit using AI
      const hasHumanPhrase = /\b(are\s+not\s+ai|are\s+human\s+made|were\s+hand-drawn|no\s+ai-generated|not\s+in\s+the\s+final|replaced\s+with\s+original)\b/i.test(
        followingClause
      );
      const isNegatedFollowing =
        hasHumanPhrase &&
        (!/\b(human\s+made|hand-drawn)\b/i.test(followingClause) || !AI_MENTION_REGEX.test(precedingClause));

      if (!isNegatedPreceding && !isNegatedFollowing) {
        matched = true;
        break;
      }
    }

    if (matched) {
      detected.push(cat);
    }
  }

  // --- Concept Art / Prototyping / Art-in-Dev vs Art-In-Game Reconciliation ---
  const hasDevOnlyDisclaimer =
    /\b(prototyp\w*|early\s*prototyp\w*|concept\s*art|ideat\w*|inspiration|reference|pre-production|in-dev|placeholder)\b/i.test(lowerText) &&
    (/\b(replaced\s+with\s+original|all\s+final\s+in-game.*hand-drawn|no\s+ai.*(in\s+the\s+final|included\s+in\s+the\s+final|present\s+in\s+the\s+game)|everything\s+is\s+human\s+made|not\s+used\s+in\s+the\s+final|only\s+during\s+(early\s+)?prototyp\w*|hand-drawn\s+by\s+the\s+developer)\b/i.test(lowerText));

  if (hasDevOnlyDisclaimer) {
    const artIdx = detected.indexOf('art_in_game');
    if (artIdx !== -1) detected.splice(artIdx, 1);
    if (!detected.includes('concept_art')) detected.push('concept_art');
  } else if (detected.includes('concept_art') && detected.includes('art_in_game')) {
    const cleaned = text.replace(/concept\s*art|visual\s*ideation|early\s*concept|design\s*reference/gi, '');
    if (!CATEGORY_PATTERNS.art_in_game.test(cleaned)) {
      const idx = detected.indexOf('art_in_game');
      detected.splice(idx, 1);
    }
  }

  // Live generation check: ensure 'does not generate ... in real time' is not flagged
  if (detected.includes('live_generation')) {
    if (/\b(does\s*not|no|not|neither)\s+([a-z0-9_-]+\s+){0,6}(generate\s+.*in\s+real\s*time|live|during\s+gameplay)\b/i.test(lowerText)) {
      const idx = detected.indexOf('live_generation');
      detected.splice(idx, 1);
    }
  }

  return {
    value: true,
    categories: detected.length > 0 ? detected : ['unspecified'],
    details: text.trim(),
  };
};

const shouldFlagGame = (categories, settings, data) => {
  if (!categories || categories.length === 0) return false;
  if (data) {
    if (data.isEarlyAccess && settings.ignoreEarlyAccess) return false;
    if (data.isComingSoon && settings.ignorePreRelease) return false;
  }
  if (categories.includes('unspecified')) return true;

  const activeCategories = categories.filter((cat) => {
    if (cat === 'localization' && settings.ignoreLocalization) return false;
    if (cat === 'code' && settings.ignoreCode) return false;
    if (cat === 'concept_art' && settings.ignoreConceptArt) return false;
    if (cat === 'marketing' && settings.ignoreMarketing) return false;
    return true;
  });

  return activeCategories.length > 0;
};

const isToleratedCategoryOnly = (categories) => {
  if (!categories || categories.length === 0) return false;
  return categories.every((cat) => ['localization', 'code', 'marketing', 'concept_art'].includes(cat));
};

const formatCategoryTag = (categories) => {
  if (!categories || categories.length === 0) return 'AI Content';
  if (categories.includes('unspecified')) return 'AI Content';

  const labels = {
    localization: 'Translation',
    art_in_game: 'Art',
    concept_art: 'Concept Art',
    audio_music: 'Audio',
    live_generation: 'Live Runtime',
    code: 'Code',
    text_narrative: 'Story',
    marketing: 'Marketing',
  };

  const shortNames = categories.map((c) => labels[c] || c.toUpperCase());
  return `AI: ${shortNames.join('/')}`;
};

// --- Stream HTML until descriptor boundary is found or completed ---
const extractDisclosureFromStream = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let html = '';
  let descriptorText = null;
  let hasDisclosureHeading = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      html += decoder.decode(value, { stream: true });

      const descriptorStartIdx = html.indexOf('id="game_area_content_descriptors"');
      if (descriptorStartIdx !== -1) {
        const closingDivIdx = html.indexOf('</div>', descriptorStartIdx);
        if (closingDivIdx !== -1 && closingDivIdx + 6 < html.length) {
          const sectionHtml = html.substring(descriptorStartIdx, closingDivIdx + 600);
          if (sectionHtml.includes('AI Generated Content Disclosure')) {
            hasDisclosureHeading = true;
            const iMatch = sectionHtml.match(/<i>([\s\S]*?)<\/i>/i);
            if (iMatch) {
              descriptorText = iMatch[1].replace(/<[^>]+>/g, '').trim();
            }
          }
          try {
            await reader.cancel();
          } catch (_) { }
          break;
        }
      } else if (
        html.includes('id="game_area_sys_req"') ||
        html.includes('class="game_area_sys_req"') ||
        html.includes('id="game_area_legal"')
      ) {
        // System requirements strictly follow content descriptors in Steam layout.
        // If sys_req is reached without finding descriptors, the game has none.
        try {
          await reader.cancel();
        } catch (_) { }
        break;
      }

      if (html.length > 250000) {
        try {
          await reader.cancel();
        } catch (_) { }
        break;
      }
    }
  } catch (_) { }

  if (!hasDisclosureHeading && html.includes('AI Generated Content Disclosure')) {
    hasDisclosureHeading = true;
    const iMatch = html.match(/AI Generated Content Disclosure[\s\S]*?<i>([\s\S]*?)<\/i>/i);
    if (iMatch) {
      descriptorText = iMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  const isEarlyAccess =
    html.includes('id="earlyAccessHeader"') || html.includes('class="early_access_header"');
  const isComingSoon =
    html.includes('class="game_area_comingsoon"') || /<h1>\s*Pre-Purchase\b/i.test(html);

  return { hasDisclosureHeading, descriptorText, isEarlyAccess, isComingSoon };
};

// --- Batch Store API & HTML Stream Fallback ---
const BATCH_API_URL = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 40;
let cachedStoreCountry = null;

const getStoreCountry = () => {
  if (cachedStoreCountry) return cachedStoreCountry;
  try {
    const configAttr = document.getElementById('application_config')?.dataset?.config;
    if (configAttr) {
      cachedStoreCountry = JSON.parse(configAttr)?.COUNTRY || 'US';
      return cachedStoreCountry;
    }
  } catch (_) { }
  cachedStoreCountry = 'US';
  return cachedStoreCountry;
};

const fetchSingleAppHtmlStream = async (appId) => {
  return enqueueFetch(async () => {
    try {
      const response = await fetch(
        `https://store.steampowered.com/app/${appId}/?l=english`,
        { credentials: 'omit' }
      );

      if (!response.ok) {
        return { value: false, categories: [], details: '', ts: Date.now() };
      }

      const { hasDisclosureHeading, descriptorText, isEarlyAccess, isComingSoon } =
        await extractDisclosureFromStream(response);

      const result = hasDisclosureHeading
        ? classifyAiDisclosure(descriptorText || 'AI content used.')
        : { value: false, categories: [], details: '' };

      const entry = { ...result, isEarlyAccess, isComingSoon, ts: Date.now() };
      memoryCache.set(appId, entry);
      chrome.storage.local.set({ [`slop_cache_v3_${appId}`]: entry });

      chrome.runtime.sendMessage({
        type: 'incrementStats',
        checked: 1,
        flagged: entry.value ? 1 : 0,
      });

      return entry;
    } catch (_) {
      return { value: false, categories: [], details: '', ts: 0 };
    }
  });
};

const pendingBatchQueue = new Map();
let batchFlushTimer = null;

const scheduleBatchFlush = () => {
  if (pendingBatchQueue.size >= BATCH_SIZE) {
    if (batchFlushTimer) {
      clearTimeout(batchFlushTimer);
      batchFlushTimer = null;
    }
    flushBatchQueue();
  } else if (!batchFlushTimer) {
    batchFlushTimer = setTimeout(() => {
      batchFlushTimer = null;
      flushBatchQueue();
    }, BATCH_DELAY_MS);
  }
};

const flushBatchQueue = async () => {
  if (pendingBatchQueue.size === 0) return;

  const batchEntries = Array.from(pendingBatchQueue.entries()).slice(0, BATCH_SIZE);
  for (const [id] of batchEntries) {
    pendingBatchQueue.delete(id);
  }
  if (pendingBatchQueue.size > 0) {
    scheduleBatchFlush();
  }

  const batchIds = batchEntries.map(([id]) => id);
  const waitersById = new Map(batchEntries);
  const unresolvedIds = new Set(batchIds);

  try {
    const json = await enqueueFetch(async () => {
      const input = {
        ids: batchIds.map((id) => ({ appid: Number(id) })),
        context: { language: 'english', country_code: getStoreCountry() },
        data_request: { include_extra_details: true, include_release: true },
      };
      const response = await fetch(`${BATCH_API_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`, {
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`GetItems ${response.status}`);
      return await response.json();
    });

    const storageBatch = {};
    let checkedCount = 0;
    let flaggedInBatch = 0;
    const now = Date.now();

    for (const item of json?.response?.store_items ?? []) {
      if (item.success !== 1) continue;
      const appId = String(item.appid);
      if (!unresolvedIds.has(appId)) continue;

      const notes = item.extra_details?.content_survey_ai_notes;
      const hasNotes = typeof notes === 'string' && notes.trim().length > 0;
      const result = hasNotes
        ? classifyAiDisclosure(notes)
        : { value: false, categories: [], details: '' };

      const isEarlyAccess = Boolean(
        item.is_early_access ||
        item.release?.is_early_access ||
        item.extra_details?.early_access ||
        item.extra_details?.links_and_info?.genreids?.includes(70)
      );
      const isComingSoon = Boolean(item.is_coming_soon || item.release?.is_coming_soon);
      const entry = { ...result, isEarlyAccess, isComingSoon, ts: now };
      memoryCache.set(appId, entry);
      storageBatch[`slop_cache_v3_${appId}`] = entry;
      unresolvedIds.delete(appId);

      checkedCount++;
      if (entry.value) flaggedInBatch++;

      for (const { resolve } of waitersById.get(appId) || []) {
        resolve(entry);
      }
    }

    if (checkedCount > 0) {
      chrome.storage.local.set(storageBatch);
      chrome.runtime.sendMessage({
        type: 'incrementStats',
        checked: checkedCount,
        flagged: flaggedInBatch,
      });
    }
  } catch (_) { }

  // Fall back to individual store HTML streaming only for items omitted by GetItems or on API error
  if (unresolvedIds.size > 0) {
    await Promise.all(
      Array.from(unresolvedIds).map(async (appId) => {
        const entry = await fetchSingleAppHtmlStream(appId);
        for (const { resolve } of waitersById.get(appId) || []) {
          resolve(entry);
        }
      })
    );
  }
};

// --- App Checker with In-Flight Deduplication & Batch API ---
const checkUrlForSlop = async (appId) => {
  if (memoryCache.has(appId)) {
    const entry = memoryCache.get(appId);
    if (entry.ts && Date.now() - entry.ts > CACHE_TTL) {
      memoryCache.delete(appId);
    } else {
      return entry;
    }
  }

  // P1: Await startup cache warming so initial store elements never fire N+1 storage reads
  if (!isCacheWarm) {
    await cacheWarmPromise;
    if (memoryCache.has(appId)) {
      const entry = memoryCache.get(appId);
      if (entry.ts && Date.now() - entry.ts <= CACHE_TTL) {
        return entry;
      }
    }
  }

  if (inFlightFetches.has(appId)) {
    return inFlightFetches.get(appId);
  }

  const fetchPromise = (async () => {
    const storageKey = `slop_cache_v3_${appId}`;
    const cached = await new Promise((resolve) => {
      chrome.storage.local.get([storageKey], (res) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve((res || {})[storageKey]);
      });
    });

    if (cached !== undefined && cached !== null) {
      if (cached.ts && Date.now() - cached.ts <= CACHE_TTL && typeof cached.isEarlyAccess === 'boolean') {
        memoryCache.set(appId, cached);
        return cached;
      }
    }

    return new Promise((resolve, reject) => {
      if (!pendingBatchQueue.has(appId)) {
        pendingBatchQueue.set(appId, []);
      }
      pendingBatchQueue.get(appId).push({ resolve, reject });
      scheduleBatchFlush();
    });
  })();

  inFlightFetches.set(appId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightFetches.delete(appId);
  }
};

// Check a list of AppIDs (e.g. for bundles like "3059520,4148930") in parallel so they coalesce into one batch request
const checkMultipleAppIds = async (appIdStr) => {
  const ids = appIdStr.split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id));
  if (ids.length === 0) return { value: false, categories: [], details: '' };

  const results = await Promise.all(ids.map((id) => checkUrlForSlop(id)));
  const aiApps = results.filter((res) => res && res.value);
  if (aiApps.length === 0) return { value: false, categories: [], details: '' };
  const primary = aiApps[0];
  return {
    ...primary,
    // Only attribute Early Access or Coming Soon if ALL AI sub-apps in the bundle qualify (prevents non-AI bundle pollution)
    isEarlyAccess: aiApps.every((r) => Boolean(r.isEarlyAccess)),
    isComingSoon: aiApps.every((r) => Boolean(r.isComingSoon)),
  };
};

const getCachedSlopData = (appIdStr) => {
  if (!appIdStr) return null;
  const ids = appIdStr.split(',').map((id) => id.trim()).filter(Boolean);
  const aiEntries = [];
  let fallback = null;
  for (const id of ids) {
    const entry = memoryCache.get(id);
    if (entry && entry.value) aiEntries.push(entry);
    if (entry && !fallback) fallback = entry;
  }
  if (aiEntries.length > 0) {
    const primary = aiEntries[0];
    return {
      ...primary,
      isEarlyAccess: aiEntries.every((r) => Boolean(r.isEarlyAccess)),
      isComingSoon: aiEntries.every((r) => Boolean(r.isComingSoon)),
    };
  }
  return fallback;
};

// --- Reapply Styles across All Checked Games on Setting/Mode Change ---
const reapplyStylesAcrossPage = () => {
  const isWishlist = window.location.href.includes('/wishlist/');
  document.querySelectorAll('[data-slop-appid]').forEach((el) => {
    // Avoid styling child elements inside an outer card or table row container
    if (
      el.parentElement &&
      el.parentElement.closest(
        '[data-slop-appid], tr, .store_main_capsule, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, [data-key="hover div"], .home_content.single, .home_content_single_ctn, .cHqcdcYARwo-, [role="button"]:has([class*="AppVideoCtn"])'
      )
    ) {
      return;
    }
    const data = getCachedSlopData(el.dataset.dsAppid || el.dataset.slopAppid);
    if (data) {
      const isFlagged = data.value && shouldFlagGame(data.categories, filterSettings, data);
      if (isWishlist) {
        applySlopStyleWishlist(el, isFlagged ? currentMode : 'none', data);
      } else {
        applyAccessibleSlopStyle(el, isFlagged ? currentMode : 'none', data);
      }
    }
  });

  if (currentPageAppId) {
    handleStorePage();
  }
  queueBadgeUpdate();
};

// --- Universal Highlight Styler (Capsules, Carousels, Store Rows) ---
const applyAccessibleSlopStyle = (el, mode, data) => {
  // Prevent child elements inside an outer card or table row container from getting redundant outlines
  if (
    mode !== 'none' &&
    mode !== '' &&
    el.parentElement &&
    el.parentElement.closest(
      '[data-slop-appid], .slop-highlighted, tr, .store_main_capsule, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, [data-key="hover div"], .home_content.single, .cHqcdcYARwo-, [role="button"]:has([class*="AppVideoCtn"])'
    )
  ) {
    return;
  }
  const existingBadge = el.querySelector('.slop-badge');
  const existingTint = el.querySelector('.slop-tint-overlay');
  const bottomBar = el.querySelector('[class*="CapsuleBottomBar"]');

  if (mode === 'none' || mode === '') {
    el.style.display = '';
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.boxShadow = '';
    el.style.border = '';
    el.style.removeProperty('background');
    if (bottomBar) bottomBar.style.removeProperty('background');
    el.removeAttribute('aria-hidden');
    el.classList.remove('slop-hidden', 'slop-highlighted');
    if (existingBadge) existingBadge.style.display = 'none';
    if (existingTint) existingTint.remove();
    return;
  }

  if (mode === 'hide') {
    el.style.display = 'none';
    el.style.boxShadow = '';
    if (bottomBar) bottomBar.style.removeProperty('background');
    el.setAttribute('aria-hidden', 'true');
    el.classList.add('slop-hidden');
    if (existingTint) existingTint.remove();
    return;
  }

  el.style.display = '';
  el.removeAttribute('aria-hidden');
  el.classList.remove('slop-hidden');

  const categories = data ? data.categories : [];
  const isToleratedOnly = isToleratedCategoryOnly(categories);
  const isEarlyOrPreRelease = Boolean(data && (data.isEarlyAccess || data.isComingSoon));
  const badgeText = formatCategoryTag(categories);

  const highlightColor = isEarlyOrPreRelease ? '#9c27b0' : isToleratedOnly ? '#1976d2' : '#d32f2f';
  const overlayHue = isEarlyOrPreRelease
    ? 'rgba(156, 39, 176, 0.34)'
    : isToleratedOnly
      ? 'rgba(25, 118, 210, 0.28)'
      : 'rgba(211, 47, 47, 0.32)';
  const isDiscoveryQueueCard = el.matches('.cHqcdcYARwo-, [role="button"]:has([class*="AppVideoCtn"])');

  // Find exact image target: avoid putting relative positioning on entire calendar cells
  let imgCtn =
    (bottomBar && (bottomBar.previousElementSibling || bottomBar.parentElement?.firstElementChild)) ||
    el.querySelector('[class*="HeroCapsuleImageContainer"]') ||
    el.querySelector('.capsule_image_ctn') ||
    el.querySelector('.tab_item_header') ||
    el.querySelector('.tab_item_cap') ||
    el.querySelector('[class*="CapsuleImageCtn"]') ||
    el.querySelector('.CapsuleImageCtn') ||
    el.querySelector('.main_capsule') ||
    el.querySelector('.capsule') ||
    el.querySelector('.home_carousel_thumb') ||
    el.querySelector('.hero_capsule') ||
    el.querySelector('.sale_capsule_image') ||
    el.querySelector('[class*="SaleCapsuleImage"]') ||
    el.querySelector('.cluster_capsule_image') ||
    el.querySelector('.nL4oSzmS8Ds-') ||
    el.querySelector('.iogiG-p5PHg-, div[style*="background-image"], [class*="EventBanner"], [class*="CapsuleImage"]');

  // If inside calendar or custom tile, locate image's immediate parent (excluding mini avatars/icons, News pills, and drag handles)
  if (!imgCtn) {
    const imgEl = Array.from(el.querySelectorAll('img')).find(img => {
      const isDragHandle = !!img.closest('[data-rfd-drag-handle-draggable-id], [class*="drag_handle"]');
      const isNewsHeaderPill = !!img.closest('[class*="Zlty4OIYdk8-"], [class*="cJRhUD4vyks-"]');
      const isAvatarOrIcon =
        img.classList.contains('go8QhZVoiDg-') ||
        img.className.toLowerCase().includes('avatar') ||
        img.className.toLowerCase().includes('icon');
      return !isDragHandle && !isNewsHeaderPill && !isAvatarOrIcon;
    });
    if (imgEl && imgEl.parentElement && imgEl.parentElement !== el) {
      imgCtn = imgEl.parentElement;
    } else if (imgEl) {
      imgCtn = el;
    }
  }

  // Guard: cover entire Discovery Queue card, but exclude drag handles, News pills, and multi-section outer containers
  if (isDiscoveryQueueCard) {
    imgCtn = el;
  } else if (
    imgCtn &&
    (imgCtn.closest('[data-rfd-drag-handle-draggable-id], [class*="drag_handle"], [class*="Zlty4OIYdk8-"], [class*="cJRhUD4vyks-"]') ||
      (imgCtn === el &&
        el.querySelector(
          '.cV6I71ujCms-, .discount_block, [class*="discount_block"], [class*="StoreSalePriceWidgetContainer"], .app_name, .title, [class*="StoreSaleWidgetTitle"], [class*="ReviewScore"]'
        )))
  ) {
    imgCtn = null;
  }

  if (mode === 'highlight') {
    el.classList.add('slop-highlighted');

    // 1. Search result row or text tab: apply background wash and outline
    if (el.classList.contains('search_result_row') || el.classList.contains('tab_item') || el.classList.contains('tab_row_item')) {
      el.style.outline = `2px solid ${highlightColor}`;
      el.style.outlineOffset = '-2px';
      el.style.borderRadius = '4px';
      el.style.setProperty(
        'background',
        isEarlyOrPreRelease
          ? 'rgba(45, 10, 60, 0.85)'
          : isToleratedOnly
            ? 'rgba(0, 30, 60, 0.85)'
            : 'rgba(60, 0, 0, 0.85)',
        'important'
      );
    } else if (
      el.matches('.home_content.single, .home_content_single_ctn') ||
      el.matches(
        '[class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, [data-key="hover div"], [class*="capsule_index_"], #StoreTemplate [role="button"], tr, .store_main_capsule, .cHqcdcYARwo-, [role="button"]:has([class*="AppVideoCtn"])'
      )
    ) {
      // 2. Recommendation block, React sale card, modern wishlist row, chart row, hero capsule, or Discovery Queue slide: outline entire container
      el.style.outline = `2px solid ${highlightColor}`;
      el.style.borderRadius = '4px';
      if (el.matches('[data-key="hover div"], [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, [class*="capsule_index_"]')) {
        el.style.outlineOffset = '0px';
        el.style.boxShadow = `0 0 0 2px ${highlightColor}`;
      } else {
        el.style.outlineOffset = '-2px';
        el.style.boxShadow = '';
      }

      if (isDiscoveryQueueCard) {
        el.style.setProperty(
          'background',
          isEarlyOrPreRelease
            ? 'linear-gradient(rgb(75, 20, 95) 0%, rgb(38, 10, 52) 80%)'
            : isToleratedOnly
              ? 'linear-gradient(rgb(20, 50, 90) 0%, rgb(15, 30, 55) 80%)'
              : 'linear-gradient(rgb(95, 22, 22) 0%, rgb(48, 12, 16) 80%)',
          'important'
        );
      } else {
        el.style.setProperty(
          'background',
          isEarlyOrPreRelease
            ? 'rgba(48, 12, 64, 0.48)'
            : isToleratedOnly
              ? 'rgba(0, 30, 60, 0.45)'
              : 'rgba(60, 0, 0, 0.45)',
          'important'
        );
      }
      if (bottomBar) {
        bottomBar.style.setProperty(
          'background',
          isEarlyOrPreRelease ? 'rgb(46, 12, 58)' : isToleratedOnly ? 'rgb(12, 32, 58)' : 'rgb(58, 12, 14)',
          'important'
        );
      }
    } else {
      // 3. Generic Card / Capsule: outline strictly confined to container
      el.style.outline = `2px solid ${highlightColor}`;
      el.style.outlineOffset = '-2px';
      el.style.boxShadow = '';
    }

    // Universal capsule thumbnail / video tint overlay for all elements with an image container
    if (imgCtn) {
      const computedPos = window.getComputedStyle(imgCtn).position;
      if (computedPos === 'static') imgCtn.style.position = 'relative';
      imgCtn.style.overflow = 'hidden';
      imgCtn.style.flexShrink = '0';

      let tint = imgCtn.querySelector('.slop-tint-overlay');
      if (!tint) {
        tint = document.createElement('div');
        tint.className = 'slop-tint-overlay';
        Object.assign(tint.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: isDiscoveryQueueCard ? '6' : '10',
          borderRadius: 'inherit',
          transition: 'background 0.2s ease',
        });
        imgCtn.appendChild(tint);
      }
      tint.style.display = 'block';
      tint.style.zIndex = isDiscoveryQueueCard ? '6' : '10';
      tint.style.background = overlayHue;
      tint.style.boxShadow = 'none';
    }
  } else {
    // Mode is "text" (clean, no background wash or red tint)
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.boxShadow = '';
    el.style.border = '';
    el.style.removeProperty('background');
    if (bottomBar) bottomBar.style.removeProperty('background');
    el.classList.remove('slop-highlighted');
    if (existingTint) existingTint.remove();
  }

  // --- Badge Tag ---
  // Locate hero carousel pricing block to mount badge in empty left whitespace
  const heroDiscountBlock = el.matches('.store_main_capsule')
    ? el.querySelector('.discount_block, [class*="discount_block"]')
    : null;

  const newsHeaderPill = el.querySelector('[class*="Zlty4OIYdk8-"], [class*="cJRhUD4vyks-"]');
  const newsAppTitle = newsHeaderPill ? newsHeaderPill.querySelector('[class*="C2L2kTp8KYY-"]') : el.querySelector('[class*="C2L2kTp8KYY-"]');

  // Locate wishlist title link strictly inside wishlist rows
  const isWishlistContext =
    window.location.pathname.includes('/wishlist') || el.matches('#StoreTemplate [role="button"]');
  const wishlistTitleLink = isWishlistContext
    ? Array.from(el.querySelectorAll('a[href*="/app/"]')).find((a) => {
      const text = a.textContent.trim();
      return (
        text.length > 0 &&
        !a.querySelector('img') &&
        !a.querySelector('[class*="discount"]') &&
        !text.includes('%') &&
        !text.includes('$')
      );
    })
    : null;

  // Locate chart table row title element (skipping empty hover trigger links)
  const chartTitleEl =
    el.tagName === 'TR'
      ? Array.from(el.querySelectorAll('td:nth-child(2) a[href*="/app/"], td a[href*="/app/"]'))
        .map((a) => a.querySelector('div') || a)
        .find((node) => node.textContent.trim().length > 0 && !node.querySelector('img'))
      : null;

  const dqTitleCtn = isDiscoveryQueueCard ? el.querySelector('.HZwPEaho3zY-') : null;
  const dqTitleEl = dqTitleCtn ? dqTitleCtn.querySelector('a.QGtGxOFRQ-w-') : null;

  const titleEl =
    el.querySelector('.app_name div') ||
    el.querySelector('.app_name') ||
    el.querySelector('.single_title') ||
    el.querySelector('.title') ||
    el.querySelector('[class*="StoreSaleWidgetTitle"]') ||
    el.querySelector('.StoreSaleWidgetTitle') ||
    el.querySelector('[class*="AppTitle"]') ||
    el.querySelector('.tab_item_name') ||
    el.querySelector('.tab_item_title') ||
    el.querySelector('.match_name') ||
    el.querySelector('.name') ||
    newsAppTitle ||
    wishlistTitleLink ||
    chartTitleEl;

  const existingHeroBadge = heroDiscountBlock ? heroDiscountBlock.querySelector('.slop-badge') : null;
  const existingChartBadge = chartTitleEl ? chartTitleEl.querySelector('.slop-badge') : null;
  const existingTitleBadge = titleEl ? titleEl.querySelector('.slop-badge') : null;
  const existingNewsBadge = newsHeaderPill ? newsHeaderPill.querySelector('.slop-badge') : null;
  const existingDqBadge = dqTitleCtn ? dqTitleCtn.querySelector('.slop-badge') : null;
  const existingWishlistBadge =
    wishlistTitleLink && wishlistTitleLink.parentElement
      ? wishlistTitleLink.parentElement.querySelector('.slop-badge')
      : null;
  let badge =
    existingHeroBadge ||
    existingChartBadge ||
    existingNewsBadge ||
    existingDqBadge ||
    existingWishlistBadge ||
    existingTitleBadge ||
    existingBadge;

  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'slop-badge';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-label', `Notice: ${badgeText}`);

    if (heroDiscountBlock) {
      badge.style.display = 'inline-flex';
      badge.style.alignItems = 'center';
      badge.style.fontSize = '11px';
      badge.style.fontWeight = 'bold';
      badge.style.padding = '2px 7px';
      badge.style.borderRadius = '3px';
      badge.style.marginRight = 'auto';
      badge.style.alignSelf = 'center';
      badge.style.lineHeight = '14px';
      heroDiscountBlock.insertBefore(badge, heroDiscountBlock.firstChild);
    } else if (dqTitleCtn && dqTitleEl) {
      badge.style.display = 'inline-block';
      badge.style.width = 'fit-content';
      badge.style.fontSize = '11px';
      badge.style.fontWeight = 'bold';
      badge.style.padding = '2px 6px';
      badge.style.margin = '4px 0';
      badge.style.borderRadius = '3px';
      badge.style.letterSpacing = '0.3px';
      badge.style.whiteSpace = 'nowrap';
      dqTitleCtn.insertBefore(badge, dqTitleEl.nextSibling);
    } else if (newsHeaderPill && newsAppTitle) {
      badge.style.display = 'inline-flex';
      badge.style.alignItems = 'center';
      badge.style.fontSize = '11px';
      badge.style.fontWeight = 'bold';
      badge.style.padding = '1px 6px';
      badge.style.marginRight = '8px';
      badge.style.borderRadius = '3px';
      badge.style.flexShrink = '0';
      badge.style.lineHeight = '14px';
      newsHeaderPill.insertBefore(badge, newsAppTitle);
    } else if (wishlistTitleLink) {
      badge.style.display = 'inline-flex';
      badge.style.alignItems = 'center';
      badge.style.fontSize = '11px';
      badge.style.fontWeight = 'bold';
      badge.style.padding = '2px 7px';
      badge.style.marginLeft = '12px';
      badge.style.borderRadius = '3px';
      badge.style.verticalAlign = 'middle';
      badge.style.alignSelf = 'center';
      badge.style.lineHeight = '14px';
      const titleParent = wishlistTitleLink.parentElement || wishlistTitleLink;
      titleParent.appendChild(badge);
    } else if (titleEl) {
      badge.style.display = 'inline-block';
      badge.style.fontSize = '11px';
      badge.style.fontWeight = 'bold';
      badge.style.padding = '1px 5px';
      badge.style.marginLeft = '8px';
      badge.style.borderRadius = '3px';
      badge.style.verticalAlign = 'middle';
      badge.style.letterSpacing = '0.3px';
      badge.style.whiteSpace = 'nowrap';
      titleEl.appendChild(badge);
    } else {
      badge.style.display = 'block';
      badge.style.position = 'absolute';
      badge.style.bottom = '4px';
      badge.style.left = '4px';
      badge.style.zIndex = '15';
      badge.style.fontSize = '10px';
      badge.style.fontWeight = 'bold';
      badge.style.padding = '2px 6px';
      badge.style.borderRadius = '2px';
      badge.style.boxShadow = '0 1px 4px rgba(0,0,0,0.7)';

      const containerForBadge = el.querySelector('.cV6I71ujCms-') ? el : (imgCtn || el);
      const computedPos = window.getComputedStyle(containerForBadge).position;
      if (computedPos === 'static') containerForBadge.style.position = 'relative';
      containerForBadge.appendChild(badge);
    }
  } else if (heroDiscountBlock && badge.parentElement !== heroDiscountBlock) {
    badge.style.position = '';
    badge.style.bottom = '';
    badge.style.left = '';
    badge.style.zIndex = '';
    badge.style.boxShadow = '';
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = 'bold';
    badge.style.padding = '2px 7px';
    badge.style.borderRadius = '3px';
    badge.style.marginRight = 'auto';
    badge.style.alignSelf = 'center';
    badge.style.lineHeight = '14px';
    heroDiscountBlock.insertBefore(badge, heroDiscountBlock.firstChild);
  } else if (chartTitleEl && badge.parentElement !== chartTitleEl) {
    badge.style.position = '';
    badge.style.bottom = '';
    badge.style.left = '';
    badge.style.zIndex = '';
    badge.style.boxShadow = '';
    badge.style.display = 'inline-block';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = 'bold';
    badge.style.padding = '1px 5px';
    badge.style.marginLeft = '8px';
    badge.style.borderRadius = '3px';
    badge.style.verticalAlign = 'middle';
    badge.style.letterSpacing = '0.3px';
    badge.style.whiteSpace = 'nowrap';
    chartTitleEl.appendChild(badge);
  } else if (newsHeaderPill && newsAppTitle && badge.parentElement !== newsHeaderPill) {
    badge.style.position = '';
    badge.style.bottom = '';
    badge.style.left = '';
    badge.style.zIndex = '';
    badge.style.boxShadow = '';
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = 'bold';
    badge.style.padding = '1px 6px';
    badge.style.marginRight = '8px';
    badge.style.borderRadius = '3px';
    badge.style.flexShrink = '0';
    badge.style.lineHeight = '14px';
    newsHeaderPill.insertBefore(badge, newsAppTitle);
  } else if (wishlistTitleLink && badge.parentElement !== (wishlistTitleLink.parentElement || wishlistTitleLink)) {
    badge.style.position = '';
    badge.style.bottom = '';
    badge.style.left = '';
    badge.style.zIndex = '';
    badge.style.boxShadow = '';
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = 'bold';
    badge.style.padding = '2px 7px';
    badge.style.marginLeft = '12px';
    badge.style.borderRadius = '3px';
    badge.style.verticalAlign = 'middle';
    badge.style.alignSelf = 'center';
    badge.style.lineHeight = '14px';
    const titleParent = wishlistTitleLink.parentElement || wishlistTitleLink;
    titleParent.appendChild(badge);
  }

  badge.style.display = '';
  badge.textContent = `[${badgeText}]`;

  if (mode === 'highlight') {
    badge.style.backgroundColor = highlightColor;
    badge.style.color = '#ffffff';
    badge.style.border = `1px solid ${highlightColor}`;
  } else {
    badge.style.backgroundColor = 'rgba(20, 24, 30, 0.9)';
    badge.style.color = isEarlyOrPreRelease ? '#ce93d8' : isToleratedOnly ? '#64b5f6' : '#ff8a80';
    badge.style.border = `1px solid ${highlightColor}`;
  }
};

// --- Apply Styles to Wishlist Items ---
const applySlopStyleWishlist = (rowElement, mode, data) => {
  const effectiveMode = mode === 'hide' ? 'highlight' : mode;
  applyAccessibleSlopStyle(rowElement, effectiveMode, data);
};

// --- Badge Counter Debounce (computed from live DOM cards to stay accurate across filter toggles & carousel swaps) ---
let badgeUpdateTimer = null;
const recomputeFlaggedCount = () => {
  let count = 0;
  document.querySelectorAll('[data-slop-appid]').forEach((el) => {
    const data = getCachedSlopData(el.dataset.dsAppid || el.dataset.slopAppid);
    if (data && data.value && shouldFlagGame(data.categories, filterSettings, data)) {
      count++;
    }
  });
  if (document.getElementById('slop-warning-banner')) {
    count = Math.max(count, 1);
  }
  flaggedCount = count;
};

const queueBadgeUpdate = () => {
  if (badgeUpdateTimer) clearTimeout(badgeUpdateTimer);
  badgeUpdateTimer = setTimeout(() => {
    recomputeFlaggedCount();
    chrome.runtime.sendMessage({ type: 'updateBadge', count: flaggedCount });
  }, 250);
};

// Hoisted control exclusion checker to avoid re-allocating closures on every intersected element
const EXCLUDED_ACTION_REGEX =
  /^(visit product page|add to wishlist|add to cart|add to your wishlist|ignore|find more like this|follow|customize|explore|view all|more like this)$/i;

const isExcludedControl = (node) => {
  if (!node) return false;

  // Never exclude game cards, rows, or elements containing game artwork
  if (
    node.matches(
      '.search_result_row, .tab_item, .tab_row_item, .home_content.single, .home_content_single_ctn, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, .sale_capsule, .store_capsule'
    ) ||
    node.querySelector('img, .capsule, .capsule_image_ctn, [class*="CapsuleImageCtn"]')
  ) {
    return false;
  }

  if (
    node.matches(
      'button, .btnv6_blue_hoverfade, .btnv6_white_transparent, .btn_small_tall, [class*="queue_btn"], [class*="wishlist_btn"], .game_area_purchase_game, .queue_control_button'
    ) ||
    node.closest('.btn_actions, .queue_actions_ctn, .cluster_control_ctn, .home_content.single_buttonbar, [class*="buttonbar"]')
  ) {
    return true;
  }

  // Exact action text matching restricted to small leaf link/span controls
  if (node.tagName === 'A' || node.tagName === 'SPAN') {
    const txt = (node.textContent || '').trim();
    if (txt.length < 40 && EXCLUDED_ACTION_REGEX.test(txt)) {
      return true;
    }
  }

  return false;
};

// Climb parent containers on React sale/category hubs while sibling nodes belong exclusively to the same AppID
const extractAppIdFromNode = (node) => {
  if (!node) return null;
  if (node.dataset && node.dataset.dsAppid) return node.dataset.dsAppid.split(',')[0].trim();
  const href = node.getAttribute ? node.getAttribute('href') : node.href;
  const match = href ? href.match(/\/app\/(\d+)/) : null;
  return match ? match[1] : null;
};

const siblingHasOtherGame = (node, appId) => {
  const parent = node.parentElement;
  if (!parent) return false;
  for (let i = 0; i < parent.children.length; i++) {
    const sibling = parent.children[i];
    if (sibling === node) continue;
    const siblingId = extractAppIdFromNode(sibling);
    if (siblingId && siblingId !== appId) return true;
    const nested = sibling.querySelectorAll('a[href*="/app/"], [data-ds-appid]');
    for (let j = 0; j < nested.length; j++) {
      const nestedId = extractAppIdFromNode(nested[j]);
      if (nestedId && nestedId !== appId) return true;
    }
  }
  return false;
};

const CAROUSEL_CONTROL_SELECTOR =
  '[class*="Arrow"], [class*="Paging"], [class*="Thumbs"], button[aria-label*="Next" i], button[aria-label*="Previous" i]';

const STORE_CHECKABLE_SELECTOR =
  'a[href*="/app/"], [data-ds-appid], .capsule, .search_result_row, .tab_item, [class*="CapsuleBottomBar"]';

const findSingleAppTile = (el, appId) => {
  if (!appId || !/\/(?:sale|category|specials)\b/i.test(window.location.pathname)) {
    return el;
  }
  let tile = el;
  for (let depth = 0; depth < 6; depth++) {
    const parent = tile.parentElement;
    if (
      !parent ||
      parent === document.body ||
      parent.id === 'StoreTemplate' ||
      parent.children.length > 6 ||
      parent.querySelector(CAROUSEL_CONTROL_SELECTOR) ||
      siblingHasOtherGame(tile, appId) ||
      parent.offsetWidth > 850
    ) {
      break;
    }
    tile = parent;
  }
  return tile;
};

// --- Universal Store Element Processor ---
const processStoreElement = (el) => {
  const currentId = extractAppIdFromNode(el);
  if (el.dataset.slopChecked && (!currentId || el.dataset.slopAppid === currentId)) return;

  if (isExcludedControl(el)) {
    el.dataset.slopChecked = 'true';
    return;
  }

  // 2. Exclude inline text links (e.g. inside "Since you wish for <Game>", reviews, or curator notes)
  // Genuine game cards/capsules always contain an image thumbnail or are recognized row/widget items.
  const hasCapsuleImage = !!(
    el.querySelector('img, .capsule, .capsule_image_ctn, [class*="CapsuleImageCtn"], .large_screenshot, [style*="background-image"]') ||
    el.matches('.search_result_row, .tab_item, .tab_row_item, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer') ||
    el.closest('.search_result_row, .tab_item, .tab_row_item, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer')
  );

  if (el.tagName === 'A' && !hasCapsuleImage) {
    el.dataset.slopChecked = 'true';
    return;
  }

  // 3. Promote recommendation blocks, React sale widgets, modern React wishlist items, table rows, hero capsules, and Discovery Queue slides to outer container
  const recommendationCard = el.closest('.home_content.single, .home_content_single_ctn');
  const rawSaleCard = el.closest(
    '[class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, [data-key="hover div"], [class*="capsule_index_"], #StoreTemplate [role="button"], tr, .store_main_capsule, .cHqcdcYARwo-, [role="button"]:has([class*="AppVideoCtn"])'
  );
  const saleCard =
    rawSaleCard && rawSaleCard.matches('[class*="capsule_index_"]')
      ? (rawSaleCard.querySelector('[data-key="hover div"]') || rawSaleCard)
      : rawSaleCard;

  if (recommendationCard) {
    const targetCard = recommendationCard.matches('.home_content.single')
      ? recommendationCard
      : (recommendationCard.querySelector('.home_content.single') || recommendationCard);

    // If card was already checked or is currently being processed, mark current child and abort
    if (targetCard.dataset.slopChecked) {
      el.dataset.slopChecked = 'true';
      return;
    }
    // Synchronously claim the entire card and all its child links/capsules (P2: Target only checkable elements)
    targetCard.dataset.slopChecked = 'true';
    targetCard.querySelectorAll(STORE_CHECKABLE_SELECTOR).forEach((child) => {
      child.dataset.slopChecked = 'true';
    });
    el = targetCard;
  } else if (saleCard) {
    if (saleCard.dataset.slopChecked) {
      el.dataset.slopChecked = 'true';
      return;
    }
    saleCard.querySelectorAll('.slop-highlighted, [data-slop-appid]').forEach((child) => {
      if (child !== saleCard) {
        delete child.dataset.slopAppid;
        applyAccessibleSlopStyle(child, 'none', null);
      }
    });
    saleCard.dataset.slopChecked = 'true';
    saleCard.querySelectorAll(STORE_CHECKABLE_SELECTOR).forEach((child) => {
      child.dataset.slopChecked = 'true';
    });
    el = saleCard;
  } else {
    const rawId =
      el.dataset.dsAppid ||
      el.querySelector('[data-ds-appid]')?.dataset?.dsAppid ||
      el.querySelector('a[href*="/app/"]')?.href?.match(/\/app\/(\d+)/)?.[1] ||
      currentId;
    if (rawId) {
      const tileTarget = findSingleAppTile(el, rawId.split(',')[0].trim());
      if (tileTarget && tileTarget !== el) {
        if (tileTarget.dataset.slopChecked) {
          el.dataset.slopChecked = 'true';
          return;
        }
        tileTarget.dataset.slopChecked = 'true';
        tileTarget.querySelectorAll(STORE_CHECKABLE_SELECTOR).forEach((child) => {
          child.dataset.slopChecked = 'true';
        });
        el = tileTarget;
      }
    }
  }

  // 4. Prevent nested elements from getting duplicate badges
  if (el.closest('.slop-highlighted') && !el.classList.contains('tab_item') && !el.classList.contains('slop-highlighted')) {
    el.dataset.slopChecked = 'true';
    return;
  }

  // 5. Do not treat multi-game container sections (e.g. calendar day columns, carousel tracks) as a single game capsule
  if (
    !el.matches(
      '.home_content.single, .home_content_single_ctn, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, [data-key="hover div"], .store_main_capsule, .cHqcdcYARwo-, [role="button"]:has([class*="AppVideoCtn"])'
    )
  ) {
    const childCapsules = el.querySelectorAll(
      '.sale_capsule, .store_capsule, .search_result_row, .tab_item, [class*="StoreSaleWidgetOuterContainer"], .capsule_image_ctn'
    );
    if (childCapsules.length > 1) {
      el.dataset.slopChecked = 'true';
      return;
    }
  }

  let appId = el.dataset.dsAppid;
  if (!appId) {
    const appItem = el.querySelector('.gamelink[data-ds-appid], .capsule_image_ctn[data-ds-appid], [data-ds-appid]');
    if (appItem && appItem.dataset.dsAppid) {
      appId = appItem.dataset.dsAppid;
    }
  }
  if (!appId) {
    const link = el.tagName === 'A' ? el : el.querySelector('a[href*="/app/"]');
    if (link && link.href) {
      const match = link.href.match(/\/app\/(\d+)/);
      if (match) appId = match[1];
    }
  }

  if (!appId) return;

  const primaryAppId = appId.split(',')[0].trim();

  // On an individual store page (/app/12345/...), do NOT outline self-links or breadcrumbs!
  if (currentPageAppId && primaryAppId === currentPageAppId) {
    el.dataset.slopChecked = 'true';
    el.dataset.slopAppid = primaryAppId;
    return;
  }

  el.dataset.slopChecked = 'true';
  el.dataset.slopAppid = primaryAppId;
  if (el.dataset.dsAppid) el.dataset.dsAppid = appId;

  // Use checkMultipleAppIds to handle bundles / comma-separated AppIDs (e.g. F1 25)
  checkMultipleAppIds(appId).then((data) => {
    if (data && data.value) {
      if (!shouldFlagGame(data.categories, filterSettings, data)) {
        return;
      }
      applyAccessibleSlopStyle(el, currentMode, data);
      flaggedCount++;
      queueBadgeUpdate();
    }
  });
};

// --- Store Page Banner Handling ---
const handleStorePage = () => {
  const disclosureDivs = document.querySelectorAll('#game_area_content_descriptors');
  for (const disclosureDiv of disclosureDivs) {
    const headers = Array.from(disclosureDiv.querySelectorAll('h2'));
    const aiHeader = headers.find((h) => h.textContent.includes('AI Generated Content Disclosure'));

    if (aiHeader) {
      let details = 'AI content disclosure specified by developer.';
      let sibling = aiHeader.nextElementSibling;
      while (sibling && sibling.tagName !== 'H2') {
        const iTag = sibling.tagName === 'I' ? sibling : sibling.querySelector('i');
        if (iTag) {
          details = iTag.textContent.trim();
          break;
        }
        sibling = sibling.nextElementSibling;
      }

      const classification = classifyAiDisclosure(details);
      const isEarlyAccess = Boolean(document.querySelector('#earlyAccessHeader, .early_access_header'));
      const isComingSoon = Boolean(
        document.querySelector('.game_area_comingsoon') ||
        Array.from(document.querySelectorAll('.game_area_purchase_game h1')).some((h) =>
          /^Pre-Purchase\b/i.test((h.textContent || '').trim())
        )
      );
      const isEarlyOrPreRelease = isEarlyAccess || isComingSoon;
      const isToleratedOnly = isToleratedCategoryOnly(classification.categories);
      const themeColor = isEarlyOrPreRelease ? '#9c27b0' : isToleratedOnly ? '#1976d2' : '#d32f2f';

      if (currentPageAppId && !memoryCache.has(currentPageAppId)) {
        const pageEntry = { ...classification, isEarlyAccess, isComingSoon, ts: Date.now() };
        memoryCache.set(currentPageAppId, pageEntry);
        chrome.storage.local.set({ [`slop_cache_v3_${currentPageAppId}`]: pageEntry });
      }

      const titleHeader = document.querySelector('.apphub_AppName');
      let titleBadge = titleHeader ? titleHeader.querySelector('.slop-title-badge') : null;

      if (!shouldFlagGame(classification.categories, filterSettings, { isEarlyAccess, isComingSoon })) {
        const existingBanner = document.getElementById('slop-warning-banner');
        if (existingBanner) existingBanner.remove();
        if (titleBadge) titleBadge.remove();
        return true;
      }

      if (titleHeader) {
        if (!titleBadge) {
          titleBadge = document.createElement('span');
          titleBadge.className = 'slop-title-badge';
          titleBadge.setAttribute('role', 'status');
          titleHeader.appendChild(titleBadge);
        }
        const tagText = formatCategoryTag(classification.categories);
        titleBadge.textContent = `[${tagText}]`;
        Object.assign(titleBadge.style, {
          display: 'inline-block',
          fontSize: '14px',
          fontWeight: 'bold',
          marginLeft: '12px',
          verticalAlign: 'middle',
          color: isEarlyOrPreRelease ? '#ce93d8' : isToleratedOnly ? '#64b5f6' : '#ff8a80',
          backgroundColor: isEarlyOrPreRelease
            ? 'rgba(156,39,176,0.28)'
            : isToleratedOnly
              ? 'rgba(25,118,210,0.25)'
              : 'rgba(211,47,47,0.25)',
          border: `1px solid ${themeColor}`,
          padding: '2px 8px',
          borderRadius: '3px',
          letterSpacing: '0.4px',
        });
      }

      if (document.getElementById('slop-warning-banner')) return true;

      const targetContainer =
        document.getElementById('game_area_purchase') ||
        document.querySelector('.game_area_purchase') ||
        document.getElementById('responsive_apppage_details_left_ctn');

      if (targetContainer) {
        const banner = document.createElement('div');
        banner.id = 'slop-warning-banner';
        banner.setAttribute('role', 'alert');

        Object.assign(banner.style, {
          background: isEarlyOrPreRelease
            ? 'linear-gradient(90deg, rgba(32,14,38,0.95) 5%, rgba(20,14,26,0.95) 95%)'
            : 'linear-gradient(90deg, rgba(30,15,15,0.95) 5%, rgba(20,16,18,0.95) 95%)',
          border: `2px solid ${themeColor}`,
          padding: '14px 16px',
          marginBottom: '16px',
          color: '#c6d4df',
          borderRadius: '4px',
          boxShadow: '0 3px 12px rgba(0,0,0,0.6)',
        });

        const icon = document.createElement('img');
        icon.src = chrome.runtime.getURL('icons/iconsvg.svg');
        icon.setAttribute('alt', 'AI Warning Icon');
        Object.assign(icon.style, {
          width: '28px',
          height: '28px',
          float: 'right',
          marginLeft: '12px',
          marginBottom: '4px',
        });
        banner.appendChild(icon);

        const headerEl = document.createElement('div');
        headerEl.style.fontSize = '14px';
        headerEl.style.color = themeColor;
        headerEl.style.fontWeight = 'bold';
        headerEl.style.marginBottom = '6px';
        headerEl.style.letterSpacing = '0.5px';
        headerEl.style.textTransform = 'uppercase';
        headerEl.textContent = `AI Content Disclosure: ${classification.categories.map((c) => c.toUpperCase()).join(', ')}`;
        banner.appendChild(headerEl);

        const bodyEl = document.createElement('div');
        bodyEl.style.fontSize = '13px';
        bodyEl.style.lineHeight = '1.4';
        bodyEl.style.color = '#e0e0e0';
        bodyEl.textContent = details;
        banner.appendChild(bodyEl);

        targetContainer.parentElement.insertBefore(banner, targetContainer);

        flaggedCount = 1;
        queueBadgeUpdate();
        chrome.runtime.sendMessage({
          type: 'incrementStats',
          checked: 1,
          flagged: 1,
        });

        return true;
      }
    }
  }
  return false;
};

// --- Universal Storewide Observer ---
const initUniversalStoreObserver = () => {
  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          processStoreElement(entry.target);
          intersectionObserver.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '350px' }
  );

  const STORE_SELECTOR = [
    '.search_result_row:not([data-slop-checked])',
    '.tab_item:not([data-slop-checked])',
    '.tab_row_item:not([data-slop-checked])',
    '.store_main_capsule:not([data-slop-checked])',
    '.home_content.single:not([data-slop-checked])',
    '.home_content_single_ctn:not([data-slop-checked])',
    '[class*="StoreSaleWidgetOuterContainer"]:not([data-slop-checked])',
    '.StoreSaleWidgetOuterContainer:not([data-slop-checked])',
    '[data-key="hover div"]:not([data-slop-checked])',
    '[class*="capsule_index_"]:not([data-slop-checked])',
    '#StoreTemplate [role="button"]:not([data-slop-checked])',
    '.cHqcdcYARwo-:not([data-slop-checked])',
    '[role="button"]:has([class*="AppVideoCtn"]):not([data-slop-checked])',
    '.sale_capsule:not([data-slop-checked])',
    '.store_capsule:not([data-slop-checked])',
    '.carousel_thumb:not([data-slop-checked])',
    '[data-ds-appid]:not([data-slop-checked])',
    'a[href*="/app/"]:not([data-slop-checked])',
  ].join(', ');

  const observeElementsInSubtree = (root) => {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(STORE_SELECTOR)) {
      if (!(root.tagName === 'A' && !root.dataset.dsAppid && root.children.length === 0 && !root.textContent.trim())) {
        intersectionObserver.observe(root);
      }
    }
    root.querySelectorAll(STORE_SELECTOR).forEach((el) => {
      if (el.tagName === 'A' && !el.dataset.dsAppid && el.children.length === 0 && !el.textContent.trim()) return;
      intersectionObserver.observe(el);
    });
  };

  const pendingNodes = new Set();
  let rafScheduled = false;

  const mutationObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const target = m.target;
        if (target && target.nodeType === Node.ELEMENT_NODE) {
          const newAppId = extractAppIdFromNode(target);
          const card = target.closest('[data-slop-appid]') || target;
          if (newAppId && card.dataset.slopAppid && card.dataset.slopAppid !== newAppId) {
            delete card.dataset.slopChecked;
            delete card.dataset.slopAppid;
            card.querySelectorAll('[data-slop-checked]').forEach((child) => {
              delete child.dataset.slopChecked;
              delete child.dataset.slopAppid;
            });
            applyAccessibleSlopStyle(card, 'none', null);
            pendingNodes.add(card);
          } else if (newAppId && !target.dataset.slopChecked) {
            pendingNodes.add(target);
          }
        }
        continue;
      }

      for (let i = 0; i < m.addedNodes.length; i++) {
        const node = m.addedNodes[i];
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (
            node.classList?.contains('slop-badge') ||
            node.classList?.contains('slop-tint-overlay') ||
            node.classList?.contains('slop-title-badge') ||
            node.id === 'slop-warning-banner' ||
            node.id === 'slop-mode-filter'
          ) {
            continue;
          }
          pendingNodes.add(node);
        }
      }
    }
    if (pendingNodes.size > 0 && !rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        pendingNodes.forEach((node) => {
          if (node.isConnected) {
            observeElementsInSubtree(node);
          }
        });
        pendingNodes.clear();
      });
    }
  });

  mutationObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'data-ds-appid'],
  });
  observeElementsInSubtree(document);
};

// --- In-Page Filter Mode Panel (Search Page) ---
const addfilterModePanel = () => {
  const optionsContainer = document.getElementById('additional_search_options');
  if (!optionsContainer || document.getElementById('slop-mode-filter')) return;

  const modes = [
    { value: 'hide', label: 'Hide AI content' },
    { value: 'highlight', label: 'Highlight AI content' },
    { value: 'text', label: 'Show AI label' },
  ];

  const panelDiv = document.createElement('div');
  panelDiv.className = 'block search_collapse_block';
  panelDiv.id = 'slop-mode-filter';
  panelDiv.style.position = 'relative';
  panelDiv.setAttribute('data-collapse-name', 'slop_filter');
  panelDiv.setAttribute('data-gpnav', 'rows');
  panelDiv.setAttribute('data-gpfocus', 'group');

  const header = document.createElement('div');
  header.setAttribute('data-panel', '{"focusable":true,"clickOnActivate":true}');
  header.setAttribute('role', 'button');
  header.className = 'block_header labs_block_header';
  header.style.position = 'relative';

  const headerText = document.createElement('div');
  headerText.textContent = 'Narrow by AI Usage';
  header.appendChild(headerText);

  const content = document.createElement('div');
  content.className = 'block_content block_content_inner';

  header.addEventListener('click', () => {
    content.style.display = content.style.display === 'none' ? 'block' : 'none';
  });

  modes.forEach((mode) => {
    const row = document.createElement('div');
    row.className = 'tab_filter_control_row ' + (currentMode === mode.value ? 'checked' : '');
    row.setAttribute('data-param', 'slop_mode');
    row.setAttribute('data-value', mode.value);
    row.setAttribute('data-clientside', '1');

    const control = document.createElement('span');
    control.setAttribute('data-panel', '{"focusable":true,"clickOnActivate":true}');
    control.setAttribute('role', 'button');
    control.className = 'tab_filter_control tab_filter_control_include ' + (currentMode === mode.value ? 'checked' : '');
    control.setAttribute('data-param', 'slop_mode');
    control.setAttribute('data-value', mode.value);
    control.setAttribute('data-clientside', '1');
    control.setAttribute('data-gpfocus', 'item');

    const labelContainer = document.createElement('span');
    labelContainer.className = 'tab_filter_label_container';

    const checkbox = document.createElement('span');
    checkbox.className = 'tab_filter_control_checkbox';

    const label = document.createElement('span');
    label.className = 'tab_filter_control_label';
    label.textContent = mode.label;

    labelContainer.appendChild(checkbox);
    labelContainer.appendChild(label);
    control.appendChild(labelContainer);
    row.appendChild(control);
    content.appendChild(row);

    control.addEventListener('click', () => {
      chrome.storage.sync.set({ filterMode: mode.value }, () => {
        currentMode = mode.value;
        const panel = document.getElementById('slop-mode-filter');
        if (panel) {
          panel.querySelectorAll('.tab_filter_control_row, .tab_filter_control').forEach((el) => {
            el.classList.toggle('checked', el.dataset.value === currentMode);
          });
        }
        reapplyStylesAcrossPage();
      });
    });
  });

  const exceptions = [
    { key: 'ignoreLocalization', label: 'Ignore Translations' },
    { key: 'ignoreCode', label: 'Ignore Code / Tools' },
    { key: 'ignoreConceptArt', label: 'Ignore Concept Art' },
    { key: 'ignoreMarketing', label: 'Ignore Marketing/Capsule' },
    { key: 'ignoreEarlyAccess', label: 'Ignore Early Access' },
    { key: 'ignorePreRelease', label: 'Ignore Pre-Release' },
  ];

  exceptions.forEach((exc, index) => {
    const excRow = document.createElement('div');
    excRow.className = 'tab_filter_control_row ' + (filterSettings[exc.key] ? 'checked' : '');
    if (index === 0) {
      excRow.style.marginTop = '6px';
      excRow.style.borderTop = '1px solid rgba(255,255,255,0.1)';
      excRow.style.paddingTop = '6px';
    }

    const excControl = document.createElement('span');
    excControl.className = 'tab_filter_control tab_filter_control_include ' + (filterSettings[exc.key] ? 'checked' : '');
    excControl.setAttribute('role', 'button');

    const labelCtn = document.createElement('span');
    labelCtn.className = 'tab_filter_label_container';

    const chk = document.createElement('span');
    chk.className = 'tab_filter_control_checkbox';

    const lbl = document.createElement('span');
    lbl.className = 'tab_filter_control_label';
    lbl.textContent = exc.label;

    labelCtn.appendChild(chk);
    labelCtn.appendChild(lbl);
    excControl.appendChild(labelCtn);
    excRow.appendChild(excControl);
    content.appendChild(excRow);

    excControl.addEventListener('click', () => {
      const newVal = !filterSettings[exc.key];
      chrome.storage.sync.set({ [exc.key]: newVal }, () => {
        filterSettings[exc.key] = newVal;
        excRow.classList.toggle('checked', newVal);
        excControl.classList.toggle('checked', newVal);
        reapplyStylesAcrossPage();
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
  const tryAttach = () => {
    const optionsContainer = document.getElementById('additional_search_options');
    if (!optionsContainer) return false;

    if (!document.getElementById('slop-mode-filter')) {
      addfilterModePanel();
    }

    if (!optionsContainer.dataset.slopObserved) {
      optionsContainer.dataset.slopObserved = 'true';
      const observer = new MutationObserver(() => {
        if (!document.getElementById('slop-mode-filter')) {
          addfilterModePanel();
        }
      });
      observer.observe(optionsContainer, { childList: true, subtree: true });
    }
    return true;
  };

  if (!tryAttach()) {
    const bodyObserver = new MutationObserver((_, obs) => {
      if (tryAttach()) {
        obs.disconnect();
      }
    });
    bodyObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
};

// --- Initialization ---
const startExtension = () => {
  if (currentPageAppId) {
    const handled = handleStorePage();
    if (!handled && document.body) {
      const observer = new MutationObserver((_, obs) => {
        if (handleStorePage()) {
          obs.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  initUniversalStoreObserver();

  if (/\/search(?:\/|\?|$)/i.test(window.location.pathname || window.location.href)) {
    observeAdditionalOptions();
  }
};

// Start observers immediately so search widgets and store cards are never blocked
startExtension();

// Hydrate settings asynchronously from sync storage
const EXCEPTION_KEYS = [
  'ignoreLocalization',
  'ignoreCode',
  'ignoreConceptArt',
  'ignoreMarketing',
  'ignoreEarlyAccess',
  'ignorePreRelease',
];

chrome.storage.sync.get(['filterMode', ...EXCEPTION_KEYS], (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.filterMode) currentMode = res.filterMode;
  EXCEPTION_KEYS.forEach((key) => {
    if (res[key] !== undefined) filterSettings[key] = Boolean(res[key]);
  });

  const panel = document.getElementById('slop-mode-filter');
  if (panel) {
    panel.querySelectorAll('.tab_filter_control_row[data-param="slop_mode"]').forEach((el) => {
      el.classList.toggle('checked', el.dataset.value === currentMode);
    });
    panel.querySelectorAll('.tab_filter_control_row:not([data-param="slop_mode"])').forEach((el, idx) => {
      const k = EXCEPTION_KEYS[idx];
      if (k) el.classList.toggle('checked', Boolean(filterSettings[k]));
    });
  }

  reapplyStylesAcrossPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    let shouldReapply = false;
    if (changes.filterMode) {
      currentMode = changes.filterMode.newValue;
      shouldReapply = true;
    }
    EXCEPTION_KEYS.forEach((key) => {
      if (changes[key] !== undefined) {
        filterSettings[key] = Boolean(changes[key].newValue);
        shouldReapply = true;
      }
    });
    if (shouldReapply) {
      reapplyStylesAcrossPage();
    }
  } else if (areaName === 'local') {
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith('slop_cache_v3_') && change.newValue === undefined) {
        memoryCache.delete(key.slice(14));
      }
    }
  }
});
