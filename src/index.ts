/**
 * dsh-web-search-gemini: registers the `cpa-gemini` web search provider into `ctx.web`.
 * Search runs through an Anthropic-compatible Messages endpoint (CLIProxyAPI) backed by Gemini
 * grounding; grounding redirect links are resolved to their real destinations.
 * @module dsh-web-search-gemini
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { GeminiSearchProvider } from './provider.js'
import type { ProviderOptions } from './provider.js'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** The Messages request this provider dispatched (no headers or keys). */
    'web/cpa-gemini-search-request': { endpoint: string; apiVersion: string; body: unknown }
  }
}

export { GeminiSearchProvider, PROVIDER_ID } from './provider.js'
export type { ProviderOptions } from './provider.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-gemini'

/** The web seam this provider registers into. */
export const inject = ['web']

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('CLIPROXY_API_KEY').volatile(),
  // No default: the endpoint is deployment-specific. Unset/invalid → provider unavailable.
  baseURL: z.string().default('').volatile(),
  model: z.string().default('gemini-3.8-flash-high').volatile(),
  apiVersion: z.string().default('2023-06-01').volatile(),
  maxTokens: z.number().step(1).min(1).default(4096).volatile(),
  maxUses: z.number().step(1).min(1).default(2).volatile(),
  resolveRedirects: z.boolean().default(true).volatile(),
  resolveTimeoutMs: z.number().step(1).min(1).default(5000).volatile(),
  includeAnswer: z.boolean().default(true).volatile(),
  answerMaxChars: z.number().step(1).min(1).default(1200).volatile(),
  snippetMaxChars: z.number().step(1).min(1).default(300).volatile(),
})

/** Volatile view of {@link Config}: every field is re-read with `.get()` per search. */
export interface VolatileConfig {
  apiKey: Volatile<string | undefined>
  apiKeyEnv: Volatile<string>
  baseURL: Volatile<string>
  model: Volatile<string>
  apiVersion: Volatile<string>
  maxTokens: Volatile<number>
  maxUses: Volatile<number>
  resolveRedirects: Volatile<boolean>
  resolveTimeoutMs: Volatile<number>
  includeAnswer: Volatile<boolean>
  answerMaxChars: Volatile<number>
  snippetMaxChars: Volatile<number>
}

/** Snapshot the section once into the options one search runs with. */
function resolveOptions(ctx: Context, config: VolatileConfig): ProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv.get())
  const apiKey = config.apiKey.get()
  return {
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL.get(),
    model: config.model.get(),
    apiVersion: config.apiVersion.get(),
    maxTokens: config.maxTokens.get(),
    maxUses: config.maxUses.get(),
    resolveRedirects: config.resolveRedirects.get(),
    resolveTimeoutMs: config.resolveTimeoutMs.get(),
    includeAnswer: config.includeAnswer.get(),
    answerMaxChars: config.answerMaxChars.get(),
    snippetMaxChars: config.snippetMaxChars.get(),
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/cpa-gemini-search-request', request)
    },
  }
}

/** Register the Gemini search provider with `ctx.web`. */
export function apply(ctx: Context, config: VolatileConfig): void {
  ctx.web.registerSearchProvider(new GeminiSearchProvider(() => resolveOptions(ctx, config)))
}
