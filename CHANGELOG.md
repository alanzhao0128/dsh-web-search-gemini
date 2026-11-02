# Changelog

## 0.1.0 — 2026-11-02

首个版本。

- 注册 `ctx.web` 搜索提供方 `cpa-gemini`：经 CLIProxyAPI 的 Anthropic 兼容 `/v1/messages` 端点，用 `web_search_20250305` 调用 Gemini 的 Google 搜索。不新增工具，沿用 DSH 原生 `web_search`。
- 把 Gemini grounding 的 `vertexaisearch.cloud.google.com/grounding-api-redirect/…` 跳转链接还原成真实网址（只读 `location` 头，最多 3 跳，单条超时可配，失败保留原链接）。
- 合并同一链接的所有引用作为摘要；可选返回模型总结（`includeAnswer`，带 model-generated 标注）。
- 每次搜索记录 `web/cpa-gemini-search-request` 会话事件（不含密钥）。
- `baseURL` 无默认值，未配置时提供方不可用。
