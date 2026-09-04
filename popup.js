const engineEl = document.getElementById("engine");
const enabledToggleEl = document.getElementById("enabledToggle");
const deeplBlock = document.getElementById("deeplBlock");
const googleBlock = document.getElementById("googleBlock");
const deeplKeyEl = document.getElementById("deeplKey");
const deeplHostEl = document.getElementById("deeplHost");
const googleKeyEl = document.getElementById("googleKey");
const myLangEl = document.getElementById("myLang");
const engineHintEl = document.getElementById("engineHint");
const monthlyLimitEl = document.getElementById("monthlyLimit");
const usageTextEl = document.getElementById("usageText");
const usageBarFillEl = document.getElementById("usageBarFill");
const resetUsageBtn = document.getElementById("resetUsageBtn");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("saveBtn");

let LANGUAGES = [];

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

function updateEngineBlocks() {
  deeplBlock.classList.toggle("active", engineEl.value === "deepl");
  googleBlock.classList.toggle("active", engineEl.value === "google");
}

function populateLanguageOptions(selectedCanonical) {
  myLangEl.innerHTML = "";
  for (const lang of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = lang.canonical;
    opt.textContent = lang.label;
    myLangEl.appendChild(opt);
  }
  if (selectedCanonical) myLangEl.value = selectedCanonical;
}

// 检查当前"我的语言" + 当前引擎是否兼容，不兼容就提示切换引擎
function updateEngineHint() {
  const lang = LANGUAGES.find((l) => l.canonical === myLangEl.value);
  if (engineEl.value === "deepl" && lang && !lang.deepl) {
    engineHintEl.replaceChildren();
    engineHintEl.append(`DeepL 暂不支持「${lang.label}」，`);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "一键切换到 Google Translate";
    btn.addEventListener("click", () => {
      engineEl.value = "google";
      updateEngineBlocks();
      updateEngineHint();
    });
    engineHintEl.appendChild(btn);
    engineHintEl.classList.add("show");
  } else {
    engineHintEl.classList.remove("show");
    engineHintEl.replaceChildren();
  }
}

async function loadUsage() {
  try {
    const usage = await sendToBackground("getUsage", {});
    const percent = usage.limit > 0 ? Math.min(100, (usage.charCount / usage.limit) * 100) : 0;
    usageTextEl.textContent = `本月已用 ${usage.charCount.toLocaleString()} / ${usage.limit.toLocaleString()} 字符`;
    usageBarFillEl.style.width = `${percent}%`;
    usageBarFillEl.classList.remove("warn", "danger");
    if (percent >= 100) usageBarFillEl.classList.add("danger");
    else if (percent >= 80) usageBarFillEl.classList.add("warn");
  } catch (err) {
    usageTextEl.textContent = "用量数据读取失败";
  }
}

async function load() {
  const data = await chrome.storage.local.get([
    "engine",
    "deeplKey",
    "deeplHost",
    "googleKey",
    "myLang",
    "monthlyLimit",
    "enabled"
  ]);

  enabledToggleEl.checked = data.enabled !== false; // 未设置过时默认开启

  LANGUAGES = await sendToBackground("getLanguages", {});
  populateLanguageOptions(data.myLang || "zh");

  if (data.engine) engineEl.value = data.engine;
  if (data.deeplKey) deeplKeyEl.value = data.deeplKey;
  if (data.deeplHost) deeplHostEl.value = data.deeplHost;
  if (data.googleKey) googleKeyEl.value = data.googleKey;
  monthlyLimitEl.value = data.monthlyLimit || 450000;

  updateEngineBlocks();
  updateEngineHint();
  await loadUsage();
}

function showStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "";
  }, 2200);
}

engineEl.addEventListener("change", () => {
  updateEngineBlocks();
  updateEngineHint();
});
myLangEl.addEventListener("change", updateEngineHint);

enabledToggleEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: enabledToggleEl.checked });
  showStatus(enabledToggleEl.checked ? "已启用翻译功能" : "已停用翻译功能", true);
});

resetUsageBtn.addEventListener("click", async () => {
  await sendToBackground("resetUsage", {});
  await loadUsage();
  showStatus("已重置本月用量", true);
});

saveBtn.addEventListener("click", async () => {
  const engine = engineEl.value;
  const deeplKey = deeplKeyEl.value.trim();
  const deeplHost = deeplHostEl.value;
  const googleKey = googleKeyEl.value.trim();
  const myLang = myLangEl.value;
  const monthlyLimit = parseInt(monthlyLimitEl.value, 10) || 450000;

  if (engine === "deepl" && !deeplKey) {
    showStatus("请填写 DeepL API Key", false);
    return;
  }
  if (engine === "google" && !googleKey) {
    showStatus("请填写 Google Translate API Key", false);
    return;
  }

  await chrome.storage.local.set({
    engine,
    deeplKey,
    deeplHost,
    googleKey,
    myLang,
    monthlyLimit
  });
  showStatus("已保存", true);
  await loadUsage();
});

load();
