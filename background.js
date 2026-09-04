// background.js
// Service worker：负责调用翻译引擎（DeepL / Google Translate）、读写设置、维护简单的内存缓存
// 语言用一套"标准两字母代码"（canonical，如 zh / en / ja）在插件内部流转，
// 调用具体引擎前才转换成该引擎自己的语言代码格式。

const LANGUAGES = [
  { canonical: "zh", label: "中文", deepl: "ZH", google: "zh" },
  { canonical: "en", label: "English", deepl: "EN-US", google: "en" },
  { canonical: "ja", label: "日本語", deepl: "JA", google: "ja" },
  { canonical: "ko", label: "한국어", deepl: "KO", google: "ko" },
  { canonical: "es", label: "Español", deepl: "ES", google: "es" },
  { canonical: "fr", label: "Français", deepl: "FR", google: "fr" },
  { canonical: "de", label: "Deutsch", deepl: "DE", google: "de" },
  { canonical: "pt", label: "Português", deepl: "PT-BR", google: "pt" },
  { canonical: "ru", label: "Русский", deepl: "RU", google: "ru" },
  { canonical: "id", label: "Bahasa Indonesia", deepl: "ID", google: "id" },
  { canonical: "ar", label: "العربية", deepl: "AR", google: "ar" },
  { canonical: "vi", label: "Tiếng Việt", deepl: "VI", google: "vi" },
  { canonical: "th", label: "ไทย", deepl: "TH", google: "th" },
  { canonical: "tr", label: "Türkçe", deepl: "TR", google: "tr" },
  { canonical: "uk", label: "Українська", deepl: "UK", google: "uk" },
  // 以下语言 DeepL 暂不支持（deepl: null），选中这些语言时插件会提示切换到 Google Translate
  { canonical: "hi", label: "हिन्दी", deepl: null, google: "hi" },
  { canonical: "bn", label: "বাংলা", deepl: null, google: "bn" },
  { canonical: "ur", label: "اردو", deepl: null, google: "ur" },
  { canonical: "ms", label: "Bahasa Melayu", deepl: null, google: "ms" },
  { canonical: "tl", label: "Filipino", deepl: null, google: "tl" },
  { canonical: "sw", label: "Kiswahili", deepl: null, google: "sw" },
  { canonical: "fa", label: "فارسی", deepl: null, google: "fa" }
];

function toCanonical(rawCode) {
  if (!rawCode) return null;
  return rawCode.toLowerCase().split("-")[0];
}

function deeplCodeFor(canonical) {
  const entry = LANGUAGES.find((l) => l.canonical === canonical);
  return entry ? entry.deepl : null; // 找不到或DeepL不支持，统一返回 null
}

function googleCodeFor(canonical) {
  const entry = LANGUAGES.find((l) => l.canonical === canonical);
  return entry ? entry.google : canonical;
}

const memCache = new Map(); // key: `${engine}::${sourceText}::${targetCanonical}` -> 译文，避免重复请求同一条消息
const MEM_CACHE_MAX = 500; // 防止内存无限增长

function cacheGet(key) {
  if (memCache.has(key)) {
    const val = memCache.get(key);
    memCache.delete(key);
    memCache.set(key, val); // LRU: 移到末尾
    return val;
  }
  return undefined;
}

function cacheSet(key, val) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    memCache.delete(oldestKey);
  }
  memCache.set(key, val);
}

async function getSettings() {
  const data = await chrome.storage.local.get(["engine", "deeplKey", "deeplHost", "googleKey", "myLang"]);
  return {
    engine: data.engine || "deepl",
    deeplKey: data.deeplKey || "",
    deeplHost: data.deeplHost || "https://api-free.deepl.com",
    googleKey: data.googleKey || "",
    myLang: data.myLang || "zh"
  };
}

async function getChatLang(chatId) {
  const data = await chrome.storage.local.get(["chatLangs"]);
  const chatLangs = data.chatLangs || {};
  return chatLangs[chatId] || null;
}

async function setChatLang(chatId, lang) {
  const data = await chrome.storage.local.get(["chatLangs"]);
  const chatLangs = data.chatLangs || {};
  chatLangs[chatId] = lang;
  await chrome.storage.local.set({ chatLangs });
}

// ---------- DeepL ----------

async function callDeepL({ text, targetCanonical, sourceCanonical, deeplKey, deeplHost }) {
  if (!deeplKey) throw new Error("尚未配置 DeepL API Key，请在插件设置里填写");

  const targetDeeplCode = deeplCodeFor(targetCanonical);
  if (!targetDeeplCode) {
    const label = LANGUAGES.find((l) => l.canonical === targetCanonical)?.label || targetCanonical;
    throw new Error(`DeepL 暂不支持"${label}"，请到插件设置里切换成 Google Translate 引擎`);
  }

  const params = new URLSearchParams();
  params.set("auth_key", deeplKey);
  params.set("text", text);
  params.set("target_lang", targetDeeplCode);
  if (sourceCanonical) {
    const sourceDeeplCode = deeplCodeFor(sourceCanonical);
    if (sourceDeeplCode) params.set("source_lang", sourceDeeplCode);
    // 源语言 DeepL 不支持时，不传 source_lang，让 DeepL 自动检测，好过直接报错
  }

  const resp = await fetch(`${deeplHost}/v2/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepL 请求失败 (${resp.status}): ${errText}`);
  }

  const json = await resp.json();
  return {
    translatedText: json.translations[0].text,
    detectedSourceLang: toCanonical(json.translations[0].detected_source_language)
  };
}

// ---------- Google Translate ----------

async function callGoogleTranslate({ text, targetCanonical, sourceCanonical, googleKey }) {
  if (!googleKey) throw new Error("尚未配置 Google Translate API Key，请在插件设置里填写");

  const body = {
    q: text,
    target: googleCodeFor(targetCanonical),
    format: "text"
  };
  if (sourceCanonical) body.source = googleCodeFor(sourceCanonical);

  const resp = await fetch("https://translation.googleapis.com/language/translate/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": googleKey
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google Translate 请求失败 (${resp.status}): ${errText}`);
  }

  const json = await resp.json();
  const translation = json.data.translations[0];
  return {
    translatedText: translation.translatedText,
    // 只有不传 source 时，Google 才会返回 detectedSourceLanguage
    detectedSourceLang: toCanonical(translation.detectedSourceLanguage) || null
  };
}

// ---------- 用量统计 / 额度上限 ----------

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function getUsage() {
  const data = await chrome.storage.local.get(["usage"]);
  const monthKey = currentMonthKey();
  if (!data.usage || data.usage.monthKey !== monthKey) {
    return { monthKey, charCount: 0 };
  }
  return data.usage;
}

async function addUsage(chars) {
  const usage = await getUsage();
  usage.charCount += chars;
  await chrome.storage.local.set({ usage });
  return usage;
}

async function resetUsage() {
  const usage = { monthKey: currentMonthKey(), charCount: 0 };
  await chrome.storage.local.set({ usage });
  return usage;
}

async function getMonthlyLimit() {
  const data = await chrome.storage.local.get(["monthlyLimit"]);
  // 默认 45 万字符，给常见的 50 万免费额度留一点安全余量
  return data.monthlyLimit || 450000;
}

// ---------- 统一入口 ----------

async function translate({ text, targetLang, sourceLang }) {
  const settings = await getSettings();
  const targetCanonical = targetLang;
  const sourceCanonical = sourceLang || null;

  const cacheKey = `${settings.engine}::${text}::${targetCanonical}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return cached; // 缓存命中，不产生新的API调用，不占用额度
  }

  const limit = await getMonthlyLimit();
  const usage = await getUsage();
  if (usage.charCount + text.length > limit) {
    const err = new Error(
      `已达到本月翻译额度上限（${limit} 字符），插件已自动暂停翻译，避免继续产生API费用。可以到插件设置里调整额度，或等下个月自动重置。`
    );
    err.isQuotaExceeded = true;
    throw err;
  }

  let result;
  if (settings.engine === "google") {
    result = await callGoogleTranslate({
      text,
      targetCanonical,
      sourceCanonical,
      googleKey: settings.googleKey
    });
  } else {
    result = await callDeepL({
      text,
      targetCanonical,
      sourceCanonical,
      deeplKey: settings.deeplKey,
      deeplHost: settings.deeplHost
    });
  }

  await addUsage(text.length);
  cacheSet(cacheKey, result);
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "translate": {
          const result = await translate(msg.payload);
          sendResponse({ ok: true, data: result });
          break;
        }
        case "getSettings": {
          const settings = await getSettings();
          sendResponse({ ok: true, data: settings });
          break;
        }
        case "getChatLang": {
          const lang = await getChatLang(msg.payload.chatId);
          sendResponse({ ok: true, data: lang });
          break;
        }
        case "setChatLang": {
          await setChatLang(msg.payload.chatId, msg.payload.lang);
          sendResponse({ ok: true });
          break;
        }
        case "getLanguages": {
          sendResponse({ ok: true, data: LANGUAGES });
          break;
        }
        case "getUsage": {
          const usage = await getUsage();
          const limit = await getMonthlyLimit();
          sendResponse({ ok: true, data: { ...usage, limit } });
          break;
        }
        case "resetUsage": {
          const usage = await resetUsage();
          sendResponse({ ok: true, data: usage });
          break;
        }
        default:
          sendResponse({ ok: false, error: "未知消息类型" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // 保持消息通道开放，等待异步响应
});
