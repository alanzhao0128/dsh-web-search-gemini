import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import { GeminiSearchProvider, USER_AGENT } from '../src/provider.ts'
import type { ProviderOptions } from '../src/provider.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')

const base: ProviderOptions = {
  apiKey: 'test-key', apiKeyEnv: 'CLIPROXY_API_KEY', baseURL: 'https://cpa.test/v1', model: 'gemini-test',
  apiVersion: '2023-06-01', maxTokens: 4096, maxUses: 2, resolveRedirects: true, resolveTimeoutMs: 1000,
  includeAnswer: true, answerMaxChars: 1200, snippetMaxChars: 300,
}
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } })
const code = (c: string) => (error: unknown) => error instanceof WebError && error.code === c

test('available(): false on an unparsable baseURL, true on a valid one', () => {
  assert.equal(new GeminiSearchProvider(() => ({ ...base, baseURL: 'not a url' })).available(), false)
  assert.equal(new GeminiSearchProvider(() => ({ ...base, baseURL: '' })).available(), false)
  assert.equal(new GeminiSearchProvider(() => base).available(), true)
  assert.equal(new GeminiSearchProvider(() => ({ ...base, apiKey: undefined as never })).available(), false)
})

test('missing credential → WEB_PROVIDER_CREDENTIAL_MISSING, nothing dispatched', async () => {
  let called = false
  const provider = new GeminiSearchProvider(
    () => ({ ...base, apiKey: undefined as never, resolveApiKey: async () => undefined }),
    (async () => { called = true; return json('{}') }) as typeof fetch,
  )
  await assert.rejects(provider.search({ query: 'q' }), code('WEB_PROVIDER_CREDENTIAL_MISSING'))
  assert.equal(called, false)
})

test('HTTP 500 → WEB_PROVIDER_ERROR naming the endpoint and web-search-gemini.baseURL', async () => {
  const provider = new GeminiSearchProvider(() => base, (async () => json('{"error":{"message":"upstream down"}}', 500)) as typeof fetch)
  await assert.rejects(provider.search({ query: 'q' }), (error: unknown) => {
    assert.ok(error instanceof WebError && error.code === 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /\(HTTP 500\): upstream down/)
    assert.ok(error.message.includes('"https://cpa.test/v1/messages"'))
    assert.ok(error.message.includes('web-search-gemini.baseURL'))
    return true
  })
})

test('request wire: headers, body, recorded event without secrets', async () => {
  let seen: { url: string; init: RequestInit } | undefined
  const recorded: unknown[] = []
  const provider = new GeminiSearchProvider(
    () => ({ ...base, resolveRedirects: false, recordRequest: (r) => recorded.push(r) }),
    (async (url: string, init: RequestInit) => { seen = { url, init }; return json(fixture('en-rust')) }) as typeof fetch,
  )
  const result = await provider.search({ query: 'Rust 2026 edition release date' })
  assert.equal(result.sources.length, 8)
  assert.equal(seen!.url, 'https://cpa.test/v1/messages')
  assert.equal(seen!.init.redirect, 'error')
  const headers = seen!.init.headers as Record<string, string>
  assert.equal(headers['x-api-key'], 'test-key')
  assert.equal(headers['authorization'], 'Bearer test-key')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['user-agent'], USER_AGENT)
  const body = JSON.parse(seen!.init.body as string)
  assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }])
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.messages[0].content[0].text, 'Perform a web search for the query: Rust 2026 edition release date\nThen list the key facts the sources state, as terse bullet points in the language of the query. Keep every exact number, date and name; no tables, headings, background or commentary.')
  assert.equal(recorded.length, 1)
  assert.ok(!JSON.stringify(recorded).includes('test-key'))
})

test('end to end: redirects are resolved through the same fetch, response block missing is an error', async () => {
  const provider = new GeminiSearchProvider(() => base, (async (url: string) => {
    if (url.endsWith('/messages')) return json(fixture('zh-xjtu'))
    return new Response(null, { status: 302, headers: { location: `http://news.xjtu.edu.cn/${url.slice(-6)}.htm` } })
  }) as typeof fetch)
  const result = await provider.search({ query: 'q' })
  assert.ok(result.sources.every((s) => !s.url.includes('vertexaisearch')))
  assert.equal(result.sources[0]!.title, 'news.xjtu.edu.cn')
  const empty = new GeminiSearchProvider(() => base, (async () => json('{"content":[]}')) as typeof fetch)
  await assert.rejects(empty.search({ query: 'q' }), code('WEB_PROVIDER_ERROR'))
})

test('pre-aborted signal → WEB_ABORTED', async () => {
  const provider = new GeminiSearchProvider(() => base, (async () => json('{}')) as typeof fetch)
  await assert.rejects(provider.search({ query: 'q' }, AbortSignal.abort()), code('WEB_ABORTED'))
})
