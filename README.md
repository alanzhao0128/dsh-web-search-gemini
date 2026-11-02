# dsh-web-search-gemini

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的联网搜索提供方（provider id：`cpa-gemini`）。它把 DSH 自带的 `web_search` 工具的后端换成 **Gemini 的 Google 搜索（grounding）**，经由 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的 Anthropic 兼容 `/v1/messages` 端点调用。

不新增任何工具：模型看到的仍是 DSH 原生的 `web_search`，本插件只是向 `ctx.web` 注册一个搜索提供方，由配置 `web.searchProvider` 选中。

## 为什么需要它

把 DSH 官方的 `deepseek-official` 提供方直接指向 CLIProxyAPI 的 Gemini 也能搜索，但结果不好用：

| | 官方 `deepseek-official` 指向 Gemini | 本插件 `cpa-gemini` |
|---|---|---|
| 来源链接 | 常是 `vertexaisearch.cloud.google.com/grounding-api-redirect/…` 跳转链接，`web_fetch` 拒绝跨域跳转，抓不了 | 搜索时还原成真实网址 |
| 摘要 | 只取每个链接的第一段引用 | 合并同一链接的所有引用（去重，` … ` 连接） |
| 模型总结 | 丢弃 | 可选返回，带前缀 `Search summary (model-generated; verify against sources):` |

跳转链接的还原只读取 `location` 响应头，不访问目标站点；只处理 `vertexaisearch.cloud.google.com` 的链接；失败或超时保留原链接，不影响搜索。

每次搜索会在会话里记一条 `web/cpa-gemini-search-request` 事件（endpoint、apiVersion、请求体，不含密钥）。

## 前提

- 一个可用的 CLIProxyAPI 实例，账号池里有 Gemini，并且它能把 Anthropic 格式的 `web_search_20250305` 工具转成 Gemini 的 Google 搜索。可以这样自测：向 `<baseURL>/messages` 发一个带该工具的请求，响应里应有 `web_search_tool_result` 块。
- DSH 0.2.1-rc.5 前后版本（peer 依赖按此版本声明）。

## 配置

行 id `web-search-gemini`。所有字段每次搜索时重新读取，改完不用重启。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | 空（**必填**） | CLIProxyAPI 地址，含 `/v1`，请求发往 `baseURL + "/messages"`；未设置时提供方不可用 |
| `apiKeyEnv` | `CLIPROXY_API_KEY` | 凭据引用名，经 DSH credentials 服务或启动环境解析 |
| `apiKey` | 空 | 明文密钥（可选，不推荐） |
| `model` | `gemini-3.8-flash-high` | 模型名，按你的 CLIProxyAPI 模型列表填写 |
| `apiVersion` | `2023-06-01` | `anthropic-version` 头 |
| `maxTokens` | `4096` | 生成上限 |
| `maxUses` | `2` | 单次请求里模型最多搜索几次 |
| `resolveRedirects` | `true` | 是否还原 grounding 跳转链接 |
| `resolveTimeoutMs` | `5000` | 每个跳转链接的解析超时（毫秒） |
| `includeAnswer` | `true` | 是否返回模型总结 |
| `answerMaxChars` | `1200` | 总结字数上限（超出以 `…` 截断） |
| `snippetMaxChars` | `300` | 单条摘要字数上限 |

## 安装

本包未发布到 npm，克隆后本地构建，再用 `link:` 挂到 DSH profile（下文以 `desktop` profile 为例）。

```sh
git clone https://github.com/alanzhao0128/dsh-web-search-gemini.git
cd dsh-web-search-gemini
npm install && npm run build
```

1. `~/.dsh/profiles/desktop/package.json`：加依赖并加入 bundles，然后在该目录执行 `pnpm install`。

   ```json
   {
     "dependencies": {
       "@alanzhao/dsh-web-search-gemini": "link:/path/to/dsh-web-search-gemini"
     },
     "dsh": { "profile": { "bundles": ["@alanzhao/dsh-web-search-gemini"] } }
   }
   ```

2. 完整退出并重启 DSH，让插件加载。

3. `~/.dsh/profiles/desktop/cordis.patch.yml`：填好配置，并把搜索提供方指向 `cpa-gemini`。这一步改完不用重启；若在第 2 步之前就改，插件加载前的搜索会报 `WEB_PROVIDER_CONFIGURED_MISSING`。

   ```yaml
   - id: web
     name: "@deepseek-ai/dsh-web"
     config:
       searchProvider: cpa-gemini
       fetchProvider: http          # 本地抓取
   - id: web-search-gemini
     name: "@alanzhao/dsh-web-search-gemini"
     config:
       baseURL: https://<your-cliproxy-host>/v1
       apiKeyEnv: CLIPROXY_API_KEY
   ```

密钥需存在于 DSH credentials（`~/.dsh/.credentials.yaml` 的 `refs`）或启动环境中。

## 注意

- **不要打开 DSH「网页搜索」设置页的开关。** 它会把 `searchProvider` / `fetchProvider` 改成 DeepSeek 的收费 Search / Fetch API。该页面只管理官方提供方。
- **没有自动回退。** 选中的提供方不可用时，`web_search` 直接报错，不会改用其他提供方。
- **部分 Anthropic 兼容网关会清空 `web_search` 工具的参数。** 现象是模型发出的调用参数为 `{}`，报 `missing required property "queries"`。这发生在主模型返回工具调用的那一段，与本插件无关；换用其他渠道作为主模型即可。

## 回滚

- 只换回官方搜索：把 `web.searchProvider` 改回原值（DSH 默认为 `deepseek-official`），不用重启。
- 完全移除：删掉 `cordis.patch.yml` 里的 `web-search-gemini` 行，从 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 移除本包，`pnpm install` 后重启 DSH。

## 开发

```sh
npm run build   # tsc → lib/
npm test        # node --test，用真实抓取的响应作为夹具
SMOKE_BASE_URL=https://<your-cliproxy-host>/v1 SMOKE_API_KEY=<key> npm run smoke   # 直连真实端点
```

## 许可

MIT
