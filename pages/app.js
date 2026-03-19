const el = {
  workerUrl: document.getElementById("workerUrl"),
  configPreset: document.getElementById("configPreset"),
  configUrl: document.getElementById("configUrl"),
  inputMode: document.getElementById("inputMode"),
  urlsField: document.getElementById("urlsField"),
  subField: document.getElementById("subField"),
  urlsText: document.getElementById("urlsText"),
  subText: document.getElementById("subText"),
  format: document.getElementById("format"),
  convertBtn: document.getElementById("convertBtn"),
  genGetBtn: document.getElementById("genGetBtn"),
  genShortBtn: document.getElementById("genShortBtn"),
  copyBtn: document.getElementById("copyBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  generatedUrl: document.getElementById("generatedUrl"),
  status: document.getElementById("status"),
  outputCode: document.getElementById("outputCode"),
  metaInfo: document.getElementById("metaInfo"),
  loadingLayer: document.getElementById("loadingLayer"),
  langSwitch: document.getElementById("langSwitch"),
};

let outputText = "";
let highlightLoadPromise = null;
const DEFAULT_WORKER_URL = "https://meta.oimi.cc.cd";
const DEFAULT_CONFIG_URL = "https://r2.oimi.space/Clash/base.ini";
const PRO_CONFIG_URL = "https://r2.oimi.space/Clash/pro.ini";
const LEGACY_DEFAULT_CONFIG_URL =
  "https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini";
const DEFAULT_LANG = "zh-CN";
const HIGHLIGHT_SCRIPT_URL =
  "https://cdn.bootcdn.net/ajax/libs/highlight.js/11.11.1/highlight.min.js";
const HIGHLIGHT_YAML_URL =
  "https://cdn.bootcdn.net/ajax/libs/highlight.js/11.11.1/languages/yaml.min.js";

const I18N = {
  "zh-CN": {
    html_lang: "zh-CN",
    loading_text: "加载中...",
    title: "Clash.Meta 订阅转换面板",
    subtitle:
      "支持 vless / vmess / hysteria2 / tuic / anytls / ss / trojan，自动附带固定分流策略。",
    github_label: "GitHub 开源地址：",
    label_worker_url: "Worker 地址",
    label_input_mode: "输入类型",
    label_config_url: "远程配置 URL",
    opt_config_base: "基础版本（base.ini）",
    opt_config_pro: "进阶版本（pro.ini）",
    opt_config_custom: "自定义 URL",
    opt_mode_urls: "多个订阅 URL",
    opt_mode_sub: "原始订阅文本 / base64 / 节点链接（可混写）",
    label_urls_text: "订阅 URL（每行一个）",
    ph_urls_text: "https://example.com/sub1\nhttps://example.com/sub2",
    label_sub_text: "原始订阅内容",
    ph_sub_text: "可混写：http(s)订阅地址 + 节点链接 + base64",
    ph_config_url: "https://r2.oimi.space/Clash/base.ini",
    label_format: "输出格式",
    opt_format_profile: "profile（完整配置）",
    opt_format_provider: "provider（仅 proxies）",
    policy_hint: "profile 模式自动附带固定分流策略（不可修改）",
    group_yaml: "YAML 功能",
    btn_convert: "转换",
    btn_copy: "复制",
    btn_download: "下载 YAML",
    group_link: "订阅链接功能",
    link_warning: "短链服务会存储节点信息",
    btn_gen_get: "生成订阅链接并复制",
    btn_gen_short: "生成短链并复制",
    label_generated_url: "生成的 GET 请求地址",
    ph_generated_url: "点击“生成订阅链接并复制”后显示",
    yaml_title: "YAML 预览（Highlight.js）",
    output_placeholder: "# 转换后的 Clash.Meta YAML 会显示在这里",
    st_need_worker: "请先填写 Worker 地址",
    st_need_urls: "请至少输入一个订阅 URL",
    st_need_sub: "请粘贴原始订阅内容",
    st_converting: "转换中...",
    st_convert_ok: "转换成功",
    st_convert_fail: "转换失败：HTTP {status}",
    st_req_fail: "请求失败：{message}",
    st_copied: "已复制到剪贴板",
    st_copy_fail: "复制失败，请手动复制",
    st_download_ok: "已下载 YAML",
    st_get_copied: "已生成并复制 GET 请求地址",
    st_get_copy_fail: "已生成链接，但复制失败，请手动复制",
    st_shortening: "生成短链中...",
    st_short_ok: "短链已生成并复制",
    st_short_copy_fail: "短链已生成，但复制失败，请手动复制",
    st_short_fail: "生成短链失败：{message}",
  },
  en: {
    html_lang: "en",
    loading_text: "Loading...",
    title: "Clash.Meta Subscription Converter",
    subtitle:
      "Supports vless / vmess / hysteria2 / tuic / anytls / ss / trojan with built-in fixed routing rules.",
    github_label: "GitHub Repository:",
    label_worker_url: "Worker URL",
    label_input_mode: "Input Mode",
    label_config_url: "Remote Config URL",
    opt_config_base: "Base (base.ini)",
    opt_config_pro: "Pro (pro.ini)",
    opt_config_custom: "Custom URL",
    opt_mode_urls: "Multiple Subscription URLs",
    opt_mode_sub: "Raw Subscription / base64 / Node Links (Mixed)",
    label_urls_text: "Subscription URLs (one per line)",
    ph_urls_text: "https://example.com/sub1\nhttps://example.com/sub2",
    label_sub_text: "Raw Subscription Content",
    ph_sub_text: "Mix supported: http(s) URL + node links + base64",
    ph_config_url: "https://r2.oimi.space/Clash/base.ini",
    label_format: "Output Format",
    opt_format_profile: "profile (full config)",
    opt_format_provider: "provider (proxies only)",
    policy_hint: "Fixed routing rules are auto-applied in profile mode (not editable).",
    group_yaml: "YAML Actions",
    btn_convert: "Convert",
    btn_copy: "Copy",
    btn_download: "Download YAML",
    group_link: "Subscription Link Actions",
    link_warning: "Short-link service will store node information.",
    btn_gen_get: "Generate & Copy GET URL",
    btn_gen_short: "Generate & Copy Short URL",
    label_generated_url: "Generated GET URL",
    ph_generated_url: "Displayed after clicking Generate & Copy GET URL",
    yaml_title: "YAML Preview (Highlight.js)",
    output_placeholder: "# Converted Clash.Meta YAML will appear here",
    st_need_worker: "Please enter Worker URL",
    st_need_urls: "Please enter at least one subscription URL",
    st_need_sub: "Please paste raw subscription content",
    st_converting: "Converting...",
    st_convert_ok: "Convert succeeded",
    st_convert_fail: "Convert failed: HTTP {status}",
    st_req_fail: "Request failed: {message}",
    st_copied: "Copied to clipboard",
    st_copy_fail: "Copy failed, please copy manually",
    st_download_ok: "YAML downloaded",
    st_get_copied: "GET URL generated and copied",
    st_get_copy_fail: "URL generated, but copy failed",
    st_shortening: "Generating short URL...",
    st_short_ok: "Short URL generated and copied",
    st_short_copy_fail: "Short URL generated, but copy failed",
    st_short_fail: "Short URL generation failed: {message}",
  },
};

let currentLang = DEFAULT_LANG;

boot();

function boot() {
  if (!el.workerUrl || !el.inputMode || !el.convertBtn || !el.outputCode) {
    return;
  }

  currentLang = detectLang();
  if (el.langSwitch) el.langSwitch.value = currentLang;
  applyI18n(currentLang);

  el.workerUrl.value = localStorage.getItem("worker_url") || DEFAULT_WORKER_URL;
  if (el.configUrl) {
    const saved = localStorage.getItem("config_url");
    el.configUrl.value =
      saved && saved !== LEGACY_DEFAULT_CONFIG_URL ? saved : DEFAULT_CONFIG_URL;
    syncConfigPresetFromUrl();
  }

  el.inputMode.addEventListener("change", syncMode);
  el.convertBtn.addEventListener("click", convert);
  if (el.genGetBtn) el.genGetBtn.addEventListener("click", generateGetUrlAndCopy);
  if (el.genShortBtn) el.genShortBtn.addEventListener("click", generateShortUrlAndCopy);
  if (el.copyBtn) el.copyBtn.addEventListener("click", copyOutput);
  if (el.downloadBtn) el.downloadBtn.addEventListener("click", downloadYaml);

  if (el.workerUrl) {
    el.workerUrl.addEventListener("change", () => {
      localStorage.setItem("worker_url", el.workerUrl.value.trim());
    });
  }
  if (el.configUrl) {
    el.configUrl.addEventListener("change", () => {
      localStorage.setItem("config_url", el.configUrl.value.trim());
      syncConfigPresetFromUrl();
    });
  }
  if (el.configPreset) {
    const onPresetChange = () => {
      applyConfigPresetToUrl();
      if (el.configUrl) {
        localStorage.setItem("config_url", el.configUrl.value.trim());
      }
    };
    el.configPreset.addEventListener("change", onPresetChange);
    el.configPreset.addEventListener("input", onPresetChange);
  }

  if (el.langSwitch) {
    el.langSwitch.addEventListener("change", () => {
      currentLang = el.langSwitch.value === "en" ? "en" : "zh-CN";
      localStorage.setItem("ui_lang", currentLang);
      applyI18n(currentLang);
      syncMode();
    });
  }

  syncMode();
  renderOutput(t("output_placeholder"));
  hideLoadingLayer();
}

function detectLang() {
  const saved = localStorage.getItem("ui_lang");
  if (saved === "en" || saved === "zh-CN") return saved;
  const langs = Array.isArray(navigator.languages) ? navigator.languages : [];
  const primary = [...langs, navigator.language || ""]
    .map((v) => String(v).toLowerCase())
    .find(Boolean);
  return primary && primary.startsWith("zh") ? "zh-CN" : "en";
}

function t(key, vars = {}) {
  const dict = I18N[currentLang] || I18N[DEFAULT_LANG];
  let str = dict[key] ?? I18N[DEFAULT_LANG][key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return str;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function applyI18n(lang) {
  const langCode = lang === "en" ? "en" : "zh-CN";
  document.documentElement.setAttribute("lang", I18N[langCode].html_lang);

  setText("loadingText", t("loading_text"));
  setText("titleText", t("title"));
  setText("subtitleText", t("subtitle"));
  setText("githubLabel", t("github_label"));
  setText("labelWorkerUrl", t("label_worker_url"));
  setText("labelInputMode", t("label_input_mode"));
  setText("labelConfigUrl", t("label_config_url"));
  setText("optConfigBase", t("opt_config_base"));
  setText("optConfigPro", t("opt_config_pro"));
  setText("optConfigCustom", t("opt_config_custom"));
  setText("optModeUrls", t("opt_mode_urls"));
  setText("optModeSub", t("opt_mode_sub"));
  setText("labelUrlsText", t("label_urls_text"));
  setText("labelSubText", t("label_sub_text"));
  setText("labelFormat", t("label_format"));
  setText("optFormatProfile", t("opt_format_profile"));
  setText("optFormatProvider", t("opt_format_provider"));
  setText("policyHint", t("policy_hint"));
  setText("groupYaml", t("group_yaml"));
  setText("btnConvertText", t("btn_convert"));
  setText("btnCopyText", t("btn_copy"));
  setText("btnDownloadText", t("btn_download"));
  setText("groupLink", t("group_link"));
  setText("linkWarning", t("link_warning"));
  setText("btnGenGetText", t("btn_gen_get"));
  setText("btnGenShortText", t("btn_gen_short"));
  setText("labelGeneratedUrl", t("label_generated_url"));
  setText("yamlPreviewTitle", t("yaml_title"));

  if (el.urlsText) el.urlsText.placeholder = t("ph_urls_text");
  if (el.subText) el.subText.placeholder = t("ph_sub_text");
  if (el.configUrl) el.configUrl.placeholder = t("ph_config_url");
  if (el.generatedUrl) el.generatedUrl.placeholder = t("ph_generated_url");

  if (!outputText || outputText.startsWith("# ")) {
    renderOutput(t("output_placeholder"));
  }
}

function syncMode() {
  const urlsMode = el.inputMode.value === "urls";
  el.urlsField.classList.toggle("hidden", !urlsMode);
  el.subField.classList.toggle("hidden", urlsMode);
}

function syncConfigPresetFromUrl() {
  if (!el.configPreset || !el.configUrl) return;
  const v = el.configUrl.value.trim();
  if (v === DEFAULT_CONFIG_URL) el.configPreset.value = "base";
  else if (v === PRO_CONFIG_URL) el.configPreset.value = "pro";
  else el.configPreset.value = "custom";
}

function applyConfigPresetToUrl() {
  if (!el.configPreset || !el.configUrl) return;
  if (el.configPreset.value === "base") {
    el.configUrl.value = DEFAULT_CONFIG_URL;
  } else if (el.configPreset.value === "pro") {
    el.configUrl.value = PRO_CONFIG_URL;
  }
}

function setStatus(message, isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle("text-red-600", isError);
  el.status.classList.toggle("text-ink/70", !isError);
}

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function renderOutput(text) {
  outputText = text || "";
  if (el.outputCode) el.outputCode.textContent = outputText;
  const hasContent = Boolean(outputText && !outputText.startsWith("# "));
  if (hasContent) {
    highlightOutput();
  }
  if (el.copyBtn) el.copyBtn.disabled = !hasContent;
  if (el.downloadBtn) el.downloadBtn.disabled = !hasContent;
}

async function highlightOutput() {
  if (!el.outputCode) return;
  if (window.hljs) {
    window.hljs.highlightElement(el.outputCode);
    return;
  }
  await ensureHighlightReady();
  if (window.hljs) {
    window.hljs.highlightElement(el.outputCode);
  }
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") {
        resolve();
      } else {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`load failed: ${src}`)), {
          once: true,
        });
      }
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => {
      script.dataset.loaded = "1";
      resolve();
    });
    script.addEventListener("error", () => reject(new Error(`load failed: ${src}`)));
    document.body.appendChild(script);
  });
}

function ensureHighlightReady() {
  if (window.hljs) return Promise.resolve();
  if (highlightLoadPromise) return highlightLoadPromise;
  highlightLoadPromise = (async () => {
    await loadScriptOnce(HIGHLIGHT_SCRIPT_URL);
    await loadScriptOnce(HIGHLIGHT_YAML_URL);
  })().catch((error) => {
    console.warn("highlight.js load skipped:", error);
  });
  return highlightLoadPromise;
}

async function convert() {
  const prepared = prepareRequest();
  if (!prepared.ok) {
    setStatus(prepared.error, true);
    return;
  }
  const { endpoint, body } = prepared;

  el.convertBtn.disabled = true;
  setStatus(t("st_converting"));

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      setStatus(t("st_convert_fail", { status: res.status }), true);
      renderOutput(text || "# empty response");
      el.metaInfo.textContent = "";
      return;
    }

    renderOutput(text);

    const parseErrors = res.headers.get("x-parse-errors") || "0";
    el.metaInfo.textContent = `parse-errors: ${parseErrors}`;
    setStatus(t("st_convert_ok"));
  } catch (error) {
    setStatus(t("st_req_fail", { message: error.message }), true);
  } finally {
    el.convertBtn.disabled = false;
  }
}

function prepareRequest() {
  const workerBase = el.workerUrl.value.trim().replace(/\/$/, "");
  if (!workerBase) return { ok: false, error: t("st_need_worker") };

  const params = new URLSearchParams();
  params.set("format", el.format.value);
  const configUrl = el.configUrl ? el.configUrl.value.trim() : "";
  if (configUrl) params.set("config", configUrl);
  const endpoint = `${workerBase}/convert?${params.toString()}`;

  const mode = el.inputMode.value;
  if (mode === "urls") {
    const urls = splitLines(el.urlsText.value);
    if (!urls.length) return { ok: false, error: t("st_need_urls") };
    return { ok: true, workerBase, endpoint, body: { urls }, urls, sub: "" };
  }

  const sub = el.subText.value.trim();
  if (!sub) return { ok: false, error: t("st_need_sub") };
  return { ok: true, workerBase, endpoint, body: { sub }, urls: [], sub };
}

function buildGetUrl() {
  const prepared = prepareRequest();
  if (!prepared.ok) return prepared;

  const params = new URLSearchParams();
  params.set("format", el.format.value);
  const configUrl = el.configUrl ? el.configUrl.value.trim() : "";
  if (configUrl) params.set("config", configUrl);

  if (prepared.urls.length) {
    for (const u of prepared.urls) {
      params.append("url", u);
    }
  } else {
    params.set("sub", prepared.sub);
  }

  const longUrl = `${prepared.workerBase}/convert?${params.toString()}`;
  return { ok: true, longUrl, workerBase: prepared.workerBase };
}

async function generateGetUrlAndCopy() {
  const built = buildGetUrl();
  if (!built.ok) {
    setStatus(built.error, true);
    return;
  }
  if (el.generatedUrl) el.generatedUrl.value = built.longUrl;
  try {
    await navigator.clipboard.writeText(built.longUrl);
    setStatus(t("st_get_copied"));
  } catch {
    setStatus(t("st_get_copy_fail"), true);
  }
}

async function generateShortUrlAndCopy() {
  const built = buildGetUrl();
  if (!built.ok) {
    setStatus(built.error, true);
    return;
  }

  if (el.genShortBtn) el.genShortBtn.disabled = true;
  setStatus(t("st_shortening"));

  try {
    const res = await fetch(`${built.workerBase}/shorten`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: built.longUrl }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.shortUrl) {
      const msg = data?.error || `HTTP ${res.status}`;
      setStatus(t("st_short_fail", { message: msg }), true);
      return;
    }

    if (el.generatedUrl) el.generatedUrl.value = data.shortUrl;
    try {
      await navigator.clipboard.writeText(data.shortUrl);
      setStatus(t("st_short_ok"));
    } catch {
      setStatus(t("st_short_copy_fail"), true);
    }
  } catch (e) {
    setStatus(t("st_short_fail", { message: e.message }), true);
  } finally {
    if (el.genShortBtn) el.genShortBtn.disabled = false;
  }
}

async function copyOutput() {
  if (!outputText) return;
  try {
    await navigator.clipboard.writeText(outputText);
    setStatus(t("st_copied"));
  } catch {
    setStatus(t("st_copy_fail"), true);
  }
}

function downloadYaml() {
  if (!outputText) return;
  const blob = new Blob([outputText], { type: "text/yaml;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `clash-${Date.now()}.yaml`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(t("st_download_ok"));
}

function hideLoadingLayer() {
  if (!el.loadingLayer) return;
  window.setTimeout(() => {
    el.loadingLayer.classList.add("hidden");
  }, 180);
}
