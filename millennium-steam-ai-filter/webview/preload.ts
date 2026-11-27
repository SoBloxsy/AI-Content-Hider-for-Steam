// WebKit preload engine for Steam Store pages (port of AI Content Filter v3.5.1)

type FilterMode = 'text' | 'highlight' | 'hide';

interface FilterSettings {
  ignoreLocalization: boolean;
  ignoreCode: boolean;
  ignoreConceptArt: boolean;
  ignoreMarketing: boolean;
  ignoreEarlyAccess: boolean;
  ignorePreRelease: boolean;
}

interface BackendSettingsResponse extends Partial<FilterSettings> {
  filterMode?: FilterMode;
  cacheRevision?: number;
}

interface DisclosureEntry {
  value: boolean;
  categories: string[];
  details: string;
  isEarlyAccess?: boolean;
  isComingSoon?: boolean;
  ts: number;
}

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_KEY_PREFIX = 'slop_cache_v3_';
const CACHE_REV_KEY = 'slop_cache_rev';

let currentMode: FilterMode = 'text';
let filterSettings: FilterSettings = {
  ignoreLocalization: false,
  ignoreCode: false,
  ignoreConceptArt: false,
  ignoreMarketing: false,
  ignoreEarlyAccess: false,
  ignorePreRelease: false,
};
let activeCacheRevision = 1;
let warningIconDataUri: string | null = null;

const memoryCache = new Map<string, DisclosureEntry>();
const inFlightFetches = new Map<string, Promise<DisclosureEntry>>();

const getCurrentPageAppId = (): string | null => {
  const match = window.location.pathname.match(/\/app\/(\d+)/);
  return match ? match[1] : null;
};

// --- Request Queue & Concurrency Limiter ---
const MAX_CONCURRENT_FETCHES = 10;
let activeFetches = 0;
interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
const fetchQueue: Array<QueuedTask<unknown>> = [];

const processQueue = (): void => {
  while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
    const item = fetchQueue.shift()!;
    activeFetches++;
    item
      .task()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeFetches--;
        processQueue();
      });
  }
};

const enqueueFetch = <T>(task: () => Promise<T>): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    fetchQueue.push({
      task: task as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    processQueue();
  });
};

// --- Category Patterns & Classification Engine ---
const CATEGORY_PATTERNS: Record<string, RegExp> = {
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
const CATEGORY_PATTERNS_GLOBAL: Record<string, RegExp> = {};
for (const [cat, regex] of Object.entries(CATEGORY_PATTERNS)) {
  CATEGORY_PATTERNS_GLOBAL[cat] = new RegExp(regex.source, 'gi');
}
const CLAUSE_SPLIT_GLOBAL = new RegExp(CLAUSE_SPLIT_REGEX.source, 'gi');
const DENY_GLOBAL = new RegExp(DENY_REGEX.source, 'gi');

const classifyAiDisclosure = (text: string): Omit<DisclosureEntry, 'ts'> => {
  if (!text) {
    return { value: false, categories: [], details: '' };
  }

  const detected: string[] = [];
  const lowerText = text.toLowerCase();

  for (const [cat, globalRegex] of Object.entries(CATEGORY_PATTERNS_GLOBAL)) {
    globalRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    let matched = false;

    while ((match = globalRegex.exec(text)) !== null) {
      const idx = match.index;
      const matchedWord = match[0].toLowerCase();

      if (cat === 'art_in_game' && (matchedWord === 'model' || matchedWord === 'models')) {
        const precedingShort = text.substring(Math.max(0, idx - 30), idx).toLowerCase();
        if (/\b(ai|language|local|small|large|llm|slm|diffusion|audio|speech|voice|text-to-speech|tts)\s+$/i.test(precedingShort)) {
          continue;
        }
      }

      const rawPreceding = text.substring(Math.max(0, idx - 140), idx);
      CLAUSE_SPLIT_GLOBAL.lastIndex = 0;
      let lastSplitEnd = 0;
      let splitMatch: RegExpExecArray | null;
      while ((splitMatch = CLAUSE_SPLIT_GLOBAL.exec(rawPreceding)) !== null) {
        lastSplitEnd = splitMatch.index + splitMatch[0].length;
      }
      const precedingClause = rawPreceding.substring(lastSplitEnd);

      const rawFollowing = text.substring(idx + match[0].length, Math.min(text.length, idx + match[0].length + 120));
      const nextSplit = rawFollowing.search(CLAUSE_SPLIT_REGEX);
      const followingClause = nextSplit !== -1 ? rawFollowing.substring(0, nextSplit) : rawFollowing;

      let isNegatedPreceding = false;
      DENY_GLOBAL.lastIndex = 0;
      let lastDenyEnd = -1;
      let denyMatch: RegExpExecArray | null;
      while ((denyMatch = DENY_GLOBAL.exec(precedingClause)) !== null) {
        lastDenyEnd = denyMatch.index + denyMatch[0].length;
      }
      if (lastDenyEnd !== -1) {
        const afterDeny = precedingClause.substring(lastDenyEnd);
        const isOverriddenByPositiveUsage =
          !DIRECT_AI_NEGATION_REGEX.test(precedingClause) && POSITIVE_USAGE_REGEX.test(afterDeny);
        isNegatedPreceding = !isOverriddenByPositiveUsage;
      }

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

  const hasDevOnlyDisclaimer =
    /\b(prototyp\w*|early\s*prototyp\w*|concept\s*art|ideat\w*|inspiration|reference|pre-production|in-dev|placeholder)\b/i.test(lowerText) &&
    /\b(replaced\s+with\s+original|all\s+final\s+in-game.*hand-drawn|no\s+ai.*(in\s+the\s+final|included\s+in\s+the\s+final|present\s+in\s+the\s+game)|everything\s+is\s+human\s+made|not\s+used\s+in\s+the\s+final|only\s+during\s+(early\s+)?prototyp\w*|hand-drawn\s+by\s+the\s+developer)\b/i.test(lowerText);

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

const shouldFlagGame = (
  categories: string[],
  settings: FilterSettings,
  data?: Pick<DisclosureEntry, 'isEarlyAccess' | 'isComingSoon'> | null
): boolean => {
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

const isToleratedCategoryOnly = (categories: string[]): boolean => {
  if (!categories || categories.length === 0) return false;
  return categories.every((cat) => ['localization', 'code', 'marketing', 'concept_art'].includes(cat));
};

const formatCategoryTag = (categories: string[]): string => {
  if (!categories || categories.length === 0 || categories.includes('unspecified')) {
    return 'AI Content';
  }
  const labels: Record<string, string> = {
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

// --- Local Cache Helpers (store.steampowered.com localStorage with backend revision check) ---
const readLocalCacheEntry = (appId: string): DisclosureEntry | null => {
  try {
    const raw = localStorage.getItem(`${CACHE_KEY_PREFIX}${appId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DisclosureEntry;
    if (parsed && parsed.ts && Date.now() - parsed.ts <= CACHE_TTL && typeof parsed.isEarlyAccess === 'boolean') {
      return parsed;
    }
    localStorage.removeItem(`${CACHE_KEY_PREFIX}${appId}`);
  } catch (_) {}
  return null;
};

const writeLocalCacheEntry = (appId: string, entry: DisclosureEntry): void => {
  try {
    localStorage.setItem(`${CACHE_KEY_PREFIX}${appId}`, JSON.stringify(entry));
  } catch (_) {}
};

const purgeLocalCacheIfRevisionChanged = (remoteRevision: number): void => {
  if (remoteRevision === activeCacheRevision) return;
  try {
    const storedRev = Number(localStorage.getItem(CACHE_REV_KEY) || '1');
    if (storedRev !== remoteRevision) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(CACHE_KEY_PREFIX)) {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem(CACHE_REV_KEY, String(remoteRevision));
      memoryCache.clear();
    }
  } catch (_) {
    memoryCache.clear();
  }
  activeCacheRevision = remoteRevision;
};

const warmMemoryCacheFromStorage = (): void => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_KEY_PREFIX)) {
        const appId = key.slice(CACHE_KEY_PREFIX.length);
        const entry = readLocalCacheEntry(appId);
        if (entry) memoryCache.set(appId, entry);
      }
    }
  } catch (_) {}
};

// --- HTML Stream Extractor Fallback ---
const extractDisclosureFromStream = async (
  response: Response
): Promise<{ hasDisclosureHeading: boolean; descriptorText: string | null; isEarlyAccess: boolean; isComingSoon: boolean }> => {
  if (!response.body) {
    return { hasDisclosureHeading: false, descriptorText: null, isEarlyAccess: false, isComingSoon: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let html = '';
  let descriptorText: string | null = null;
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
          } catch (_) {}
          break;
        }
      } else if (
        html.includes('id="game_area_sys_req"') ||
        html.includes('class="game_area_sys_req"') ||
        html.includes('id="game_area_legal"')
      ) {
        try {
          await reader.cancel();
        } catch (_) {}
        break;
      }

      if (html.length > 250000) {
        try {
          await reader.cancel();
        } catch (_) {}
        break;
      }
    }
  } catch (_) {}

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
let cachedStoreCountry: string | null = null;

const getStoreCountry = (): string => {
  if (cachedStoreCountry) return cachedStoreCountry;
  try {
    const configAttr = document.getElementById('application_config')?.dataset?.config;
    if (configAttr) {
      cachedStoreCountry = (JSON.parse(configAttr) as { COUNTRY?: string })?.COUNTRY || 'US';
      return cachedStoreCountry;
    }
  } catch (_) {}
  cachedStoreCountry = 'US';
  return cachedStoreCountry;
};

const reportBackendStats = (checked: number, flagged: number): void => {
  if (checked <= 0 && flagged <= 0) return;
  backend.incrementStats(checked, flagged).catch(() => {});
};

const fetchSingleAppHtmlStream = async (appId: string): Promise<DisclosureEntry> => {
  return enqueueFetch(async () => {
    try {
      const response = await fetch(`https://store.steampowered.com/app/${appId}/?l=english`, {
        credentials: 'omit',
      });
      if (!response.ok) {
        return { value: false, categories: [], details: '', ts: Date.now() };
      }

      const { hasDisclosureHeading, descriptorText, isEarlyAccess, isComingSoon } =
        await extractDisclosureFromStream(response);
      const result = hasDisclosureHeading
        ? classifyAiDisclosure(descriptorText || 'AI content used.')
        : { value: false, categories: [], details: '' };

      const entry: DisclosureEntry = { ...result, isEarlyAccess, isComingSoon, ts: Date.now() };
      memoryCache.set(appId, entry);
      writeLocalCacheEntry(appId, entry);
      reportBackendStats(1, entry.value ? 1 : 0);
      return entry;
    } catch (_) {
      return { value: false, categories: [], details: '', ts: 0 };
    }
  });
};

interface BatchWaiter {
  resolve: (entry: DisclosureEntry) => void;
  reject: (err?: unknown) => void;
}
const pendingBatchQueue = new Map<string, BatchWaiter[]>();
let batchFlushTimer: number | null = null;

const scheduleBatchFlush = (): void => {
  if (pendingBatchQueue.size >= BATCH_SIZE) {
    if (batchFlushTimer !== null) {
      window.clearTimeout(batchFlushTimer);
      batchFlushTimer = null;
    }
    flushBatchQueue();
  } else if (batchFlushTimer === null) {
    batchFlushTimer = window.setTimeout(() => {
      batchFlushTimer = null;
      flushBatchQueue();
    }, BATCH_DELAY_MS);
  }
};

const flushBatchQueue = async (): Promise<void> => {
  if (pendingBatchQueue.size === 0) return;

  const batchEntries = Array.from(pendingBatchQueue.entries()).slice(0, BATCH_SIZE);
  for (const [id] of batchEntries) {
    pendingBatchQueue.delete(id);
  }
  if (pendingBatchQueue.size > 0) {
    scheduleBatchFlush();
  }

  const batchIds = batchEntries.map(([id]) => id);
  const waitersById = new Map<string, BatchWaiter[]>(batchEntries);
  const unresolvedIds = new Set<string>(batchIds);

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
      return (await response.json()) as {
        response?: {
          store_items?: Array<{
            appid: number;
            success: number;
            is_early_access?: boolean;
            is_coming_soon?: boolean;
            release?: { is_early_access?: boolean; is_coming_soon?: boolean };
            extra_details?: {
              content_survey_ai_notes?: string;
              early_access?: unknown;
              links_and_info?: { genreids?: number[] };
            };
          }>;
        };
      };
    });

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
      const entry: DisclosureEntry = { ...result, isEarlyAccess, isComingSoon, ts: now };
      memoryCache.set(appId, entry);
      writeLocalCacheEntry(appId, entry);
      unresolvedIds.delete(appId);

      checkedCount++;
      if (entry.value) flaggedInBatch++;

      for (const { resolve } of waitersById.get(appId) || []) {
        resolve(entry);
      }
    }

    reportBackendStats(checkedCount, flaggedInBatch);
  } catch (_) {}

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

const checkUrlForSlop = async (appId: string): Promise<DisclosureEntry> => {
  if (memoryCache.has(appId)) {
    const entry = memoryCache.get(appId)!;
    if (entry.ts && Date.now() - entry.ts > CACHE_TTL) {
      memoryCache.delete(appId);
    } else {
      return entry;
    }
  }

  if (inFlightFetches.has(appId)) {
    return inFlightFetches.get(appId)!;
  }

  const fetchPromise = (async () => {
    const cached = readLocalCacheEntry(appId);
    if (cached) {
      memoryCache.set(appId, cached);
      return cached;
    }

    return new Promise<DisclosureEntry>((resolve, reject) => {
      if (!pendingBatchQueue.has(appId)) {
        pendingBatchQueue.set(appId, []);
      }
      pendingBatchQueue.get(appId)!.push({ resolve, reject });
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

const checkMultipleAppIds = async (appIdStr: string): Promise<DisclosureEntry> => {
  const ids = appIdStr.split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id));
  if (ids.length === 0) return { value: false, categories: [], details: '', ts: 0 };

  const results = await Promise.all(ids.map((id) => checkUrlForSlop(id)));
  const aiApps = results.filter((res) => res && res.value);
  if (aiApps.length === 0) return { value: false, categories: [], details: '', ts: 0 };
  const primary = aiApps[0];
  return {
    ...primary,
    // Only attribute Early Access or Coming Soon if ALL AI sub-apps in the bundle qualify (prevents non-AI bundle pollution)
    isEarlyAccess: aiApps.every((r) => Boolean(r.isEarlyAccess)),
    isComingSoon: aiApps.every((r) => Boolean(r.isComingSoon)),
  };
};

const getCachedSlopData = (appIdStr?: string): DisclosureEntry | null => {
  if (!appIdStr) return null;
  const ids = appIdStr.split(',').map((id) => id.trim()).filter(Boolean);
  const aiEntries: DisclosureEntry[] = [];
  let fallback: DisclosureEntry | null = null;
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

// --- Universal Highlight Styler ---
const applyAccessibleSlopStyle = (el: HTMLElement, mode: FilterMode | 'none' | '', data: DisclosureEntry | null): void => {
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

  const existingBadge = el.querySelector<HTMLElement>('.slop-badge');
  const existingTint = el.querySelector<HTMLElement>('.slop-tint-overlay');
  const bottomBar = el.querySelector<HTMLElement>('[class*="CapsuleBottomBar"]');

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

  let imgCtn: HTMLElement | null =
    (bottomBar && ((bottomBar.previousElementSibling as HTMLElement | null) || (bottomBar.parentElement?.firstElementChild as HTMLElement | null))) ||
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

  if (!imgCtn) {
    const imgEl = Array.from(el.querySelectorAll('img')).find((img) => {
      const isDragHandle = Boolean(img.closest('[data-rfd-drag-handle-draggable-id], [class*="drag_handle"]'));
      const isNewsHeaderPill = Boolean(img.closest('[class*="Zlty4OIYdk8-"], [class*="cJRhUD4vyks-"]'));
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
      el.style.outline = `2px solid ${highlightColor}`;
      el.style.outlineOffset = '-2px';
      el.style.boxShadow = '';
    }

    if (imgCtn) {
      const computedPos = window.getComputedStyle(imgCtn).position;
      if (computedPos === 'static') imgCtn.style.position = 'relative';
      imgCtn.style.overflow = 'hidden';
      imgCtn.style.flexShrink = '0';

      let tint = imgCtn.querySelector<HTMLElement>('.slop-tint-overlay');
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
  const heroDiscountBlock = el.matches('.store_main_capsule')
    ? el.querySelector<HTMLElement>('.discount_block, [class*="discount_block"]')
    : null;

  const newsHeaderPill = el.querySelector<HTMLElement>('[class*="Zlty4OIYdk8-"], [class*="cJRhUD4vyks-"]');
  const newsAppTitle = newsHeaderPill
    ? newsHeaderPill.querySelector<HTMLElement>('[class*="C2L2kTp8KYY-"]')
    : el.querySelector<HTMLElement>('[class*="C2L2kTp8KYY-"]');

  const isWishlistContext =
    window.location.pathname.includes('/wishlist') || el.matches('#StoreTemplate [role="button"]');
  const wishlistTitleLink = isWishlistContext
    ? Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]')).find((a) => {
        const text = (a.textContent || '').trim();
        return (
          text.length > 0 &&
          !a.querySelector('img') &&
          !a.querySelector('[class*="discount"]') &&
          !text.includes('%') &&
          !text.includes('$')
        );
      }) || null
    : null;

  const chartTitleEl =
    el.tagName === 'TR'
      ? Array.from(el.querySelectorAll<HTMLAnchorElement>('td:nth-child(2) a[href*="/app/"], td a[href*="/app/"]'))
          .map((a) => a.querySelector<HTMLElement>('div') || a)
          .find((node) => (node.textContent || '').trim().length > 0 && !node.querySelector('img')) || null
      : null;

  const dqTitleCtn = isDiscoveryQueueCard ? el.querySelector<HTMLElement>('.HZwPEaho3zY-') : null;
  const dqTitleEl = dqTitleCtn ? dqTitleCtn.querySelector<HTMLElement>('a.QGtGxOFRQ-w-') : null;

  const titleEl: HTMLElement | null =
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

  const existingHeroBadge = heroDiscountBlock ? heroDiscountBlock.querySelector<HTMLElement>('.slop-badge') : null;
  const existingChartBadge = chartTitleEl ? chartTitleEl.querySelector<HTMLElement>('.slop-badge') : null;
  const existingTitleBadge = titleEl ? titleEl.querySelector<HTMLElement>('.slop-badge') : null;
  const existingNewsBadge = newsHeaderPill ? newsHeaderPill.querySelector<HTMLElement>('.slop-badge') : null;
  const existingDqBadge = dqTitleCtn ? dqTitleCtn.querySelector<HTMLElement>('.slop-badge') : null;
  const existingWishlistBadge =
    wishlistTitleLink && wishlistTitleLink.parentElement
      ? wishlistTitleLink.parentElement.querySelector<HTMLElement>('.slop-badge')
      : null;

  let badge =
    existingHeroBadge ||
    existingChartBadge ||
    existingNewsBadge ||
    existingDqBadge ||
    existingWishlistBadge ||
    existingTitleBadge ||
    existingBadge;

  const resetBadgeOverlayProps = (target: HTMLElement): void => {
    target.style.position = '';
    target.style.bottom = '';
    target.style.left = '';
    target.style.zIndex = '';
    target.style.boxShadow = '';
  };

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
    resetBadgeOverlayProps(badge);
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
    resetBadgeOverlayProps(badge);
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
    resetBadgeOverlayProps(badge);
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
    resetBadgeOverlayProps(badge);
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

const applySlopStyleWishlist = (rowElement: HTMLElement, mode: FilterMode | 'none' | '', data: DisclosureEntry | null): void => {
  const effectiveMode = mode === 'hide' ? 'highlight' : mode;
  applyAccessibleSlopStyle(rowElement, effectiveMode, data);
};

// --- Store Page Banner Handling ---
const handleStorePage = (): boolean => {
  const disclosureDivs = document.querySelectorAll<HTMLElement>('#game_area_content_descriptors');
  for (const disclosureDiv of Array.from(disclosureDivs)) {
    const headers = Array.from(disclosureDiv.querySelectorAll('h2'));
    const aiHeader = headers.find((h) => (h.textContent || '').includes('AI Generated Content Disclosure'));

    if (aiHeader) {
      let details = 'AI content disclosure specified by developer.';
      let sibling = aiHeader.nextElementSibling;
      while (sibling && sibling.tagName !== 'H2') {
        const iTag = sibling.tagName === 'I' ? sibling : sibling.querySelector('i');
        if (iTag) {
          details = (iTag.textContent || '').trim();
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

      const currAppId = getCurrentPageAppId();
      if (currAppId && !memoryCache.has(currAppId)) {
        const pageEntry: DisclosureEntry = { ...classification, isEarlyAccess, isComingSoon, ts: Date.now() };
        memoryCache.set(currAppId, pageEntry);
        writeLocalCacheEntry(currAppId, pageEntry);
      }

      const titleHeader = document.querySelector<HTMLElement>('.apphub_AppName');
      let titleBadge = titleHeader ? titleHeader.querySelector<HTMLElement>('.slop-title-badge') : null;

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
        document.querySelector<HTMLElement>('.game_area_purchase') ||
        document.getElementById('responsive_apppage_details_left_ctn');

      if (targetContainer && targetContainer.parentElement) {
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

        if (warningIconDataUri) {
          const icon = document.createElement('img');
          icon.src = warningIconDataUri;
          icon.setAttribute('alt', 'AI Warning Icon');
          Object.assign(icon.style, {
            width: '28px',
            height: '28px',
            float: 'right',
            marginLeft: '12px',
            marginBottom: '4px',
          });
          banner.appendChild(icon);
        }

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
        reportBackendStats(1, 1);
        return true;
      }
    }
  }
  return false;
};

// --- Reapply Styles Across Checked Games ---
const reapplyStylesAcrossPage = (): void => {
  const isWishlist = window.location.href.includes('/wishlist/');
  document.querySelectorAll<HTMLElement>('[data-slop-appid]').forEach((el) => {
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

  if (getCurrentPageAppId()) {
    handleStorePage();
  }
};

// --- DOM Matching, Exclusions & React Hub Tile Climbing ---
const EXCLUDED_ACTION_REGEX =
  /^(visit product page|add to wishlist|add to cart|add to your wishlist|ignore|find more like this|follow|customize|explore|view all|more like this)$/i;

const isExcludedControl = (node: HTMLElement | null): boolean => {
  if (!node) return false;

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

  if (node.tagName === 'A' || node.tagName === 'SPAN') {
    const txt = (node.textContent || '').trim();
    if (txt.length < 40 && EXCLUDED_ACTION_REGEX.test(txt)) {
      return true;
    }
  }

  return false;
};

const extractAppIdFromNode = (node: Element | null): string | null => {
  if (!node) return null;
  const htmlEl = node as HTMLElement;
  if (htmlEl.dataset && htmlEl.dataset.dsAppid) return htmlEl.dataset.dsAppid.split(',')[0].trim();
  const href = node.getAttribute ? node.getAttribute('href') : (node as HTMLAnchorElement).href;
  const match = href ? href.match(/\/app\/(\d+)/) : null;
  return match ? match[1] : null;
};

const siblingHasOtherGame = (node: Element, appId: string): boolean => {
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

const findSingleAppTile = (el: HTMLElement, appId: string): HTMLElement => {
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

const processStoreElement = (el: HTMLElement): void => {
  const currentId = extractAppIdFromNode(el);
  if (el.dataset.slopChecked && (!currentId || el.dataset.slopAppid === currentId)) return;

  if (isExcludedControl(el)) {
    el.dataset.slopChecked = 'true';
    return;
  }

  const hasCapsuleImage = Boolean(
    el.querySelector('img, .capsule, .capsule_image_ctn, [class*="CapsuleImageCtn"], .large_screenshot, [style*="background-image"]') ||
      el.matches('.search_result_row, .tab_item, .tab_row_item, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer') ||
      el.closest('.search_result_row, .tab_item, .tab_row_item, [class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer')
  );

  if (el.tagName === 'A' && !hasCapsuleImage) {
    el.dataset.slopChecked = 'true';
    return;
  }

  const recommendationCard = el.closest<HTMLElement>('.home_content.single, .home_content_single_ctn');
  const rawSaleCard = el.closest<HTMLElement>(
    '[class*="StoreSaleWidgetOuterContainer"], .StoreSaleWidgetOuterContainer, [data-key="hover div"], [class*="capsule_index_"], #StoreTemplate [role="button"], tr, .store_main_capsule, .cHqcdcYARwo-, [role="button"]:has([class*="AppVideoCtn"])'
  );
  const saleCard =
    rawSaleCard && rawSaleCard.matches('[class*="capsule_index_"]')
      ? rawSaleCard.querySelector<HTMLElement>('[data-key="hover div"]') || rawSaleCard
      : rawSaleCard;

  if (recommendationCard) {
    const targetCard = recommendationCard.matches('.home_content.single')
      ? recommendationCard
      : recommendationCard.querySelector<HTMLElement>('.home_content.single') || recommendationCard;

    if (targetCard.dataset.slopChecked) {
      el.dataset.slopChecked = 'true';
      return;
    }
    targetCard.dataset.slopChecked = 'true';
    targetCard.querySelectorAll<HTMLElement>(STORE_CHECKABLE_SELECTOR).forEach((child) => {
      child.dataset.slopChecked = 'true';
    });
    el = targetCard;
  } else if (saleCard) {
    if (saleCard.dataset.slopChecked) {
      el.dataset.slopChecked = 'true';
      return;
    }
    saleCard.querySelectorAll<HTMLElement>('.slop-highlighted, [data-slop-appid]').forEach((child) => {
      if (child !== saleCard) {
        delete child.dataset.slopAppid;
        applyAccessibleSlopStyle(child, 'none', null);
      }
    });
    saleCard.dataset.slopChecked = 'true';
    saleCard.querySelectorAll<HTMLElement>(STORE_CHECKABLE_SELECTOR).forEach((child) => {
      child.dataset.slopChecked = 'true';
    });
    el = saleCard;
  } else {
    const rawId =
      el.dataset.dsAppid ||
      el.querySelector<HTMLElement>('[data-ds-appid]')?.dataset?.dsAppid ||
      el.querySelector<HTMLAnchorElement>('a[href*="/app/"]')?.href?.match(/\/app\/(\d+)/)?.[1] ||
      currentId;
    if (rawId) {
      const tileTarget = findSingleAppTile(el, rawId.split(',')[0].trim());
      if (tileTarget && tileTarget !== el) {
        if (tileTarget.dataset.slopChecked) {
          el.dataset.slopChecked = 'true';
          return;
        }
        tileTarget.dataset.slopChecked = 'true';
        tileTarget.querySelectorAll<HTMLElement>(STORE_CHECKABLE_SELECTOR).forEach((child) => {
          child.dataset.slopChecked = 'true';
        });
        el = tileTarget;
      }
    }
  }

  if (el.closest('.slop-highlighted') && !el.classList.contains('tab_item') && !el.classList.contains('slop-highlighted')) {
    el.dataset.slopChecked = 'true';
    return;
  }

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
    const appItem = el.querySelector<HTMLElement>('.gamelink[data-ds-appid], .capsule_image_ctn[data-ds-appid], [data-ds-appid]');
    if (appItem && appItem.dataset.dsAppid) {
      appId = appItem.dataset.dsAppid;
    }
  }
  if (!appId) {
    const link = el.tagName === 'A' ? (el as HTMLAnchorElement) : el.querySelector<HTMLAnchorElement>('a[href*="/app/"]');
    if (link && link.href) {
      const match = link.href.match(/\/app\/(\d+)/);
      if (match) appId = match[1];
    }
  }

  if (!appId) return;

  const primaryAppId = appId.split(',')[0].trim();
  const activePageAppId = getCurrentPageAppId();

  if (activePageAppId && primaryAppId === activePageAppId) {
    el.dataset.slopChecked = 'true';
    el.dataset.slopAppid = primaryAppId;
    return;
  }

  el.dataset.slopChecked = 'true';
  el.dataset.slopAppid = primaryAppId;
  if (el.dataset.dsAppid) el.dataset.dsAppid = appId;

  checkMultipleAppIds(appId).then((data) => {
    if (data && data.value) {
      if (!shouldFlagGame(data.categories, filterSettings, data)) {
        return;
      }
      applyAccessibleSlopStyle(el, currentMode, data);
    }
  });
};

// --- Universal Storewide Observer ---
const initUniversalStoreObserver = (): void => {
  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          processStoreElement(entry.target as HTMLElement);
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

  const observeElementsInSubtree = (root: ParentNode | Element): void => {
    if (!root || !root.querySelectorAll) return;
    if ('matches' in root && typeof root.matches === 'function' && root.matches(STORE_SELECTOR)) {
      const elRoot = root as HTMLElement;
      if (!(elRoot.tagName === 'A' && !elRoot.dataset.dsAppid && elRoot.children.length === 0 && !(elRoot.textContent || '').trim())) {
        intersectionObserver.observe(elRoot);
      }
    }
    root.querySelectorAll<HTMLElement>(STORE_SELECTOR).forEach((el) => {
      if (el.tagName === 'A' && !el.dataset.dsAppid && el.children.length === 0 && !(el.textContent || '').trim()) return;
      intersectionObserver.observe(el);
    });
  };

  const pendingNodes = new Set<HTMLElement>();
  let rafScheduled = false;

  const mutationObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const target = m.target as HTMLElement;
        if (target && target.nodeType === Node.ELEMENT_NODE) {
          const newAppId = extractAppIdFromNode(target);
          const card = target.closest<HTMLElement>('[data-slop-appid]') || target;
          if (newAppId && card.dataset.slopAppid && card.dataset.slopAppid !== newAppId) {
            delete card.dataset.slopChecked;
            delete card.dataset.slopAppid;
            card.querySelectorAll<HTMLElement>('[data-slop-checked]').forEach((child) => {
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
          const elNode = node as HTMLElement;
          if (
            elNode.classList?.contains('slop-badge') ||
            elNode.classList?.contains('slop-tint-overlay') ||
            elNode.classList?.contains('slop-title-badge') ||
            elNode.id === 'slop-warning-banner' ||
            elNode.id === 'slop-mode-filter'
          ) {
            continue;
          }
          pendingNodes.add(elNode);
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

// --- In-Page Search Sidebar Filter ---
const syncSearchSidebarPanel = (): void => {
  const panel = document.getElementById('slop-mode-filter');
  if (!panel) return;
  panel.querySelectorAll<HTMLElement>('.tab_filter_control_row[data-param="slop_mode"], .tab_filter_control[data-param="slop_mode"]').forEach((el) => {
    el.classList.toggle('checked', el.dataset.value === currentMode);
  });
  const exceptionKeys: Array<keyof FilterSettings> = [
    'ignoreLocalization',
    'ignoreCode',
    'ignoreConceptArt',
    'ignoreMarketing',
    'ignoreEarlyAccess',
    'ignorePreRelease',
  ];
  panel.querySelectorAll<HTMLElement>('.tab_filter_control_row:not([data-param="slop_mode"])').forEach((row, idx) => {
    const key = exceptionKeys[idx];
    if (!key) return;
    const isChecked = Boolean(filterSettings[key]);
    row.classList.toggle('checked', isChecked);
    row.querySelector('.tab_filter_control')?.classList.toggle('checked', isChecked);
  });
};

const addfilterModePanel = (): void => {
  const optionsContainer = document.getElementById('additional_search_options');
  if (!optionsContainer || document.getElementById('slop-mode-filter')) return;

  const modes: Array<{ value: FilterMode; label: string }> = [
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
      currentMode = mode.value;
      syncSearchSidebarPanel();
      reapplyStylesAcrossPage();
      backend.setFilterMode(mode.value).catch(() => {});
    });
  });

  const exceptions: Array<{ key: keyof FilterSettings; label: string }> = [
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
      filterSettings[exc.key] = newVal;
      syncSearchSidebarPanel();
      reapplyStylesAcrossPage();
      backend.setFilterFlag(exc.key, newVal).catch(() => {});
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

const observeAdditionalOptions = (): void => {
  const tryAttach = (): boolean => {
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

// --- Sync Settings with Millennium Lua Backend ---
const syncSettingsFromBackend = async (): Promise<void> => {
  try {
    const res = (await backend.getSettings()) as unknown as BackendSettingsResponse | null;
    if (!res || typeof res !== 'object') return;

    if (typeof res.cacheRevision === 'number') {
      purgeLocalCacheIfRevisionChanged(res.cacheRevision);
    }

    let changed = false;
    if (res.filterMode && res.filterMode !== currentMode) {
      currentMode = res.filterMode;
      changed = true;
    }
    (
      [
        'ignoreLocalization',
        'ignoreCode',
        'ignoreConceptArt',
        'ignoreMarketing',
        'ignoreEarlyAccess',
        'ignorePreRelease',
      ] as Array<keyof FilterSettings>
    ).forEach((key) => {
      const nextVal = Boolean(res[key]);
      if (nextVal !== filterSettings[key]) {
        filterSettings[key] = nextVal;
        changed = true;
      }
    });

    if (changed) {
      syncSearchSidebarPanel();
      reapplyStylesAcrossPage();
    }
  } catch (_) {}
};

const waitForBody = (): Promise<void> => {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
};

const initStoreContext = (): void => {
  warmMemoryCacheFromStorage();

  if (getCurrentPageAppId()) {
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

export default async function main(): Promise<void> {
  if (window.location.hostname !== 'store.steampowered.com') {
    return;
  }

  await waitForBody();

  // Load SVG warning asset once for in-page product banners
  backend
    .getWarningIconSvg()
    .then((svg: string) => {
      if (svg) {
        warningIconDataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      }
    })
    .catch(() => {});

  // Hydrate initial settings before processing cards, without blocking DOM hooks indefinitely
  await syncSettingsFromBackend();
  initStoreContext();

  // Re-sync settings & search hooks when returning from Steam Settings or SPA navigation
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncSettingsFromBackend();
    }
  });
  window.addEventListener('focus', () => {
    syncSettingsFromBackend();
  });
  window.addEventListener('popstate', () => {
    if (getCurrentPageAppId()) {
      handleStorePage();
    }
    if (/\/search(?:\/|\?|$)/i.test(window.location.pathname || window.location.href)) {
      observeAdditionalOptions();
    }
  });
}
