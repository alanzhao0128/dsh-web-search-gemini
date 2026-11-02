/**
 * Pure mapping from an Anthropic-format Messages response (Gemini grounding behind
 * CLIProxyAPI) to the `ctx.web` search result, plus the post-resolution remap.
 * @module dsh-web-search-gemini/map
 */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** The subset of a Messages response block this mapper reads. */
export interface Block {
  type: string
  text?: string
  citations?: { url?: string | null; cited_text?: string | null }[] | null
  content?: { type: string; url: string; title?: string | null; page_age?: string | null }[]
}

export interface MapOptions {
  includeAnswer: boolean
  answerMaxChars: number
  snippetMaxChars: number
}

const SNIPPET_SEPARATOR = ' … '
const ANSWER_PREFIX = 'Search summary (model-generated; verify against sources):\n'
/** A title that is only a hostname, e.g. `xjtu.edu.cn` (Gemini's usual title). */
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/** Cap `text` at `max` characters (including the ellipsis that marks a cut). */
export function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** Join distinct non-empty snippets and cap the result. */
function joinSnippets(parts: Iterable<string>, max: number): string {
  return cap([...new Set(parts)].join(SNIPPET_SEPARATOR).trim(), max)
}

/**
 * Map a Messages response body.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when no `web_search_tool_result` block is present.
 */
export function mapResponse(response: { content?: Block[] }, options: MapOptions): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter((block) => block.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new WebError('Gemini returned no web_search_tool_result blocks; the request may not have triggered native web search', 'WEB_PROVIDER_ERROR')
  }
  const texts = blocks.filter((block) => block.type === 'text')

  const cited = new Map<string, string[]>()
  for (const block of texts) {
    for (const cite of block.citations ?? []) {
      if (!cite.url || !cite.cited_text) continue
      cited.set(cite.url, [...(cited.get(cite.url) ?? []), cite.cited_text])
    }
  }

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = joinSnippets(cited.get(item.url) ?? [], options.snippetMaxChars)
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
      })
    }
  }

  const answer = options.includeAnswer ? cap(texts.map((block) => block.text ?? '').join('').trim(), options.answerMaxChars) : ''
  return { ...(answer ? { content: ANSWER_PREFIX + answer } : {}), sources, truncated: false }
}

/**
 * Apply resolved redirect urls: replace each url, retitle bare-hostname titles with the
 * resolved hostname, and merge sources that collapse onto the same resolved url.
 * @param resolved - raw url → final url; urls absent from the map are untouched.
 */
export function applyResolved(result: WebSearchResult, resolved: ReadonlyMap<string, string>, snippetMaxChars: number): WebSearchResult {
  const merged = new Map<string, { source: WebSearchSource; snippets: string[] }>()
  for (const source of result.sources) {
    const url = resolved.get(source.url) ?? source.url
    const entry = merged.get(url)
    if (entry !== undefined) {
      if (source.snippet) entry.snippets.push(source.snippet)
      continue
    }
    const retitle = url !== source.url && (source.title === undefined || BARE_HOST.test(source.title))
    const host = retitle ? new URL(url).hostname.replace(/^www\./, '') : undefined
    merged.set(url, {
      source: { ...source, url, ...(host ? { title: host } : {}) },
      snippets: source.snippet ? [source.snippet] : [],
    })
  }
  const sources = [...merged.values()].map(({ source, snippets }) => {
    const { snippet: _drop, ...rest } = source
    const snippet = snippets.length > 1 ? joinSnippets(snippets, snippetMaxChars) : snippets[0]
    return snippet ? { ...rest, snippet } : rest
  })
  return { ...result, sources }
}
