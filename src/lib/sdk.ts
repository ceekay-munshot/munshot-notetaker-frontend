// src/lib/sdk.ts
//
// Munshot Dashboard SDK client adapter — TYPES ONLY in this visual-shell build.
// The interfaces below describe the host integration contract; the live client
// (which created a postMessage connection to a parent Munshot host window) has
// been replaced by a permanent no-op `sdk` at the bottom of this file, since the
// standalone UI has no host. The external SDK <script> that used to load in
// index.html has been removed.

export const DASHBOARD_ID = 'munshot-podcasts'
export const DASHBOARD_NAME = 'Munshot Podcasts'

export interface SessionContext {
  token: string | null // JWT bearer token for Munshot APIs
  userName: string | null
  email: string | null
  orgId: string | null
  orgName: string | null
}

export interface MarketContext {
  selectedTicker: string | null // e.g. "AAPL"
  selectedTickerCompany: string | null // e.g. "Apple Inc."
  selectedTickerCountry: string | null // e.g. "US"
  selectedSymbol: string | null // TradingView format, e.g. "NASDAQ:AAPL"
}

export interface AppContext {
  route: string | null
  query: string | null
  viewMode: string | null // "grid" | "list"
  selectedCategory: string | null
  searchQuery: string | null
}

export interface DashboardHostContext {
  session?: SessionContext
  market?: MarketContext
  app?: AppContext
}

export interface DashboardSdkEnvelope {
  namespace: string
  version: string
  channelId: string
  source: 'host' | 'dashboard'
  kind: string // "host:init" | "host:context:update" | "host:event" | ...
  timestamp: number
  requestId?: string
  payload?: any
}

export interface NormalizedTopic {
  topic: string
  data: any
  metadata?: any
}

export interface TopicMeta {
  origin: string
  topic: string
  requestId?: string
}

export interface RequestOptions {
  timeoutMs?: number
  metadata?: unknown
}

export interface DashboardClientSdk {
  getContext(): DashboardHostContext | null
  getChannelId(): string | null
  onMessage(handler: (envelope: DashboardSdkEnvelope, meta: { origin: string }) => void): () => void
  onTopic(topic: string, handler: (t: NormalizedTopic, meta: TopicMeta, env: DashboardSdkEnvelope) => void): () => void
  onRequest(
    topic: string,
    handler: (t: NormalizedTopic, meta: TopicMeta, env: DashboardSdkEnvelope) => unknown | Promise<unknown>,
  ): () => void
  ready(): boolean
  requestContext(): boolean
  publish(topic: string, data?: unknown, metadata?: unknown): boolean
  request(topic: string, data?: unknown, options?: RequestOptions): Promise<any>
  sendError(message: string, code?: string, details?: unknown): boolean
  destroy(): void
}

export interface CreateClientConfig {
  dashboardId: string
  dashboardName?: string
  autoReady?: boolean // DEFAULT true — leave it
  requestTimeoutMs?: number // default 15000
  maxPayloadBytes?: number // default 524288 (512 KB)
  lockOriginOnFirstMessage?: boolean // default true
  allowedOrigins?: string[]
  targetWindow?: Window | null // default window.parent ?? window.opener
  targetOrigin?: string // default "*"
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual shell — no Munshot host. The real integration created a postMessage
// client that talked to a parent window; this standalone UI build has no host,
// so `sdk` is a permanent no-op. The hooks (useHostContext, useDashboardCapture)
// still consume it unchanged — they simply receive no host context. The type
// surface above is preserved so nothing that imports it has to change.
// ─────────────────────────────────────────────────────────────────────────────

function createNoopSdk(): DashboardClientSdk {
  return {
    getContext: () => null,
    getChannelId: () => null,
    onMessage: () => () => {},
    onTopic: () => () => {},
    onRequest: () => () => {},
    ready: () => false,
    requestContext: () => false,
    publish: () => false,
    request: async () => null,
    sendError: () => false,
    destroy: () => {},
  }
}

// Single inert client for the whole app.
export const sdk: DashboardClientSdk = createNoopSdk()
