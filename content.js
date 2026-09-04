// content.js
// 注入到 web.whatsapp.com，负责：
// 1. 首次使用弹出风险告知，用户同意后才会启动任何功能
// 2. 监听新消息，翻译收到的消息并显示在原文下方（只读显示，不涉及发送）
// 3. 输入消息时在下方展示译文建议 + 复制按钮，由用户自己手动粘贴发送
//    —— 插件不会自动修改输入框内容，也不会代替用户点击发送按钮
//
// 注意：WhatsApp Web 的 DOM 结构和 class 名会不定期变化。
// 如果插件失效，多半是下面 SELECTORS 里的选择器过期了，
// 用浏览器开发者工具检查元素、更新对应选择器即可。

const SELECTORS = {
  messageRow: "div.message-in, div.message-out",
  messageText: ".selectable-text.copyable-text span",
  chatHeaderTitle: "#main header span[title]",
  composeBox: "footer div[contenteditable='true']",
  footer: "footer"
};

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

function getCurrentChatId() {
  const header = document.querySelector(SELECTORS.chatHeaderTitle);
  return header ? header.getAttribute("title") || header.innerText : null;
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

async function handleIncomingMessage(rowEl) {
  if (rowEl.dataset.waProcessed) return;
  rowEl.dataset.waProcessed = "1";

  const textEl = rowEl.querySelector(SELECTORS.messageText);
  if (!textEl) return; // 可能是图片/语音等非文本消息
  const originalText = textEl.innerText.trim();
  if (!originalText) return;

  const chatId = getCurrentChatId();
  if (!chatId) return;

  try {
    const result = await sendToBackground("translate", {
      text: originalText,
      targetLang: MY_LANG
    });

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

    insertTranslationLine(textEl, result.translatedText);
  } catch (err) {
    if (err.message.includes("额度上限")) {
      showQuotaBanner(err.message);
    } else {
      console.warn("[WA翻译插件] 翻译收到的消息失败：", err.message);
    }
  }
}

function insertTranslationLine(textEl, translatedText) {
  const bubble = textEl.closest("div.copyable-text") || textEl.parentElement;
  if (!bubble || bubble.querySelector(".wa-translate-line")) return;

  const line = document.createElement("div");
  line.className = "wa-translate-line";
  line.textContent = `🌐 ${translatedText}`;
  bubble.appendChild(line);
}

// ---------- 发消息：只展示译文建议 + 复制按钮，不碰输入框、不碰发送 ----------

let suggestDebounceTimer = null;
let suggestRequestId = 0;
let lastSuggestChatId = null;

function getOrCreateSuggestionBox() {
  const footer = document.querySelector(SELECTORS.footer);
  if (!footer) return null;

  let box = footer.querySelector("#wa-translate-suggest-box");
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

  footer.insertBefore(box, footer.firstChild);
  return box;
}

function showSuggestionBox(translatedText) {
  const box = getOrCreateSuggestionBox();
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
    showSuggestionBox(result.translatedText);
  } catch (err) {
    if (myRequestId !== suggestRequestId) return;
    if (err.message.includes("额度上限")) {
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
    const composeEl = e.target.closest(SELECTORS.composeBox);
    if (!composeEl) return;
    scheduleSuggestion(composeEl);
  },
  true
);

// ---------- 监听新消息 ----------

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const rows = node.matches?.(SELECTORS.messageRow)
        ? [node]
        : [...node.querySelectorAll?.(SELECTORS.messageRow) ?? []];

      for (const row of rows) {
        if (row.classList.contains("message-in")) {
          handleIncomingMessage(row);
        }
      }
    }
  }
});

// WhatsApp Web 的主面板容器，缩小监听范围提升性能
function getMainPanel() {
  return document.querySelector("#main") || document.body;
}

function updateEngineActive(next) {
  if (next === ENGINE_ACTIVE) return;
  ENGINE_ACTIVE = next;
  if (ENGINE_ACTIVE) {
    observer.observe(getMainPanel(), { childList: true, subtree: true });
    console.log("[WA翻译插件] 已启用");
  } else {
    observer.disconnect();
    hideSuggestionBox();
    console.log("[WA翻译插件] 已停用");
  }
}

async function init() {
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

  console.log("[WA翻译插件] 已加载，目标语言：", MY_LANG);
}

init();
