# Cloudflare Worker: 订阅转 Clash

把 `vless/vmess/hysteria2/tuic/anytls` 订阅内容转换成 Clash(Meta) YAML。

## 1. 本地开发

```bash
npm install
npm run dev
```

## 2. 部署

先创建 KV（用于短链）并把 `wrangler.toml` 里的 `id/preview_id` 替换成你的值：

```bash
npx wrangler kv namespace create SUB_LINKS
npx wrangler kv namespace create SUB_LINKS --preview
```

然后部署：

```bash
npm run deploy
```

## 3. 接口

- `GET /convert?url=<订阅地址>`
- `GET /convert?url=<url1>,<url2>`
- `POST /convert`
- `POST /shorten`（把 GET 长链接写入 KV，返回短链）
- `GET /s/<code>`（短链重定向到长链接）

### 可选参数

- `format=profile|provider`
  - `profile`（默认）：完整 Clash.Meta 配置
  - `provider`：仅输出 `proxies:`（用于 `proxy-providers`）
- `udp443cnPolicy=<策略组名>`（仅 `profile` 生效，默认 `DIRECT`）
  - 控制规则：`AND,((DST-PORT,443),(NETWORK,UDP),(GEOIP,CN)),<策略>`
  - 可设为：`DIRECT`、`节点选择`、`自动测速`、`REJECT` 或你自定义的组名

### 固定分流策略（不可修改）

- `format=profile` 时自动附带分流策略
- 主分组固定为：
  - `节点选择`
  - `自动测速`
- 已内置：
  - `AI / YOUTUBE / NETFLIX / DISNEY+ / MAX / SPOTIFY / TELEGRAM / PAYPAL / TWITTER / FACEBOOK / AMAZON / 游戏平台 / 微软服务 / 谷歌服务 / 苹果服务 / 哔哩哔哩 / TIKTOK / 节点选择 / DIRECT`
- 规则源来自：
  - `iab0x00/ProxyRules`（AI）
  - `blackmatrix7/ios_rule_script`（其余规则）

### POST body 示例（JSON）

```json
{
  "urls": ["https://example.com/sub1", "https://example.com/sub2"]
}
```

### POST body 示例（纯文本）

- 直接发订阅链接（每行一个）
- 或直接发节点文本 / base64 订阅内容
- 支持混写：`http(s)订阅地址 + 节点链接 + base64`（会自动识别并合并）

### 短链接口示例

```json
POST /shorten
{
  "url": "https://<worker>/convert?format=provider&url=https%3A%2F%2Fexample.com%2Fsub"
}
```

返回：

```json
{
  "code": "Ab3dE9x",
  "shortUrl": "https://<worker>/s/Ab3dE9x",
  "longUrl": "https://<worker>/convert?..."
}
```

## 4. 支持协议

- vless
- vmess
- hysteria2 (hy2)
- tuic
- anytls
- ss
- trojan

## 5. 示例

```text
https://<your-worker>.workers.dev/convert?url=https://example.com/sub
```

```text
https://<your-worker>.workers.dev/convert?format=provider&url=https://example.com/sub
```

## 6. Pages 前端界面（方案 A）

前端文件目录：`pages/`

- 样式：`Tailwind CSS (CDN)`
- YAML 预览：`highlight.js` 语法高亮
- 支持一键生成并复制 GET 订阅链接
- 支持一键生成短链（依赖 Worker KV）

### 本地预览（可选）

```bash
npx wrangler pages dev pages
```

### 部署到 Cloudflare Pages

```bash
npx wrangler pages project create sub-convert-ui
npx wrangler pages deploy pages --project-name sub-convert-ui
```

部署后打开 Pages 地址，在页面里填写你的 Worker 地址：

```text
https://sub-convert-worker.<your-subdomain>.workers.dev
```
