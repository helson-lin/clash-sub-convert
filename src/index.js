const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname === "/") {
      return textResponse(
        [
          "Clash Subscription Converter (Cloudflare Worker)",
          "",
          "GET /convert?url=<subscription_url>",
          "GET /convert?url=<url1>,<url2>",
          "POST /convert  (body can be plain links or base64 subscription)",
          "POST /shorten  (body: {\"url\":\"https://.../convert?...\"})",
          "GET /s/<code>  (redirect to long convert url)",
          "",
          "Supported protocols: vless, vmess, hysteria2, tuic, anytls, ss, trojan",
        ].join("\n"),
      );
    }

    if (url.pathname.startsWith("/s/")) {
      const code = url.pathname.slice(3).trim();
      if (!code) return textResponse("Not Found", 404);
      const kv = env?.SUB_LINKS;
      if (!kv) return textResponse("KV binding SUB_LINKS is not configured", 500);
      const longUrl = await kv.get(`s:${code}`);
      if (!longUrl) return textResponse("Short link not found", 404);
      return new Response(null, {
        status: 302,
        headers: {
          ...CORS_HEADERS,
          location: longUrl,
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/shorten") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method Not Allowed" }, 405);
      }
      const kv = env?.SUB_LINKS;
      if (!kv) return jsonResponse({ error: "KV binding SUB_LINKS is not configured" }, 500);

      let body = {};
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      const longUrlRaw = typeof body?.url === "string" ? body.url.trim() : "";
      if (!longUrlRaw) return jsonResponse({ error: "url is required" }, 400);

      let longUrl;
      try {
        longUrl = new URL(longUrlRaw);
      } catch {
        return jsonResponse({ error: "url is invalid" }, 400);
      }
      if (longUrl.pathname !== "/convert") {
        return jsonResponse({ error: "only /convert URL can be shortened" }, 400);
      }

      let code = "";
      try {
        code = await allocateShortCode(kv);
        await kv.put(`s:${code}`, longUrl.toString(), {
          metadata: { createdAt: Date.now() },
        });
      } catch (e) {
        return jsonResponse({ error: `shorten failed: ${e.message}` }, 500);
      }

      return jsonResponse({
        code,
        shortUrl: `${url.origin}/s/${code}`,
        longUrl: longUrl.toString(),
      });
    }

    if (url.pathname !== "/convert") {
      return textResponse("Not Found", 404);
    }

    try {
      const input = await resolveInput(request, url);
      const format = (url.searchParams.get("format") || "profile").toLowerCase();
      const remoteConfigUrl = url.searchParams.get("config");
      const subConverterCustom = remoteConfigUrl
        ? await fetchAndParseSubconverterConfig(remoteConfigUrl)
        : null;
      const parsed = await buildClashConfig(input, format, { subConverterCustom });

      if (parsed.proxies.length === 0) {
        return textResponse(
          `No supported nodes found.\nErrors:\n${parsed.errors.join("\n") || "(none)"}`,
          400,
        );
      }

      const yaml = toYaml(parsed.config);
      return new Response(yaml, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "content-type": "text/yaml; charset=utf-8",
          "x-parse-errors": String(parsed.errors.length),
        },
      });
    } catch (error) {
      return textResponse(`Convert failed: ${error.message}`, 500);
    }
  },
};

async function allocateShortCode(kv) {
  for (let i = 0; i < 8; i++) {
    const code = randomCode(7);
    const exists = await kv.get(`s:${code}`);
    if (!exists) return code;
  }
  throw new Error("failed to allocate short code");
}

function randomCode(len) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

async function resolveInput(request, url) {
  const sources = [];
  const directSub = [];

  const urlParams = url.searchParams.getAll("url");
  for (const raw of urlParams) {
    for (const item of splitMultiSourceSmart(raw)) {
      sources.push(item);
    }
  }

  const subParams = url.searchParams.getAll("sub");
  for (const raw of subParams) {
    if (raw.trim()) directSub.push(raw.trim());
  }

  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await request.json();
      const bodyUrls = Array.isArray(body?.urls) ? body.urls : body?.url ? [body.url] : [];
      for (const raw of bodyUrls) {
        for (const item of splitMultiSourceSmart(String(raw))) {
          sources.push(item);
        }
      }
      if (typeof body?.sub === "string" && body.sub.trim()) {
        directSub.push(body.sub.trim());
      }
    } else {
      const bodyText = (await request.text()).trim();
      if (bodyText) {
        const items = splitMultiSourceSmart(bodyText);
        const maybeLinks = items.filter((v) => /^https?:\/\//i.test(v));
        if (maybeLinks.length > 0) {
          sources.push(...maybeLinks);
          const rest = items.filter((v) => !/^https?:\/\//i.test(v));
          directSub.push(...rest);
        } else {
          directSub.push(bodyText);
        }
      }
    }
  }

  const lines = [];
  const errors = [];

  // Support mixed input in raw mode: node links + base64 + http subscription URLs.
  // If parsed items contain http(s) URLs, treat them as remote sources to fetch.
  for (const raw of directSub) {
    const items = extractNodeLines(raw);
    for (const item of items) {
      if (/^https?:\/\//i.test(item)) {
        sources.push(item);
      } else {
        lines.push(item);
      }
    }
  }

  for (const src of sources) {
    const normalized = normalizeInputToken(src);
    if (!normalized) {
      continue;
    }
    if (!/^https?:\/\//i.test(normalized)) {
      // Allow passing direct node links/base64 text via url parameter.
      const items = extractNodeLines(normalized);
      for (const item of items) {
        if (/^https?:\/\//i.test(item)) {
          sources.push(item);
        } else {
          lines.push(item);
        }
      }
      continue;
    }
    try {
      const resp = await fetch(normalized, {
        headers: {
          "user-agent": "sub-convert-worker/1.0",
          accept: "text/plain,*/*",
        },
      });
      if (!resp.ok) {
        errors.push(`fetch failed ${normalized}: HTTP ${resp.status}`);
        continue;
      }
      const text = await resp.text();
      lines.push(...extractNodeLines(text));
    } catch (e) {
      errors.push(`fetch failed ${normalized}: ${e.message}`);
    }
  }

  return {
    lines: unique(lines),
    errors,
  };
}

async function buildClashConfig(input, format = "profile", options = {}) {
  const proxies = [];
  const errors = [...input.errors];

  for (const line of input.lines) {
    if (!line || !line.includes("://")) continue;
    const scheme = line.slice(0, line.indexOf("://")).toLowerCase();

    try {
      let node = null;
      switch (scheme) {
        case "vless":
          node = parseVless(line);
          break;
        case "vmess":
          node = parseVmess(line);
          break;
        case "hysteria2":
        case "hy2":
          node = parseHysteria2(line);
          break;
        case "tuic":
          node = parseTuic(line);
          break;
        case "anytls":
          node = parseAnytls(line);
          break;
        case "ss":
          node = parseShadowsocks(line);
          break;
        case "trojan":
          node = parseTrojan(line);
          break;
        default:
          errors.push(`unsupported scheme: ${scheme}`);
          break;
      }
      if (node) proxies.push(node);
    } catch (e) {
      errors.push(`parse failed: ${line.slice(0, 80)}... -> ${e.message}`);
    }
  }

  dedupeProxyNames(proxies);

  const profileConfig = await buildProfileConfig(proxies, options);
  const providerConfig = { proxies };

  const config =
    format === "provider" || format === "proxy-provider" ? providerConfig : profileConfig;

  return { proxies, errors, config };
}

async function buildProfileConfig(proxies, options = {}) {
  const proxyNames = proxies.map((p) => p.name);
  const all = proxyNames.length ? proxyNames : ["DIRECT"];

  const defaultConfig = {
    "mixed-port": 7890,
    "allow-lan": true,
    mode: "Rule",
    "log-level": "info",
    "external-controller": "0.0.0.0:9090",
    dns: {
      enable: true,
      listen: "0.0.0.0:53",
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.18.0.1/16",
      "fake-ip-filter": [
        "*.lan",
        "cable.auth.com",
        "+.msftconnecttest.com",
        "+.msftncsi.com",
        "network-test.debian.org",
        "detectportal.firefox.com",
        "resolver1.opendns.com",
        "+.srv.nintendo.net",
        "+.stun.playstation.net",
        "xbox.*.microsoft.com",
        "+.xboxlive.com",
        "stun.*",
        "global.turn.twilio.com",
        "global.stun.twilio.com",
        "localhost.*.qq.com",
        "+.logon.battlenet.com.cn",
        "+.logon.battle.net",
        "+.blzstatic.cn",
        "+.cmpassport.com",
        "id6.me",
        "open.e.189.cn",
        "mdn.open.wo.cn",
        "opencloud.wostore.cn",
        "auth.wosms.cn",
        "+.jegotrip.com.cn",
        "+.icitymobile.mobi",
        "+.pingan.com.cn",
        "+.cmbchina.com",
        "+.cmbchina.com.cn",
        "pool.ntp.org",
        "+.pool.ntp.org",
        "ntp.*.com",
        "time.*.com",
        "ntp?.*.com",
        "time?.*.com",
        "time.*.gov",
        "time.*.edu.cn",
        "+.ntp.org.cn",
        "time.*.apple.com",
      ],
      "default-nameserver": ["223.5.5.5", "119.29.29.29"],
      nameserver: ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"],
      "nameserver-policy": {
        "geosite:cn": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"],
      },
      fallback: [
        "https://dns.google/dns-query",
        "https://cloudflare-dns.com/dns-query",
        "https://dns.quad9.net/dns-query",
      ],
      "fallback-filter": {
        geoip: true,
        "geoip-code": "CN",
        ipcidr: ["240.0.0.0/4", "0.0.0.0/32"],
        domain: [
          "+.google.com",
          "+.github.com",
          "+.facebook.com",
          "+.twitter.com",
          "+.youtube.com",
          "+.googleapis.com",
        ],
      },
    },
    proxies,
    "proxy-groups": [
      {
        name: "🚀 节点选择",
        type: "select",
        proxies: ["⚡ 自动选择", "DIRECT", ...all],
      },
      {
        name: "⚡ 自动选择",
        type: "url-test",
        url: "https://cp.cloudflare.com/generate_204",
        interval: 300,
        tolerance: 50,
        proxies: all,
      },
      {
        name: "💬 AI 服务",
        type: "select",
        proxies: ["🚀 节点选择", "⚡ 自动选择", "DIRECT", ...all],
      },
      {
        name: "📹 油管视频",
        type: "select",
        proxies: ["🚀 节点选择", "⚡ 自动选择", "DIRECT", ...all],
      },
      {
        name: "🔍 谷歌服务",
        type: "select",
        proxies: ["🚀 节点选择", "⚡ 自动选择", "DIRECT", ...all],
      },
      {
        name: "🔒 国内服务",
        type: "select",
        proxies: ["DIRECT", "🚀 节点选择"],
      },
      {
        name: "📲 电报消息",
        type: "select",
        proxies: ["🚀 节点选择", "⚡ 自动选择", "DIRECT", ...all],
      },
      {
        name: "🐱 Github",
        type: "select",
        proxies: ["🚀 节点选择", "⚡ 自动选择", "DIRECT", ...all],
      },
      {
        name: "🌐 非中国",
        type: "select",
        proxies: ["🚀 节点选择", "⚡ 自动选择", "DIRECT", ...all],
      },
      {
        name: "🐟 漏网之鱼",
        type: "select",
        proxies: ["🚀 节点选择", "⚡ 自动选择", "DIRECT", ...all],
      },
    ],
    rules: [
      "GEOSITE,cn,🔒 国内服务",
      "GEOIP,cn,🔒 国内服务",
      "DOMAIN-SUFFIX,openai.com,💬 AI 服务",
      "DOMAIN-SUFFIX,chatgpt.com,💬 AI 服务",
      "DOMAIN-SUFFIX,oaistatic.com,💬 AI 服务",
      "DOMAIN-SUFFIX,oaiusercontent.com,💬 AI 服务",
      "DOMAIN-SUFFIX,youtube.com,📹 油管视频",
      "DOMAIN-SUFFIX,youtu.be,📹 油管视频",
      "DOMAIN-SUFFIX,googlevideo.com,📹 油管视频",
      "DOMAIN-SUFFIX,ytimg.com,📹 油管视频",
      "DOMAIN-SUFFIX,google.com,🔍 谷歌服务",
      "DOMAIN-SUFFIX,googleapis.com,🔍 谷歌服务",
      "DOMAIN-SUFFIX,gstatic.com,🔍 谷歌服务",
      "DOMAIN-SUFFIX,github.com,🐱 Github",
      "DOMAIN-SUFFIX,githubusercontent.com,🐱 Github",
      "DOMAIN-SUFFIX,githubassets.com,🐱 Github",
      "DOMAIN-SUFFIX,gitlab.com,🐱 Github",
      "GEOIP,google,🔍 谷歌服务",
      "GEOIP,telegram,📲 电报消息",
      "MATCH,🐟 漏网之鱼",
    ],
  };

  const custom = options?.subConverterCustom;
  if (!custom || custom.enableRuleGenerator === false) {
    return defaultConfig;
  }

  const customGroups = buildGroupsFromSubConverter(custom, all);
  const customRules = await buildRulesFromSubConverter(custom);

  if (!customGroups.length && !customRules.length) {
    return defaultConfig;
  }

  return {
    ...defaultConfig,
    "proxy-groups": custom.overwriteOriginalRules
      ? customGroups.length
        ? customGroups
        : defaultConfig["proxy-groups"]
      : [...defaultConfig["proxy-groups"], ...customGroups],
    rules: custom.overwriteOriginalRules
      ? customRules.length
        ? customRules
        : defaultConfig.rules
      : [...defaultConfig.rules, ...customRules],
  };
}

async function fetchAndParseSubconverterConfig(configUrl) {
  let u;
  try {
    u = new URL(configUrl);
  } catch {
    throw new Error("invalid config URL");
  }
  if (!/^https?:$/i.test(u.protocol)) {
    throw new Error("config URL must be http/https");
  }

  const resp = await fetch(u.toString(), {
    headers: {
      "user-agent": "sub-convert-worker/1.0",
      accept: "text/plain,*/*",
    },
  });
  if (!resp.ok) {
    throw new Error(`fetch config failed: HTTP ${resp.status}`);
  }

  const text = await resp.text();
  return parseSubconverterCustomConfig(text);
}

function parseSubconverterCustomConfig(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter((v) => v && !v.startsWith("#") && !v.startsWith(";"));

  let inCustom = false;
  const out = {
    ruleset: [],
    proxyGroups: [],
    enableRuleGenerator: false,
    overwriteOriginalRules: false,
  };

  for (const line of lines) {
    if (/^\[custom\]$/i.test(line)) {
      inCustom = true;
      continue;
    }
    if (/^\[.+\]$/.test(line) && !/^\[custom\]$/i.test(line)) {
      inCustom = false;
      continue;
    }
    if (!inCustom) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();

    if (key === "ruleset") {
      out.ruleset.push(value);
    } else if (key === "custom_proxy_group") {
      out.proxyGroups.push(value);
    } else if (key === "enable_rule_generator") {
      out.enableRuleGenerator = /^true$/i.test(value);
    } else if (key === "overwrite_original_rules") {
      out.overwriteOriginalRules = /^true$/i.test(value);
    }
  }

  return out;
}

async function buildRulesFromSubConverter(custom) {
  const rules = [];
  const fetchCache = new Map();

  for (const raw of custom.ruleset || []) {
    const firstComma = raw.indexOf(",");
    if (firstComma <= 0) continue;

    const group = raw.slice(0, firstComma).trim();
    const rest = raw
      .slice(firstComma + 1)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!group || rest.length === 0) continue;

    const first = rest[0].startsWith("[]") ? rest[0].slice(2) : rest[0];
    const args = rest.slice(1);
    const firstUpper = first.toUpperCase();

    if (/^https?:\/\//i.test(first)) {
      const remoteRules = await fetchRulesetAsRules(first, group, fetchCache);
      rules.push(...remoteRules);
      continue;
    }

    if (firstUpper === "FINAL" || firstUpper === "MATCH") {
      rules.push(`MATCH,${group}`);
      continue;
    }

    if (
      firstUpper === "GEOSITE" ||
      firstUpper === "GEOIP" ||
      firstUpper === "DOMAIN" ||
      firstUpper === "DOMAIN-SUFFIX" ||
      firstUpper === "DOMAIN-KEYWORD" ||
      firstUpper === "IP-CIDR" ||
      firstUpper === "IP-CIDR6" ||
      firstUpper === "SRC-IP-CIDR" ||
      firstUpper === "SRC-PORT" ||
      firstUpper === "DST-PORT" ||
      firstUpper === "PROCESS-NAME" ||
      firstUpper === "PROCESS-PATH" ||
      firstUpper === "NETWORK" ||
      firstUpper === "IN-TYPE" ||
      firstUpper === "IN-PORT" ||
      firstUpper === "UID"
    ) {
      if (!args[0]) continue;
      const noResolve = args.slice(1).some((v) => String(v).toLowerCase() === "no-resolve");
      rules.push(`${firstUpper},${args[0]},${group}${noResolve ? ",no-resolve" : ""}`);
      continue;
    }

    if (firstUpper === "RULE-SET") {
      if (!args[0]) continue;
      const noResolve = args.slice(1).some((v) => String(v).toLowerCase() === "no-resolve");
      rules.push(`RULE-SET,${args[0]},${group}${noResolve ? ",no-resolve" : ""}`);
      continue;
    }

    // Unknown ruleset directive is ignored for compatibility safety.
  }

  return unique(rules);
}

function buildGroupsFromSubConverter(custom, allProxies) {
  const groups = [];

  for (const raw of custom.proxyGroups || []) {
    const seg = raw.split("`").map((s) => s.trim()).filter(Boolean);
    if (seg.length < 2) continue;

    const name = seg[0];
    const type = seg[1].toLowerCase();
    const tail = seg.slice(2);

    const opts = tail.filter((s) => s.startsWith("[]")).map((s) => s.slice(2));
    const hasAll = tail.includes(".*");
    const proxies = unique([
      ...opts.filter(Boolean),
      ...(hasAll ? allProxies : []),
    ]);

    if (type === "select") {
      groups.push({
        name,
        type: "select",
        proxies: proxies.length ? proxies : allProxies,
      });
      continue;
    }

    if (type === "url-test" || type === "fallback" || type === "load-balance") {
      const url = tail.find((v) => /^https?:\/\//i.test(v)) || "http://www.gstatic.com/generate_204";
      const numSeg = tail.find((v) => /^\d+(,\d*)*(,\d+)?$/.test(v)) || "300,,50";
      const nums = numSeg.split(",");
      const interval = Number(nums[0] || 300);
      const tolerance = Number(nums[2] || 50);

      const g = {
        name,
        type,
        url,
        interval: Number.isFinite(interval) ? interval : 300,
        proxies: proxies.length ? proxies : allProxies,
      };
      if (type === "url-test") g.tolerance = Number.isFinite(tolerance) ? tolerance : 50;
      if (type === "load-balance") g.strategy = "consistent-hashing";
      groups.push(g);
    }
  }

  return groups;
}

function parseVless(raw) {
  const u = new URL(raw);
  const name = decodeName(u.hash.slice(1), `vless-${u.hostname}:${u.port || 443}`);

  const network = (u.searchParams.get("type") || "tcp").toLowerCase();
  const security = (u.searchParams.get("security") || "").toLowerCase();
  const isTls = security === "tls" || security === "reality";

  const node = {
    name,
    type: "vless",
    server: u.hostname,
    port: toPort(u.port, 443),
    uuid: decodeURIComponent(u.username),
    network,
    udp: true,
  };

  if (isTls) node.tls = true;

  const flow = u.searchParams.get("flow");
  if (flow) node.flow = flow;

  const sni = u.searchParams.get("sni");
  if (sni) node.servername = sni;

  const fp = u.searchParams.get("fp");
  if (fp) node["client-fingerprint"] = fp;

  const alpn = splitCsv(u.searchParams.get("alpn"));
  if (alpn.length) node.alpn = alpn;

  if (network === "ws") {
    node["ws-opts"] = {
      path: decodeURIComponent(u.searchParams.get("path") || "/"),
    };
    const host = u.searchParams.get("host");
    if (host) {
      node["ws-opts"].headers = { Host: host };
    }
  }

  if (network === "grpc") {
    node["grpc-opts"] = {
      "grpc-service-name": decodeURIComponent(u.searchParams.get("serviceName") || ""),
    };
  }

  if (security === "reality") {
    node["reality-opts"] = {
      "public-key": u.searchParams.get("pbk") || "",
      "short-id": u.searchParams.get("sid") || "",
    };
  }

  return node;
}

function parseVmess(raw) {
  const encoded = raw.slice("vmess://".length).trim();
  const decoded = decodeBase64Text(encoded);
  let data;
  try {
    data = JSON.parse(decoded);
  } catch {
    throw new Error("vmess node is not valid base64 json");
  }

  const network = (data.net || "tcp").toLowerCase();
  const tls = String(data.tls || "").toLowerCase() === "tls";
  const name = decodeName(data.ps, `vmess-${data.add}:${data.port || 443}`);

  const node = {
    name,
    type: "vmess",
    server: data.add,
    port: toPort(data.port, 443),
    uuid: data.id,
    alterId: Number(data.aid || 0),
    cipher: data.scy || "auto",
    network,
    udp: true,
  };

  if (tls) node.tls = true;

  if (data.sni) node.servername = data.sni;
  if (data.fp) node["client-fingerprint"] = data.fp;

  if (network === "ws") {
    node["ws-opts"] = {
      path: data.path || "/",
    };
    if (data.host) {
      node["ws-opts"].headers = { Host: data.host };
    }
  }

  if (network === "grpc") {
    node["grpc-opts"] = {
      "grpc-service-name": data.path || data.serviceName || "",
    };
  }

  return node;
}

function parseHysteria2(raw) {
  const u = new URL(raw);
  const name = decodeName(u.hash.slice(1), `hy2-${u.hostname}:${u.port || 443}`);
  const node = {
    name,
    type: "hysteria2",
    server: u.hostname,
    port: toPort(u.port, 443),
    password: decodeURIComponent(u.username || ""),
    udp: true,
  };

  const sni = u.searchParams.get("sni");
  if (sni) node.sni = sni;

  const insecure = u.searchParams.get("insecure");
  if (insecure === "1" || insecure === "true") node["skip-cert-verify"] = true;

  const alpn = splitCsv(u.searchParams.get("alpn"));
  if (alpn.length) node.alpn = alpn;

  const obfs = u.searchParams.get("obfs");
  if (obfs) {
    node.obfs = obfs;
    const obfsPwd = u.searchParams.get("obfs-password") || u.searchParams.get("obfsPassword");
    if (obfsPwd) node["obfs-password"] = obfsPwd;
  }

  return node;
}

function parseTuic(raw) {
  const u = new URL(raw);
  const name = decodeName(u.hash.slice(1), `tuic-${u.hostname}:${u.port || 443}`);

  const node = {
    name,
    type: "tuic",
    server: u.hostname,
    port: toPort(u.port, 443),
    udp: true,
  };

  if (u.username && u.password) {
    node.uuid = decodeURIComponent(u.username);
    node.password = decodeURIComponent(u.password);
  } else if (u.username) {
    node.token = decodeURIComponent(u.username);
  }

  const sni = u.searchParams.get("sni");
  if (sni) node.sni = sni;

  const insecure = u.searchParams.get("insecure");
  if (insecure === "1" || insecure === "true") node["skip-cert-verify"] = true;

  const alpn = splitCsv(u.searchParams.get("alpn"));
  if (alpn.length) node.alpn = alpn;

  const cc = u.searchParams.get("congestion_control") || u.searchParams.get("congestion-controller");
  if (cc) node["congestion-controller"] = cc;

  const udpRelayMode = u.searchParams.get("udp_relay_mode") || u.searchParams.get("udp-relay-mode");
  if (udpRelayMode) node["udp-relay-mode"] = udpRelayMode;

  return node;
}

function parseAnytls(raw) {
  const u = new URL(raw);
  const name = decodeName(u.hash.slice(1), `anytls-${u.hostname}:${u.port || 443}`);

  const user = decodeURIComponent(u.username || "");
  const pass = decodeURIComponent(u.password || "");
  const password = pass || user;

  const node = {
    name,
    type: "anytls",
    server: u.hostname,
    port: toPort(u.port, 443),
    password,
    udp: true,
  };

  const sni = u.searchParams.get("sni");
  if (sni) node.sni = sni;

  const insecure = u.searchParams.get("insecure");
  if (insecure === "1" || insecure === "true") node["skip-cert-verify"] = true;

  const fp = u.searchParams.get("fp") || u.searchParams.get("client-fingerprint");
  if (fp) node["client-fingerprint"] = fp;

  const alpn = splitCsv(u.searchParams.get("alpn"));
  if (alpn.length) node.alpn = alpn;

  return node;
}

function parseShadowsocks(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }

  // ss://BASE64(method:password@host:port)#name
  if (!u || (!u.hostname && !u.port)) {
    return parseLegacySs(raw);
  }

  const name = decodeName(u.hash.slice(1), `ss-${u.hostname}:${u.port || 443}`);
  let cipher = "";
  let password = "";
  let server = u.hostname;
  let port = toPort(u.port, 443);

  if (u.password) {
    // ss://method:password@host:port
    cipher = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  } else if (u.username) {
    // ss://BASE64(method:password)@host:port
    const decoded = decodeMaybeBase64Text(decodeURIComponent(u.username));
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      cipher = decoded.slice(0, idx);
      password = decoded.slice(idx + 1);
    }
  }

  if (!cipher || !password || !server || !port) {
    return parseLegacySs(raw);
  }

  const node = {
    name,
    type: "ss",
    server,
    port,
    cipher,
    password,
    udp: true,
  };

  attachSsPlugin(node, u.searchParams.get("plugin"));
  return node;
}

function parseTrojan(raw) {
  const u = new URL(raw);
  const network = (u.searchParams.get("type") || "tcp").toLowerCase();
  const name = decodeName(u.hash.slice(1), `trojan-${u.hostname}:${u.port || 443}`);

  const node = {
    name,
    type: "trojan",
    server: u.hostname,
    port: toPort(u.port, 443),
    password: decodeURIComponent(u.username || ""),
    udp: true,
    network,
  };

  const sni = u.searchParams.get("sni") || u.searchParams.get("peer");
  if (sni) node.sni = sni;

  const alpn = splitCsv(u.searchParams.get("alpn"));
  if (alpn.length) node.alpn = alpn;

  const insecure = u.searchParams.get("allowInsecure") || u.searchParams.get("insecure");
  if (insecure === "1" || insecure === "true") node["skip-cert-verify"] = true;

  const fp = u.searchParams.get("fp") || u.searchParams.get("client-fingerprint");
  if (fp) node["client-fingerprint"] = fp;

  if (network === "ws") {
    node["ws-opts"] = {
      path: decodeURIComponent(u.searchParams.get("path") || "/"),
    };
    const host = u.searchParams.get("host");
    if (host) {
      node["ws-opts"].headers = { Host: host };
    }
  }

  if (network === "grpc") {
    node["grpc-opts"] = {
      "grpc-service-name": decodeURIComponent(
        u.searchParams.get("serviceName") || u.searchParams.get("mode") || "",
      ),
    };
  }

  return node;
}

function parseLegacySs(raw) {
  const m = raw.match(/^ss:\/\/([^#?]+)(\?[^#]*)?(#.*)?$/i);
  if (!m) {
    throw new Error("invalid ss URI");
  }

  const payload = m[1];
  const query = m[2] || "";
  const hash = m[3] || "";
  const name = decodeName(hash.replace(/^#/, ""), "ss-node");

  const decoded = decodeMaybeBase64Text(payload);
  if (!decoded.includes("@")) {
    throw new Error("invalid legacy ss payload");
  }

  const at = decoded.lastIndexOf("@");
  const auth = decoded.slice(0, at);
  const hostPart = decoded.slice(at + 1);
  const authSep = auth.indexOf(":");
  if (authSep <= 0) {
    throw new Error("invalid ss cipher/password");
  }
  const cipher = auth.slice(0, authSep);
  const password = auth.slice(authSep + 1);

  const hostSep = hostPart.lastIndexOf(":");
  if (hostSep <= 0) {
    throw new Error("invalid ss host/port");
  }
  const server = hostPart.slice(0, hostSep);
  const port = toPort(hostPart.slice(hostSep + 1), 443);

  const node = {
    name,
    type: "ss",
    server,
    port,
    cipher,
    password,
    udp: true,
  };

  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  attachSsPlugin(node, params.get("plugin"));
  return node;
}

function attachSsPlugin(node, pluginValue) {
  if (!pluginValue) return;
  const decoded = decodeURIComponent(pluginValue);
  const parts = decoded.split(";");
  if (!parts.length) return;
  const plugin = parts[0].trim();
  if (!plugin) return;
  node.plugin = plugin;

  if (parts.length > 1) {
    const opts = {};
    for (const seg of parts.slice(1)) {
      const idx = seg.indexOf("=");
      if (idx <= 0) continue;
      const k = seg.slice(0, idx).trim();
      const v = seg.slice(idx + 1).trim();
      if (!k) continue;
      opts[k] = v;
    }
    if (Object.keys(opts).length) {
      node["plugin-opts"] = opts;
    }
  }
}

function extractNodeLines(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];

  const maybeDecoded = decodeMaybeBase64(trimmed);
  return maybeDecoded
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter((v) => v && !v.startsWith("#") && v.includes("://"));
}

function decodeMaybeBase64(text) {
  if (text.includes("://")) return text;

  const raw = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_=-]+$/.test(raw)) return text;

  try {
    const decoded = decodeBase64Text(raw);
    if (decoded.includes("://") || decoded.includes("\n")) {
      return decoded;
    }
    return text;
  } catch {
    return text;
  }
}

function decodeBase64Text(input) {
  const normalized = normalizeBase64(input);

  if (typeof atob === "function") {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  return Buffer.from(normalized, "base64").toString("utf8");
}

function decodeMaybeBase64Text(input) {
  try {
    return decodeBase64Text(input);
  } catch {
    return input;
  }
}

function normalizeBase64(v) {
  let s = v.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const mod = s.length % 4;
  if (mod === 2) s += "==";
  else if (mod === 3) s += "=";
  else if (mod === 1) s += "===";
  return s;
}

function decodeName(raw, fallback) {
  const val = (raw || "").trim();
  if (!val) return fallback;
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function splitCsv(v) {
  if (!v) return [];
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function splitMultiSource(raw) {
  return String(raw || "")
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function splitMultiSourceSmart(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];

  if (s.includes("\n")) {
    return s
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  const httpCount = (s.match(/https?:\/\//gi) || []).length;
  if (httpCount > 1 && s.includes(",")) {
    return s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [s];
}

function normalizeInputToken(value) {
  let s = String(value || "").trim();
  if (!s) return "";

  // Strip accidental wrapping quotes.
  s = s.replace(/^['"]+|['"]+$/g, "").trim();
  if (!s) return "";

  // Decode once when URL was accidentally double-encoded in query string.
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      const once = decodeURIComponent(s);
      if (once && once !== s) s = once.trim();
    } catch {
      // keep original
    }
  }

  return s;
}

async function fetchRulesetAsRules(ruleUrl, group, cache) {
  const key = `${ruleUrl}@@${group}`;
  if (cache.has(key)) return cache.get(key);

  const promise = (async () => {
    const resp = await fetch(ruleUrl, {
      headers: {
        "user-agent": "sub-convert-worker/1.0",
        accept: "text/plain,*/*",
      },
    });
    if (!resp.ok) {
      throw new Error(`fetch ruleset failed: ${ruleUrl} HTTP ${resp.status}`);
    }
    const text = await resp.text();
    return parseRulesetTextToRules(text, group);
  })();

  cache.set(key, promise);
  return promise;
}

function parseRulesetTextToRules(text, group) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);

  for (let raw of lines) {
    raw = String(raw || "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith(";") || raw.startsWith("//")) continue;
    if (/^payload\s*:/i.test(raw)) continue;
    if (raw.startsWith("-")) raw = raw.slice(1).trim();
    if (!raw) continue;
    raw = raw.replace(/^['"]+|['"]+$/g, "");

    const parts = raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!parts.length) continue;

    const type = parts[0].toUpperCase();
    const known = new Set([
      "DOMAIN",
      "DOMAIN-SUFFIX",
      "DOMAIN-KEYWORD",
      "GEOSITE",
      "GEOIP",
      "IP-CIDR",
      "IP-CIDR6",
      "SRC-IP-CIDR",
      "SRC-PORT",
      "DST-PORT",
      "PROCESS-NAME",
      "PROCESS-PATH",
      "NETWORK",
      "IN-TYPE",
      "IN-PORT",
      "UID",
      "MATCH",
    ]);

    if (!known.has(type)) continue;
    if (type === "MATCH") {
      out.push(`MATCH,${group}`);
      continue;
    }
    if (!parts[1]) continue;

    const tailFlags = parts
      .slice(2)
      .filter((v) => String(v).toLowerCase() === "no-resolve");
    out.push(`${type},${parts[1]},${group}${tailFlags.length ? ",no-resolve" : ""}`);
  }

  return out;
}

function unique(arr) {
  return [...new Set(arr)];
}

function toPort(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function dedupeProxyNames(proxies) {
  const counter = new Map();
  for (const p of proxies) {
    const base = p.name || `${p.type}-${p.server}:${p.port}`;
    const count = (counter.get(base) || 0) + 1;
    counter.set(base, count);
    p.name = count === 1 ? base : `${base}-${count}`;
  }
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function toYaml(value, indent = 0) {
  return yamlLines(value, indent).join("\n");
}

function yamlLines(value, indent) {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines = [];
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${yamlScalar(item)}`);
      } else {
        lines.push(`${pad}-`);
        lines.push(...yamlLines(item, indent + 1));
      }
    }
    return lines;
  }

  if (value && typeof value === "object") {
    const lines = [];
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;
      const k = yamlKey(key);
      if (isScalar(val)) {
        lines.push(`${pad}${k}: ${yamlScalar(val)}`);
      } else if (Array.isArray(val) && val.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else {
        lines.push(`${pad}${k}:`);
        lines.push(...yamlLines(val, indent + 1));
      }
    }
    return lines;
  }

  return [`${pad}${yamlScalar(value)}`];
}

function isScalar(v) {
  return v === null || v === undefined || typeof v !== "object";
}

function yamlScalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";

  const s = String(v);
  if (s === "") return '""';
  if (/^[A-Za-z0-9._/@:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function yamlKey(key) {
  const s = String(key);
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  return JSON.stringify(s);
}
