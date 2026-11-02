/**
 * Resolve Gemini grounding redirect links (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`)
 * to their destination by reading the `location` header only; the destination is never fetched.
 * @module dsh-web-search-gemini/resolve
 */
import { WebError } from '@deepseek-ai/dsh-web'

const VERTEX_HOST = 'vertexaisearch.cloud.google.com'
const VERTEX_PATH = '/grounding-api-redirect/'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_HOPS = 3

export interface ResolveOptions {
  timeoutMs: number
  signal?: AbortSignal
  fetch?: typeof fetch
}

/** True for a grounding redirect link that is safe to resolve. */
export function isGroundingRedirect(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return parsed.hostname === VERTEX_HOST && parsed.pathname.startsWith(VERTEX_PATH)
}

/** Follow vertex-to-vertex hops; return the first non-vertex http(s) location, or the original url. */
async function resolveOne(original: string, signal: AbortSignal, fetchFn: typeof fetch): Promise<string> {
  let current = original
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await fetchFn(current, { method: 'GET', redirect: 'manual', signal })
    void res.body?.cancel().catch(() => {})
    const location = REDIRECT_STATUS.has(res.status) ? res.headers.get('location') : null
    if (!location || !URL.canParse(location, current)) return original
    const next = new URL(location, current)
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return original
    if (next.hostname !== VERTEX_HOST) return next.href
    current = next.href
  }
  return original
}

/**
 * Resolve every grounding redirect in `urls` in parallel.
 * @returns raw url → destination for each url that resolved; failures and timeouts are omitted
 *          (callers keep the original url).
 * @throws {@link WebError} `WEB_ABORTED` when the caller's signal aborts.
 */
export async function resolveRedirects(urls: readonly string[], options: ResolveOptions): Promise<Map<string, string>> {
  const fetchFn = options.fetch ?? fetch
  const resolved = new Map<string, string>()
  await Promise.all([...new Set(urls)].filter(isGroundingRedirect).map(async (url) => {
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs)])
    try {
      const target = await resolveOne(url, signal, fetchFn)
      if (target !== url) resolved.set(url, target)
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new WebError('Gemini search aborted', 'WEB_ABORTED', { cause: options.signal.reason ?? error })
      }
      // Timeout or network failure: keep the original link.
    }
  }))
  return resolved
}
