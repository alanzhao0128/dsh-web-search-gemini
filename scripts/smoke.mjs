// Live smoke test: runs the built provider (lib/) directly against a CLIProxyAPI endpoint, no DSH.
// Usage: SMOKE_BASE_URL=https://<your-cliproxy>/v1 SMOKE_API_KEY=<key> npm run smoke
// The key is read from the environment only and never printed.
import assert from 'node:assert/strict'
import { GeminiSearchProvider } from '../lib/provider.js'

const baseURL = process.env.SMOKE_BASE_URL
const apiKey = process.env.SMOKE_API_KEY
if (!baseURL || !apiKey) {
  console.error('Set SMOKE_BASE_URL (e.g. https://<your-cliproxy>/v1) and SMOKE_API_KEY.')
  process.exit(2)
}
const model = process.env.SMOKE_MODEL ?? 'gemini-3.8-flash-high'

const provider = new GeminiSearchProvider(() => ({
  apiKey, apiKeyEnv: 'SMOKE_API_KEY', baseURL, model,
  apiVersion: '2023-06-01', maxTokens: 4096, maxUses: 2, resolveRedirects: true, resolveTimeoutMs: 5000,
  includeAnswer: true, answerMaxChars: 1200, snippetMaxChars: 300,
}))

for (const query of ['西安交大最新新闻', 'Rust 2026 edition release date']) {
  const started = Date.now()
  const result = await provider.search({ query })
  const elapsed = Date.now() - started
  console.log(`\n=== ${query}`)
  for (const s of result.sources) console.log(`${s.url} | ${s.title ?? ''} | ${(s.snippet ?? '').length}`)
  console.log(`sources: ${result.sources.length}  answer: ${(result.content ?? '').length} chars  elapsed: ${elapsed} ms`)
  assert.ok(result.sources.length > 0, 'no sources')
  assert.ok(result.sources.every((s) => !s.url.includes('vertexaisearch')), 'unresolved vertexaisearch url')
}
console.log('\nsmoke OK')
