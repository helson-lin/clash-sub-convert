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
      const parsed = buildClashConfig(input, format);

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
      directSub.push(normalized);
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

function buildClashConfig(input, format = "profile") {
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

  const profileConfig = buildProfileConfig(proxies);
  const providerConfig = { proxies };

  const config =
    format === "provider" || format === "proxy-provider" ? providerConfig : profileConfig;

  return { proxies, errors, config };
}

function buildProfileConfig(proxies) {
  const proxyNames = proxies.map((p) => p.name);
  const all = proxyNames.length ? proxyNames : ["DIRECT"];

  return {
    "mixed-port": 7890,
    "tcp-concurrent": false,
    "allow-lan": true,
    ipv6: true,
    mode: "Rule",
    "log-level": "info",
    "global-client-fingerprint": "chrome",
    "find-process-mode": "strict",
    "external-controller": "0.0.0.0:9090",
    "geodata-mode": true,
    "geo-auto-update": true,
    "geo-update-interval": 3,
    "geox-url": {
      geoip: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat",
      geosite: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat",
      mmdb: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb",
      asn: "https://mirror.ghproxy.com/https://github.com/xishang0128/geoip/releases/download/latest/GeoLite2-ASN.mmdb",
    },
    profile: {
      "store-selected": true,
      "store-fake-ip": true,
    },
    sniffer: {
      enable: true,
      "parse-pure-ip": true,
      sniff: {
        HTTP: {
          ports: [80, "8080-8800"],
          "override-destination": true,
        },
        TLS: {
          ports: [443, 8443],
        },
        QUIC: {
          ports: [443, 8443],
        },
      },
      "skip-domain": ["Mijia Cloud", "dlg.io.mi.com", "+.apple.com"],
    },
    tun: {
      enable: false,
      stack: "mixed",
      "dns-hijack": ["any:53"],
      "auto-route": true,
      "auto-detect-interface": true,
    },
    dns: {
      enable: true,
      ipv6: true,
      "prefer-h3": true,
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
      "nameserver-policy": {
        "www.baidu.com": "114.114.114.114",
        "+.internal.crop.com": "10.0.0.1",
        "www.baidu.com,+.google.cn": "https://doh.pub/dns-query",
        "geosite:private,apple": "https://dns.alidns.com/dns-query",
        "rule-set:google": "8.8.8.8",
      },
      nameserver: ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"],
      fallback: [
        "https://1.1.1.2/dns-query",
        "https://1.0.0.2/dns-query",
        "https://208.67.222.222/dns-query",
        "https://208.67.220.220/dns-query",
        "https://9.9.9.9/dns-query",
      ],
      "fallback-filter": {
        geoip: true,
        "geoip-code": "CN",
        geosite: ["gfw"],
        ipcidr: ["240.0.0.0/4", "0.0.0.0/32"],
        domain: [
          "+.google.com",
          "+.github.com",
          "+.facebook.com",
          "+.twitter.com",
          "+.youtube.com",
          "+.google.cn",
          "+.googleapis.cn",
          "+.googleapis.com",
        ],
      },
    },
    proxies,
    "proxy-groups": [
      {
        name: "PROXY",
        type: "select",
        proxies: ["LOAD-BALANCE", "SELECT", "FALLBACK", "DIRECT"],
      },
      {
        name: "SELECT",
        type: "select",
        proxies: all,
      },
      {
        name: "LOAD-BALANCE",
        type: "load-balance",
        url: "https://cp.cloudflare.com/generate_204",
        interval: 3600,
        strategy: "consistent-hashing",
        proxies: all,
      },
      {
        name: "FALLBACK",
        type: "fallback",
        url: "https://cp.cloudflare.com/generate_204",
        interval: 3600,
        proxies: all,
      },
      {
        name: "FINAL",
        type: "select",
        proxies: ["PROXY", "DIRECT"],
      },
    ],
    "rule-providers": {
      reject: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt",
        path: "./ruleset/reject.yaml",
        interval: 86400,
      },
      icloud: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/icloud.txt",
        path: "./ruleset/icloud.yaml",
        interval: 86400,
      },
      apple: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/apple.txt",
        path: "./ruleset/apple.yaml",
        interval: 86400,
      },
      google: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/google.txt",
        path: "./ruleset/google.yaml",
        interval: 86400,
      },
      proxy: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt",
        path: "./ruleset/proxy.yaml",
        interval: 86400,
      },
      direct: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt",
        path: "./ruleset/direct.yaml",
        interval: 86400,
      },
      private: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt",
        path: "./ruleset/private.yaml",
        interval: 86400,
      },
      gfw: {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt",
        path: "./ruleset/gfw.yaml",
        interval: 86400,
      },
      "tld-not-cn": {
        type: "http",
        behavior: "domain",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/tld-not-cn.txt",
        path: "./ruleset/tld-not-cn.yaml",
        interval: 86400,
      },
      telegramcidr: {
        type: "http",
        behavior: "ipcidr",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/telegramcidr.txt",
        path: "./ruleset/telegramcidr.yaml",
        interval: 86400,
      },
      cncidr: {
        type: "http",
        behavior: "ipcidr",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt",
        path: "./ruleset/cncidr.yaml",
        interval: 86400,
      },
      lancidr: {
        type: "http",
        behavior: "ipcidr",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/lancidr.txt",
        path: "./ruleset/lancidr.yaml",
        interval: 86400,
      },
      applications: {
        type: "http",
        behavior: "classical",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/applications.txt",
        path: "./ruleset/applications.yaml",
        interval: 86400,
      },
    },
    rules: [
      "RULE-SET,reject,REJECT",
      "RULE-SET,apple,DIRECT",
      "RULE-SET,applications,DIRECT",
      "RULE-SET,cncidr,DIRECT",
      "RULE-SET,direct,DIRECT",
      "RULE-SET,icloud,DIRECT",
      "RULE-SET,lancidr,DIRECT",
      "RULE-SET,private,DIRECT",
      "RULE-SET,proxy,PROXY",
      "RULE-SET,gfw,PROXY",
      "RULE-SET,google,PROXY",
      "RULE-SET,telegramcidr,PROXY",
      "RULE-SET,tld-not-cn,PROXY",
      "GEOIP,LAN,DIRECT",
      "GEOIP,CN,DIRECT",
      "MATCH,FINAL",
    ],
  };
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
