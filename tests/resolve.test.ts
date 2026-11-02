import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import { applyResolved } from '../src/map.ts'
import { resolveRedirects } from '../src/resolve.ts'

const V = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`
const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, ...(location === null ? {} : { headers: { location } }) })

/** A mock fetch driven by a url → response table; records every call. */
function mockFetch(table: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (input: string, init: RequestInit) => {
    calls.push({ url: String(input), init })
    const handler = table[String(input)]
    if (handler === undefined) throw new Error(`unexpected fetch ${String(input)}`)
    return handler()
  }) as unknown as typeof fetch
  return { fn, calls }
}

test('302 with an absolute location resolves; request is GET + manual redirect', async () => {
  const { fn, calls } = mockFetch({ [V('a')]: () => redirect('http://news.xjtu.edu.cn/zyxw.htm') })
  const map = await resolveRedirects([V('a')], { timeoutMs: 1000, fetch: fn })
  assert.equal(map.get(V('a')), 'http://news.xjtu.edu.cn/zyxw.htm')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.init.method, 'GET')
  assert.equal(calls[0]!.init.redirect, 'manual')
})

test('relative location resolves against the current url (stays on vertex, then leaves)', async () => {
  const { fn, calls } = mockFetch({
    [V('a')]: () => redirect('/grounding-api-redirect/b', 301),
    [V('b')]: () => redirect('https://dest.test/page', 307),
  })
  const map = await resolveRedirects([V('a')], { timeoutMs: 1000, fetch: fn })
  assert.equal(map.get(V('a')), 'https://dest.test/page')
  assert.deepEqual(calls.map((c) => c.url), [V('a'), V('b')])
})

test('multi-hop is capped at three vertex fetches, then the original is kept', async () => {
  const { fn, calls } = mockFetch({
    [V('a')]: () => redirect(V('b')),
    [V('b')]: () => redirect(V('c')),
    [V('c')]: () => redirect(V('d')),
    [V('d')]: () => redirect('https://dest.test/'),
  })
  const map = await resolveRedirects([V('a')], { timeoutMs: 1000, fetch: fn })
  assert.equal(map.size, 0)
  assert.equal(calls.length, 3)
})

test('three hops that end on a real destination resolve', async () => {
  const { fn } = mockFetch({
    [V('a')]: () => redirect(V('b')),
    [V('b')]: () => redirect(V('c')),
    [V('c')]: () => redirect('https://dest.test/'),
  })
  assert.equal((await resolveRedirects([V('a')], { timeoutMs: 1000, fetch: fn })).get(V('a')), 'https://dest.test/')
})

test('non-vertex urls (and other vertex paths) are never fetched', async () => {
  const { fn, calls } = mockFetch({})
  const map = await resolveRedirects(['https://example.com/x', 'https://vertexaisearch.cloud.google.com/other', 'not a url'], { timeoutMs: 1000, fetch: fn })
  assert.equal(map.size, 0)
  assert.equal(calls.length, 0)
})

test('timeout keeps the original url without failing', async () => {
  const hang = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
  })) as unknown as typeof fetch
  const map = await resolveRedirects([V('a')], { timeoutMs: 20, fetch: hang })
  assert.equal(map.size, 0)
})

test('network failure, non-redirect status and missing location keep the original', async () => {
  const { fn } = mockFetch({
    [V('a')]: () => { throw new Error('boom') },
    [V('b')]: () => new Response('ok', { status: 200 }),
    [V('c')]: () => redirect(null),
  })
  assert.equal((await resolveRedirects([V('a'), V('b'), V('c')], { timeoutMs: 1000, fetch: fn })).size, 0)
})

test('non-http(s) location is rejected', async () => {
  const { fn } = mockFetch({ [V('a')]: () => redirect('javascript:alert(1)'), [V('b')]: () => redirect('file:///etc/passwd') })
  assert.equal((await resolveRedirects([V('a'), V('b')], { timeoutMs: 1000, fetch: fn })).size, 0)
})

test('caller abort propagates as WEB_ABORTED', async () => {
  const controller = new AbortController()
  const hang = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
  })) as unknown as typeof fetch
  const pending = resolveRedirects([V('a')], { timeoutMs: 5000, signal: controller.signal, fetch: hang })
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof WebError && error.code === 'WEB_ABORTED')
})

test('two links collapsing to one destination merge snippets after resolution', async () => {
  const { fn } = mockFetch({
    [V('a')]: () => redirect('https://news.test/p'),
    [V('b')]: () => redirect('https://news.test/p'),
  })
  const sources = [
    { url: V('a'), title: 'news.test', snippet: 'one' },
    { url: V('b'), title: 'news.test', snippet: 'two' },
    { url: 'https://keep.test/', title: 'keep.test' },
  ]
  const map = await resolveRedirects(sources.map((s) => s.url), { timeoutMs: 1000, fetch: fn })
  const result = applyResolved({ truncated: false, sources }, map, 300)
  assert.deepEqual(result.sources, [
    { url: 'https://news.test/p', title: 'news.test', snippet: 'one … two' },
    { url: 'https://keep.test/', title: 'keep.test' },
  ])
})
