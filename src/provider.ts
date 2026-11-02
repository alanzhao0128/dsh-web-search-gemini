/**
 * Gemini web search through an Anthropic-compatible Messages endpoint (CLIProxyAPI) that
 * maps the native `web_search_20250305` server tool onto Gemini grounding. Mirrors the
 * official DeepSeek provider; the wire format and `fetch` client are provider-private.
 * @module dsh-web-search-gemini/provider
 */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { applyResolved, mapResponse } from './map.js'
import { resolveRedirects } from './resolve.js'

export const PROVIDER_ID = 'cpa-gemini'
export const USER_AGENT = 'dsh-web-search-gemini/0.1.1'

/** Options for ONE search, snapshotted at its entry. */
export interface ProviderOptions {
  apiKey?: string
  /** Resolves the key through the credentials service / launch environment. */
  resolveApiKey?: () => Promise<string | undefined>
  apiKeyEnv: string
  baseURL: string
  model: string
  apiVersion: string
  maxTokens: number
  maxUses: number
  resolveRedirects: boolean
  resolveTimeoutMs: number
  includeAnswer: boolean
  answerMaxChars: number
  snippetMaxChars: number
  /** Records the request (never headers or keys) on the active session. */
  recordRequest?: (request: { endpoint: string; apiVersion: string; body: unknown }) => void
}

export class GeminiSearchProvider implements WebSearchProvider {
  readonly id = PROVIDER_ID

  /**
   * @param resolveOptions - options for the NEXT operation; a thunk because the settings
   *   section can change between searches without re-registering the provider.
   * @param fetchFn - injectable HTTP client (tests).
   */
  constructor(
    private readonly resolveOptions: () => ProviderOptions,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  available(): boolean {
    const o = this.resolveOptions()
    return ((o.apiKey?.length ?? 0) > 0 || o.resolveApiKey !== undefined)
      && URL.canParse(o.baseURL) && isPositiveInteger(o.maxTokens) && isPositiveInteger(o.maxUses)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const endpoint = `${options.baseURL}/messages`
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const body = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `Perform a web search for the query: ${request.query}\nThen list the key facts the sources state, as terse bullet points in the language of the query. Keep every exact number, date and name; no tables, headings, background or commentary.`,
        }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
      thinking: { type: 'disabled' },
    }
    options.recordRequest?.({ endpoint, apiVersion: options.apiVersion, body })
    throwIfAborted(signal)

    let response: Response
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          'authorization': `Bearer ${apiKey}`,
          'anthropic-version': options.apiVersion,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw endpointError(endpoint, `Gemini search request failed: ${String(error)}`, error)
    }
    if (!response.ok) {
      let message = `Gemini API error (HTTP ${response.status})`
      try {
        const parsed = await response.json() as { error?: string | { message?: string }; message?: string }
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message += `: ${detail}`
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      }
      throw endpointError(endpoint, message)
    }

    let mapped: WebSearchResult
    try {
      mapped = mapResponse(await response.json() as Parameters<typeof mapResponse>[0], options)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw endpointError(endpoint, error instanceof WebError ? error.message : `Gemini returned an unprocessable response body: ${String(error)}`, error)
    }
    if (!options.resolveRedirects) return mapped
    const resolved = await resolveRedirects(mapped.sources.map((s) => s.url), {
      timeoutMs: options.resolveTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
      fetch: this.fetchFn,
    })
    return applyResolved(mapped, resolved, options.snippetMaxChars)
  }

  /** Resolve the API key for one operation without retaining it. */
  private async apiKey(options: ProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.(), signal)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Gemini search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new WebError(`Gemini search has no API key for "${options.apiKeyEnv}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-gemini config`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
}

/** Endpoint recovery guidance for failures after dispatch began. */
function endpointError(endpoint: string, message: string, cause?: unknown): WebError {
  return new WebError(`${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. Search endpoint configuration is separate from chat. If that endpoint is not intended, the user can set web-search-gemini.baseURL to a trusted Anthropic-compatible endpoint. Only the user should choose or change the endpoint.`, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause })
}

/** Race a preflight promise against caller cancellation. */
function abortable<T>(operation: Promise<T> | undefined, signal?: AbortSignal): Promise<T | undefined> {
  if (operation === undefined || signal === undefined) return Promise.resolve(operation)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

function aborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Gemini search aborted', 'WEB_ABORTED', { cause: signal?.aborted === true ? signal.reason : fallback })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
