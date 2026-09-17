// content.js
// 注入到 web.whatsapp.com，负责：
// 1. 首次使用弹出风险告知，用户同意后才会启动任何功能
// 2. 监听新消息，翻译收到的消息并显示在原文下方（只读显示，不涉及发送）
// 3. 输入消息时在下方展示译文建议 + 复制按钮，由用户自己手动粘贴发送
//    —— 插件不会自动修改输入框内容，也不会代替用户点击发送按钮
//
// 注意：WhatsApp Web 的 DOM 结构和 class 名会不定期变化。
// 本文件对"消息气泡 / 消息文本 / 输入框 / 标题"全部采用多策略选择器：
// 优先用抗变化的 data-testid / role 属性，再回退到传统 class。
// 如果未来全部失效，可用 window.__waTranslate.debug() 在控制台查看诊断信息。

const SELECTORS = {
  // 主面板（SPA 导航时 #main 可能被整体替换）
  main: "#main",

  // 消息气泡：新版可能没有 message-in/out，需要 role=row 兜底
  bubbles: ".message-in, .message-out",
  rowsFallback: '[role="row"]',

  // 可能的消息文本节点（按优先级，代码里会逐一尝试）
  textCandidates: [
    "[data-testid='selectable-text']",
    ".copyable-text[data-pre-plain-text]",
    "span.selectable-text.copyable-text",
    "span.selectable-text"
  ],

  // 引用回复的容器，取正文时要排除，否则会把被引用的消息也一起翻译
  quoted: [
    "[data-testid='quoted-message']",
    "[data-testid='quoted-mention']",
    ".quoted-mention",
    '[class*="quoted"]'
  ].join(","),

  // 已发送消息才有的对勾图标，role=row 兜底时用来判断方向
  tickIcons: '[data-icon="msg-dblcheck"], [data-icon="msg-check"], [data-icon="msg-time"], [data-icon="status-v3"]',

  // 输入框
  composeBox: [
    "[data-testid='conversation-compose-box-input']",
    "footer div[contenteditable='true']",
    "#main div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true'][role='textbox']"
  ].join(","),

  // 底部输入区容器
  footer: ["#main footer", "footer", '[data-testid="conversation-compose-box-container"]'].join(","),

  // 聊天标题
  chatTitle: [
    "#main header [data-testid='conversation-info-header-chat-title']",
    "#main header span[title]",
    "#main header span[dir='auto']",
    "#main header span",
    "#main header div"
  ].join(",")
};

const VERSION = "0.2.3"; // 诊断时展示，方便确认用户实际运行的代码版本

let MY_LANG = "zh"; // 标准两字母语言代码（canonical），如 zh / en / ja
let ENGINE_ACTIVE = false; // 风险告知已同意 且 用户开关处于"启用"，两者都满足才为 true

// ---------- 工具函数 ----------

function sendToBackground(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp || !resp.ok) {
        reject(new Error(resp?.error || "未知错误"));
        return;
      }
      resolve(resp.data);
    });
  });
}

function getMainPanel() {
  return document.querySelector(SELECTORS.main) || document.body;
}

function getCurrentChatId() {
  const header = document.querySelector(SELECTORS.chatTitle);
  if (!header) return null;
  return header.getAttribute("title") || header.innerText?.trim() || null;
}

async function loadMyLang() {
  const settings = await sendToBackground("getSettings", {});
  MY_LANG = settings.myLang || "zh";
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // 部分环境下 clipboard API 不可用，退回到传统方式
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

let quotaBannerShown = false;

function showQuotaBanner(message) {
  if (quotaBannerShown) return;
  quotaBannerShown = true;

  const banner = document.createElement("div");
  banner.id = "wa-translate-quota-banner";
  banner.textContent = `⚠️ ${message}`;
  document.body.appendChild(banner);
}

let configBannerShown = false;

// 未配置 API Key 等"用户可自行修复"的问题，显示一次性引导横幅
function showConfigBanner(message) {
  if (configBannerShown) return;
  configBannerShown = true;

  const banner = document.createElement("div");
  banner.id = "wa-translate-config-banner";

  const span = document.createElement("span");
  span.textContent = `⚠️ ${message}`;
  banner.appendChild(span);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "知道了";
  closeBtn.addEventListener("click", () => banner.remove());
  banner.appendChild(closeBtn);

  document.body.appendChild(banner);
}

// ---------- DOM 适配层：屏蔽 WhatsApp 改版差异 ----------

/**
 * 判断一个气泡元素是否为"收到的消息"
 */
function isIncomingBubble(el) {
  if (el.classList.contains("message-in")) return true;
  if (el.classList.contains("message-out")) return false;

  // role=row 兜底：发出的消息带已发送/已读对勾，收到的消息没有
  const isRow = el.getAttribute("role") === "row";
  if (isRow) {
    const hasTick = el.querySelector(SELECTORS.tickIcons);
    return !hasTick;
  }
  return false;
}

/**
 * 在气泡内提取消息正文，排除引用回复的内容
 */
function extractMessageText(bubble) {
  const candidates = [];
  for (const sel of SELECTORS.textCandidates) {
    for (const el of bubble.querySelectorAll(sel)) {
      // 排除引用回复里的文本
      if (el.closest(SELECTORS.quoted)) continue;
      const text = el.innerText?.trim();
      if (text) candidates.push({ el, text, len: text.length });
    }
    if (candidates.length) break;
  }
  if (!candidates.length) return null;
  // 一条消息正文通常是候选里最长的那个（排除表情占位等碎片）
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0].text;
}

/**
 * 在一个根节点（可能是新增节点或整个面板）内收集所有收到的消息气泡
 */
function collectIncomingBubbles(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return [];

  const result = [];
  const seen = new Set();

  const pushIfIncoming = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    // 已成功处理 / 正在请求 / 已失败（等待手动重试）的气泡都跳过，
    // 避免每次扫描都对历史消息调用 innerText（触发重排）或重复发起 API 请求
    if (el.dataset.waProcessed || el.dataset.waPending || el.dataset.waError) return;
    if (isIncomingBubble(el) && extractMessageText(el)) {
      result.push(el);
    }
  };

  // 策略 1：经典 class（2025-2026 多数版本仍存在）
  let bubbles = root.matches?.(SELECTORS.bubbles) ? [root] : [];
  if (root.querySelectorAll) {
    bubbles = bubbles.concat([...root.querySelectorAll(SELECTORS.bubbles)]);
  }
  if (bubbles.length) {
    for (const b of bubbles) pushIfIncoming(b);
    return result;
  }

  // 策略 2：role=row 兜底（新版 DOM / class 被混淆时）
  let rows = root.matches?.(SELECTORS.rowsFallback) ? [root] : [];
  if (root.querySelectorAll) {
    rows = rows.concat([...root.querySelectorAll(SELECTORS.rowsFallback)]);
  }
  for (const row of rows) {
    // 系统行（日期分割线、"已加密"提示等）没有可复制文本，会被 extractMessageText 过滤
    pushIfIncoming(row);
  }
  return result;
}

// ---------- 首次使用风险告知 ----------

function showRiskDisclaimer(onAgree) {
  const overlay = document.createElement("div");
  overlay.id = "wa-translate-risk-overlay";

  const modal = document.createElement("div");
  modal.className = "wa-translate-risk-modal";

  const h2 = document.createElement("h2");
  h2.textContent = "使用须知，请先阅读";
  modal.appendChild(h2);

  const p1 = document.createElement("p");
  p1.append("这是一个");
  const strong = document.createElement("strong");
  strong.textContent = "非官方";
  p1.append(strong);
  p1.append("的第三方翻译插件，与 WhatsApp / Meta 官方没有任何关联。使用任何第三方工具都存在被 WhatsApp 官方风控系统限制甚至封禁账号的风险，请你了解这一点、自行判断是否继续使用。");
  modal.appendChild(p1);

  const p2 = document.createElement("p");
  p2.textContent = "本插件不会读取、存储或上传你的聊天记录和账号信息；翻译文本只会发送给你自己在设置里配置的翻译引擎（DeepL / Google Translate），不会经过开发者的服务器。";
  modal.appendChild(p2);

  const p3 = document.createElement("p");
  p3.textContent = "插件不会代替你自动发送任何消息——收到的消息只做显示翻译，发消息时只提供译文建议，需要你自己手动复制粘贴、手动点击发送。";
  modal.appendChild(p3);

  const actions = document.createElement("div");
  actions.className = "wa-translate-risk-actions";

  const agreeBtn = document.createElement("button");
  agreeBtn.type = "button";
  agreeBtn.id = "wa-translate-risk-agree";
  agreeBtn.textContent = "我已知情，同意继续使用";
  actions.appendChild(agreeBtn);

  const declineBtn = document.createElement("button");
  declineBtn.type = "button";
  declineBtn.id = "wa-translate-risk-decline";
  declineBtn.textContent = "暂不使用";
  actions.appendChild(declineBtn);

  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById("wa-translate-risk-agree").addEventListener("click", async () => {
    await chrome.storage.local.set({ riskAcknowledged: true });
    overlay.remove();
    onAgree();
  });
  document.getElementById("wa-translate-risk-decline").addEventListener("click", () => {
    overlay.remove();
    // 不设置 riskAcknowledged，刷新页面后会再次弹出，插件本次不启动任何功能
  });
}

// ---------- 收消息：翻译并插入译文（只读显示，不涉及发送） ----------

async function handleIncomingMessage(bubble) {
  if (bubble.dataset.waProcessed) return;
  if (bubble.dataset.waPending) return; // 同一条消息翻译进行中，防止重复请求
  bubble.dataset.waPending = "1";

  const originalText = extractMessageText(bubble);
  if (!originalText) {
    delete bubble.dataset.waPending;
    return; // 图片/语音/系统提示等非文本消息，不标记 processed，以后出现文本时还能处理
  }

  const chatId = getCurrentChatId();
  if (!chatId) {
    delete bubble.dataset.waPending;
    return;
  }

  try {
    const result = await sendToBackground("translate", {
      text: originalText,
      targetLang: MY_LANG
    });
    bubble.dataset.waProcessed = "1";
    removeErrorLine(bubble);

    // 记录这个联系人的语言，供发消息时决定翻译建议的目标语言
    if (result.detectedSourceLang) {
      await sendToBackground("setChatLang", {
        chatId,
        lang: result.detectedSourceLang
      });
    }

    // 如果检测到的语言本来就和我的语言一致，不用显示译文
    if (result.detectedSourceLang && result.detectedSourceLang === MY_LANG) {
      return;
    }

    insertTranslationLine(bubble, result.translatedText);
  } catch (err) {
    const msg = err.message || "未知错误";
    bubble.dataset.waError = "1"; // 标记失败，扫描时不再自动重试，只能由用户手动重试
    if (msg.includes("额度上限")) {
      showQuotaBanner(msg);
    } else if (msg.includes("尚未配置") || msg.includes("API Key")) {
      showConfigBanner("翻译功能需要先配置 API Key：请点击浏览器工具栏上的插件图标，填写并保存 DeepL 或 Google 的 API Key。");
      insertErrorLine(bubble, msg, () => retryMessage(bubble));
    } else {
      console.warn("[WA翻译插件] 翻译收到的消息失败：", msg);
      insertErrorLine(bubble, msg, () => retryMessage(bubble));
    }
  } finally {
    delete bubble.dataset.waPending;
  }
}

// 失败后允许重试：清掉失败标记，重新走一遍翻译流程
function retryMessage(bubble) {
  delete bubble.dataset.waProcessed;
  delete bubble.dataset.waError;
  removeErrorLine(bubble);
  handleIncomingMessage(bubble);
}

function insertTranslationLine(bubble, translatedText) {
  if (bubble.querySelector(".wa-translate-line")) return;

  const line = document.createElement("div");
  line.className = "wa-translate-line";
  line.textContent = `🌐 ${translatedText}`;
  bubble.appendChild(line);
}

function insertErrorLine(bubble, errorMsg, onRetry) {
  removeErrorLine(bubble);

  const line = document.createElement("div");
  line.className = "wa-translate-error";
  line.title = errorMsg; // 鼠标悬停可看到完整错误

  const span = document.createElement("span");
  span.textContent = "⚠️ 翻译失败，点右侧重试";
  line.appendChild(span);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.textContent = "重试";
  retryBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onRetry();
  });
  line.appendChild(retryBtn);

  bubble.appendChild(line);
}

function removeErrorLine(bubble) {
  bubble.querySelector(".wa-translate-error")?.remove();
}

// ---------- 全量扫描（初始加载 / 切换聊天 / 新增节点兜底） ----------

function scanVisibleMessages() {
  if (!ENGINE_ACTIVE) return;
  const panel = getMainPanel();
  const bubbles = collectIncomingBubbles(panel);
  for (const bubble of bubbles) {
    handleIncomingMessage(bubble);
  }
}

let scanDebounceTimer = null;
function scheduleScan() {
  clearTimeout(scanDebounceTimer);
  scanDebounceTimer = setTimeout(scanVisibleMessages, 200);
}

// ---------- 发消息：只展示译文建议 + 复制按钮，不碰输入框、不碰发送 ----------

let suggestDebounceTimer = null;
let suggestRequestId = 0;
let lastSuggestChatId = null;

function getFooterContainer(composeEl) {
  // 优先用 footer；新版没有 footer 时从输入框向上找输入区容器
  return (
    document.querySelector("#main footer") ||
    composeEl?.closest?.("footer") ||
    composeEl?.closest?.('[data-testid*="compose"]')?.parentElement ||
    composeEl?.parentElement?.parentElement ||
    null
  );
}

function getOrCreateSuggestionBox(composeEl) {
  const container = getFooterContainer(composeEl);
  if (!container) return null;

  let box = container.querySelector("#wa-translate-suggest-box");
  if (box) return box;

  box = document.createElement("div");
  box.id = "wa-translate-suggest-box";
  box.className = "wa-translate-suggest-box";

  const suggestText = document.createElement("span");
  suggestText.className = "wa-translate-suggest-text";
  box.appendChild(suggestText);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "wa-translate-suggest-copy";
  copyBtn.textContent = "复制译文";
  box.appendChild(copyBtn);

  copyBtn.addEventListener("click", async () => {
    const text = box.dataset.translated || "";
    if (!text) return;
    const ok = await copyToClipboard(text);
    copyBtn.textContent = ok ? "已复制 ✓" : "复制失败";
    setTimeout(() => {
      copyBtn.textContent = "复制译文";
    }, 1500);
  });

  container.insertBefore(box, container.firstChild);
  return box;
}

function showSuggestionBox(composeEl, translatedText) {
  const box = getOrCreateSuggestionBox(composeEl);
  if (!box) return;
  box.dataset.translated = translatedText;
  box.querySelector(".wa-translate-suggest-text").textContent = `🌐 ${translatedText}`;
  box.classList.add("show");
}

function hideSuggestionBox() {
  const box = document.querySelector("#wa-translate-suggest-box");
  if (!box) return;
  box.classList.remove("show");
  box.dataset.translated = "";
}

async function updateSuggestion(composeEl) {
  const text = composeEl.innerText.trim();
  const chatId = getCurrentChatId();

  if (chatId !== lastSuggestChatId) {
    // 切换了聊天对象，先清空旧的译文建议，避免张冠李戴
    lastSuggestChatId = chatId;
    hideSuggestionBox();
  }

  if (!text || !chatId) {
    hideSuggestionBox();
    return;
  }

  const chatLang = await sendToBackground("getChatLang", { chatId });
  if (!chatLang || chatLang === MY_LANG) {
    hideSuggestionBox();
    return;
  }

  const myRequestId = ++suggestRequestId;
  try {
    const result = await sendToBackground("translate", {
      text,
      targetLang: chatLang,
      sourceLang: MY_LANG
    });
    if (myRequestId !== suggestRequestId) return; // 用户输入已经变了，这次结果过期作废
    showSuggestionBox(composeEl, result.translatedText);
  } catch (err) {
    if (myRequestId !== suggestRequestId) return;
    if (err.message?.includes("额度上限")) {
      showQuotaBanner(err.message);
    }
    hideSuggestionBox();
  }
}

function scheduleSuggestion(composeEl) {
  clearTimeout(suggestDebounceTimer);
  suggestDebounceTimer = setTimeout(() => updateSuggestion(composeEl), 600);
}

// ---------- 事件绑定 ----------

document.addEventListener(
  "input",
  (e) => {
    if (!ENGINE_ACTIVE) return;
    const composeEl = e.target.closest?.(SELECTORS.composeBox);
    if (!composeEl) return;
    scheduleSuggestion(composeEl);
  },
  true
);

// ---------- 监听 DOM 变化 ----------
// 直接监听 document.body：WhatsApp 是 SPA，切换聊天时 #main 可能被整体替换，
// 只监听 #main 会在导航后"哑火"。回调里用轻量判断 + 防抖扫描控制性能。

const observer = new MutationObserver((mutations) => {
  if (!ENGINE_ACTIVE) return;

  let needFullScan = false;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      // 快速预判：先只在新增节点内部找
      const bubbles = collectIncomingBubbles(node);
      for (const b of bubbles) handleIncomingMessage(b);
      if (bubbles.length) continue;
      // 新增节点本身可能是消息列表的中间包装层：只有当它看起来与聊天面板相关时，
      // 才触发防抖全量扫描兜底，避免 WhatsApp 其他区域的频繁变动造成性能浪费
      if (
        node.closest?.("#main") ||
        node.querySelector?.("#main") ||
        node.matches?.('[role="row"], [role="application"], div[data-testid]')
      ) {
        needFullScan = true;
      }
    }
  }
  if (needFullScan) scheduleScan();
});

// 轮询当前聊天对象，切换聊天时重新扫描（比依赖 DOM 结构更可靠）
let lastChatId = null;
setInterval(() => {
  if (!ENGINE_ACTIVE) return;
  const chatId = getCurrentChatId();
  if (chatId && chatId !== lastChatId) {
    lastChatId = chatId;
    hideSuggestionBox();
    // 聊天面板渲染是异步的，延迟扫描几次
    setTimeout(scanVisibleMessages, 300);
    setTimeout(scanVisibleMessages, 1000);
    setTimeout(scanVisibleMessages, 2500);
  }
}, 800);

function updateEngineActive(next) {
  if (next === ENGINE_ACTIVE) return;
  ENGINE_ACTIVE = next;
  if (ENGINE_ACTIVE) {
    // 监听 body 而不是 #main，避免 SPA 导航后 observer 挂在已移除的节点上
    observer.observe(document.body, { childList: true, subtree: true });
    console.log("[WA翻译插件] 已启用");
    // 面板可能已经渲染好了，分几次补扫历史消息
    setTimeout(scanVisibleMessages, 300);
    setTimeout(scanVisibleMessages, 1500);
    setTimeout(scanVisibleMessages, 4000);
  } else {
    observer.disconnect();
    hideSuggestionBox();
    console.log("[WA翻译插件] 已停用");
  }
}

// ---------- 诊断工具（用户排查时在控制台用） ----------

async function runDiagnostics() {
  const panel = getMainPanel();
  let settings = null;
  let settingsError = null;
  try {
    settings = await sendToBackground("getSettings", {});
  } catch (err) {
    settingsError = err.message;
  }

  const info = {
    版本: VERSION,
    主面板: !!document.querySelector(SELECTORS.main),
    经典气泡数: document.querySelectorAll(SELECTORS.bubbles).length,
    role行数量: document.querySelectorAll(SELECTORS.rowsFallback).length,
    待翻译消息数: collectIncomingBubbles(panel).length,
    已成功处理数: panel.querySelectorAll("[data-wa-processed]").length,
    失败消息数: panel.querySelectorAll("[data-wa-error]").length,
    输入框: !!document.querySelector(SELECTORS.composeBox),
    聊天标题: getCurrentChatId(),
    目标语言: MY_LANG,
    插件已启用: ENGINE_ACTIVE,
    翻译引擎: settings?.engine ?? `读取失败: ${settingsError}`,
    DeepL_Key已配置: !!(settings?.deeplKey),
    Google_Key已配置: !!(settings?.googleKey)
  };
  console.table(info);

  if (!settings) {
    console.warn("[WA翻译插件] 无法连接后台 Service Worker（getSettings 失败）。请到 chrome://extensions 点击本插件的刷新箭头，再刷新 WhatsApp 页面。错误：", settingsError);
  } else if (settings.engine === "deepl" && !settings.deeplKey) {
    console.warn("[WA翻译插件] 当前使用 DeepL 引擎，但还没有填写 DeepL API Key。请点浏览器工具栏的插件图标填写并保存。");
  } else if (settings.engine === "google" && !settings.googleKey) {
    console.warn("[WA翻译插件] 当前使用 Google 引擎，但还没有填写 Google API Key。请点浏览器工具栏的插件图标填写并保存。");
  }
  if (info.经典气泡数 === 0 && info.role行数量 === 0) {
    console.warn("[WA翻译插件] 没有找到任何消息节点——请先打开一个聊天窗口再运行诊断；如果已打开仍为 0，说明 WhatsApp 再次改版，请到 GitHub 反馈。");
  }
  return info;
}

// 直接发一条测试翻译，验证"插件后台 → 翻译 API → 网络"整条链路
async function testApi() {
  console.log("[WA翻译插件] 正在发起测试翻译（Hello → 目标语言）…");
  try {
    const result = await sendToBackground("translate", { text: "Hello", targetLang: MY_LANG });
    console.log("%c[WA翻译插件] API 测试成功：", "color:#16a34a", result);
    return result;
  } catch (err) {
    console.error("[WA翻译插件] API 测试失败：", err.message);
    console.error("[WA翻译插件] 常见原因：① Key 填错/没保存 ② 网络或 VPN 无法访问翻译 API ③ DeepL 免费版 Key 用了付费版主机（或相反）④ 额度用尽");
    throw err;
  }
}

// 暴露到 window，用户可在控制台执行 __waTranslate.debug() 自助排查
window.__waTranslate = {
  version: VERSION,
  debug: runDiagnostics,
  testApi,
  scan: scanVisibleMessages
};

async function init() {
  // init 里任何一步失败都不能让整个插件"静默死亡"，否则用户只会看到"毫无反应"
  try {
    await loadMyLang();

    const { riskAcknowledged, enabled } = await chrome.storage.local.get(["riskAcknowledged", "enabled"]);
    const isEnabled = enabled !== false; // 未设置过时默认开启

    if (!riskAcknowledged) {
      showRiskDisclaimer(() => updateEngineActive(isEnabled));
    } else {
      updateEngineActive(isEnabled);
    }

    // 监听设置面板里的开关变化，实时生效，不用刷新页面
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.enabled) {
        updateEngineActive(changes.enabled.newValue !== false);
      }
      if (changes.myLang) {
        MY_LANG = changes.myLang.newValue || MY_LANG;
      }
    });

    console.log(`[WA翻译插件] 已加载 v${VERSION}，目标语言：`, MY_LANG);
    console.log("[WA翻译插件] 如翻译未出现，可在控制台执行 __waTranslate.debug() 查看诊断，或 __waTranslate.testApi() 测试 API");
  } catch (err) {
    console.error("[WA翻译插件] 初始化失败：", err);
    showConfigBanner(
      `插件初始化失败（${err.message || "未知错误"}）。请在 chrome://extensions 点本插件的刷新箭头，再刷新 WhatsApp 页面；仍失败请把控制台截图反馈到 GitHub Issues。`
    );
  }
}

init();
