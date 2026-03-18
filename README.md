# Clash.Meta Subscription Converter (Worker + Pages)

将 `vless / vmess / hysteria2 / tuic / anytls / ss / trojan` 订阅内容转换为 Clash.Meta YAML，支持固定分流策略、短链、Web 界面。

## 1. 项目结构

- `src/index.js`：Cloudflare Worker API（转换 + 短链）
- `pages/`：Cloudflare Pages 前端
- `wrangler.toml`：Worker 配置（含 KV 绑定）

## 2. 前置要求

- Node.js 18+
- Cloudflare 账号（邮箱已验证）
- Wrangler 已可登录

```bash
npx wrangler whoami
```

如果未登录：

```bash
npx wrangler login
```

## 3. 安装依赖

```bash
npm install
```

## 4. 配置 Worker KV（短链必需）

短链功能依赖 KV 绑定 `SUB_LINKS`。

### 4.1 创建 KV namespace

```bash
npx wrangler kv namespace create SUB_LINKS
npx wrangler kv namespace create SUB_LINKS --preview
```

### 4.2 填写 `wrangler.toml`

把命令返回的 `id` / `preview_id` 写入：

```toml
[[kv_namespaces]]
binding = "SUB_LINKS"
id = "<PROD_NAMESPACE_ID>"
preview_id = "<PREVIEW_NAMESPACE_ID>"
```

## 5. 部署 Worker

```bash
npm run deploy
```

部署成功后拿到 Worker 域名，例如：

- `https://convert.oimi.cc.cd`
- 或 `https://sub-convert-worker.<subdomain>.workers.dev`

## 6. 部署 Pages 前端

### 6.1 首次创建 Pages 项目（只做一次）

```bash
npx wrangler pages project create sub-convert-ui
```

### 6.2 发布前端

```bash
npm run deploy-page
```

等价命令：

```bash
npx wrangler pages deploy pages --project-name sub-convert-ui
```

## 7. 本地开发与预览

### Worker 本地调试

```bash
npm run dev
```

### Pages 本地预览

```bash
npx wrangler pages dev pages
```

## 8. API 说明

### 8.1 转换接口

- `GET /convert?url=<订阅地址>`
- `GET /convert?url=<url1>&url=<url2>`
- `POST /convert`

可选参数：

- `format=profile|provider`
  - `profile`（默认）：完整 Clash.Meta 配置
  - `provider`：仅输出 `proxies:`（给 `proxy-providers`）
- `udp443cnPolicy=<策略组名>`（仅 `profile` 生效，默认 `DIRECT`）
  - 对应规则：`AND,((DST-PORT,443),(NETWORK,UDP),(GEOIP,CN)),<策略>`

POST JSON 示例：

```json
{
  "urls": ["https://example.com/sub1", "https://example.com/sub2"]
}
```

或者：

```json
{
  "sub": "可混写：http(s)订阅地址 + 节点链接 + base64"
}
```

### 8.2 短链接口

- `POST /shorten`：将 `/convert?...` 长链接写入 KV
- `GET /s/<code>`：302 跳转到长链接

请求示例：

```json
{
  "url": "https://<worker>/convert?format=provider&url=https%3A%2F%2Fexample.com%2Fsub"
}
```

响应示例：

```json
{
  "code": "Ab3dE9x",
  "shortUrl": "https://<worker>/s/Ab3dE9x",
  "longUrl": "https://<worker>/convert?..."
}
```

## 9. 固定分流策略（profile 模式）

- 主分组：`节点选择`、`自动测速`
- 自动附带固定规则集（不可在前端编辑）
- 规则源：
  - `iab0x00/ProxyRules`（AI）
  - `blackmatrix7/ios_rule_script`（其他）

## 10. 前端功能

- 中英双语（默认按浏览器语言自动选择，可手动切换）
- YAML 高亮预览（highlight.js）
- 一键复制 YAML / 下载 YAML
- 一键生成并复制 GET 订阅链接
- 一键生成并复制短链（依赖 KV）

## 11. 快速验证

### 11.1 provider 输出

```text
https://<worker>/convert?format=provider&url=https://example.com/sub
```

### 11.2 profile 输出

```text
https://<worker>/convert?format=profile&url=https://example.com/sub
```

### 11.3 短链重定向

1. 调用 `POST /shorten` 获取 `shortUrl`
2. 打开 `shortUrl` 应跳转到原始 `/convert?...` 长链接

## 12. 常见问题

- `You need to verify your email address to use Workers`
  - Cloudflare 账号邮箱未验证，去控制台完成验证后重试。

- `KV binding SUB_LINKS is not configured`
  - 未创建 KV 或未把 namespace ID 写入 `wrangler.toml`。

- 页面改了但线上没变化
  - 重新执行 `npm run deploy-page`，并浏览器强制刷新（`Cmd/Ctrl + Shift + R`）。
