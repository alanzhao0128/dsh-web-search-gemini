import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import { applyResolved, mapResponse } from '../src/map.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
const defaults = { includeAnswer: true, answerMaxChars: 1200, snippetMaxChars: 300 }
const PREFIX = 'Search summary (model-generated; verify against sources):\n'

test('zh fixture: six unique sources in order, titles kept, no publishedAt', () => {
  const result = mapResponse(fixture('zh-xjtu'), defaults)
  assert.equal(result.sources.length, 6)
  assert.equal(result.truncated, false)
  assert.equal(new Set(result.sources.map((s) => s.url)).size, 6)
  assert.equal(result.sources.filter((s) => s.url.includes('vertexaisearch')).length, 4)
  assert.equal(result.sources[0]!.title, 'xjtu.edu.cn')
  assert.ok(result.sources.every((s) => s.publishedAt === undefined))
})

test('zh fixture: all citations of one url merge into one snippet, identical texts deduped', () => {
  const [first] = mapResponse(fixture('zh-xjtu'), defaults).sources
  // The first url is cited by five distinct sentences, joined with " … ".
  assert.ok(first!.snippet!.includes(' … '))
  assert.ok(first!.snippet!.includes('近期西安交通大学'))
  assert.ok(first!.snippet!.includes('中央第九巡视组'))
  assert.equal(first!.snippet!.split(' … ').length, 5)
  const duplicated = fixture('zh-xjtu')
  const cites = duplicated.content.flatMap((b: any) => b.citations ?? [])
  cites.push({ ...cites[0] }) // an identical extra citation text must not repeat
  duplicated.content.push({ type: 'text', text: 'x', citations: [cites[0]] })
  assert.equal(mapResponse(duplicated, defaults).sources[0]!.snippet, first!.snippet)
})

test('zh fixture: a source without citations has no snippet', () => {
  const sources = mapResponse(fixture('zh-xjtu'), defaults).sources
  assert.equal(sources[5]!.snippet, undefined)
})

test('answer: prefix, whole text concatenated, cap with ellipsis', () => {
  const { content } = mapResponse(fixture('zh-xjtu'), defaults)
  assert.ok(content!.startsWith(PREFIX + '近期西安交通大学'))
  assert.ok(content!.includes('西安交通大学新闻网'))
  const capped = mapResponse(fixture('zh-xjtu'), { ...defaults, answerMaxChars: 100 }).content!
  assert.equal(capped.length, PREFIX.length + 100)
  assert.ok(capped.endsWith('…'))
})

test('snippet cap applies to the merged snippet', () => {
  const rust = mapResponse(fixture('en-rust'), { ...defaults, snippetMaxChars: 50 })
  assert.ok(rust.sources.every((s) => (s.snippet ?? '').length <= 50))
  assert.ok(rust.sources[0]!.snippet!.endsWith('…'))
})

test('en fixture: eight sources, none of them redirects', () => {
  const result = mapResponse(fixture('en-rust'), defaults)
  assert.equal(result.sources.length, 8)
  assert.ok(result.sources.every((s) => !s.url.includes('vertexaisearch')))
  assert.ok(result.content!.startsWith(PREFIX + 'There is **no official'))
})

test('includeAnswer=false omits content', () => {
  assert.equal(mapResponse(fixture('en-rust'), { ...defaults, includeAnswer: false }).content, undefined)
})

test('duplicate urls across result blocks are deduped; page_age becomes publishedAt', () => {
  const item = { type: 'web_search_result', url: 'https://a.test/x', title: 'a.test', page_age: '2026-01-02' }
  const result = mapResponse({ content: [
    { type: 'web_search_tool_result', content: [item, item] },
    { type: 'web_search_tool_result', content: [item, { ...item, url: 'https://b.test/', title: '', page_age: null }] },
  ] }, defaults)
  assert.deepEqual(result.sources, [
    { url: 'https://a.test/x', title: 'a.test', publishedAt: '2026-01-02' },
    { url: 'https://b.test/' },
  ])
})

test('missing web_search_tool_result block is a WEB_PROVIDER_ERROR', () => {
  assert.throws(
    () => mapResponse({ content: [{ type: 'text', text: 'hi' }] }, defaults),
    (error: unknown) => error instanceof WebError && error.code === 'WEB_PROVIDER_ERROR',
  )
})

test('applyResolved: replaces url, retitles bare hostnames, keeps real titles', () => {
  const result = applyResolved({ truncated: false, sources: [
    { url: 'https://v/1', title: 'xjtu.edu.cn', snippet: 's1' },
    { url: 'https://v/2', title: '西安交大新闻', snippet: 's2' },
    { url: 'https://other/', title: 'other' },
  ] }, new Map([['https://v/1', 'http://www.news.xjtu.edu.cn/a'], ['https://v/2', 'https://b.test/p']]), 300)
  assert.deepEqual(result.sources, [
    { url: 'http://www.news.xjtu.edu.cn/a', title: 'news.xjtu.edu.cn', snippet: 's1' },
    { url: 'https://b.test/p', title: '西安交大新闻', snippet: 's2' },
    { url: 'https://other/', title: 'other' },
  ])
})

test('applyResolved: sources collapsing onto one url merge snippets (deduped, capped)', () => {
  const resolved = new Map([['https://v/1', 'https://x.test/a'], ['https://v/2', 'https://x.test/a'], ['https://v/3', 'https://x.test/a']])
  const sources = [
    { url: 'https://v/1', title: 'x.test', snippet: 'alpha' },
    { url: 'https://v/2', title: 'x.test', snippet: 'beta' },
    { url: 'https://v/3', title: 'x.test', snippet: 'alpha' },
  ]
  const result = applyResolved({ truncated: false, sources }, resolved, 300)
  assert.deepEqual(result.sources, [{ url: 'https://x.test/a', title: 'x.test', snippet: 'alpha … beta' }])
  const short = applyResolved({ truncated: false, sources }, resolved, 8).sources[0]!.snippet!
  assert.ok(short.length <= 8 && short.endsWith('…'))
})
