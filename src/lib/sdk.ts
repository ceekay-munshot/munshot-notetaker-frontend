// src/lib/sdk.ts
//
// Munshot Dashboard SDK client adapter. Typed against the shipped bundle
// (munshot-dashboard-sdk.v1.0.0). Creates ONE module-scoped client whose
// window 'message' listener is attached on construction, so the SDK receives
// and caches host:init even before the UI mounts.

export const DASHBOARD_ID = "munshot-notetaker";     // <-- set per dashboard
export const DASHBOARD_NAME = "Munshot Notetaker"; // <-- set per dashboard

export interface SessionContext {
  token: string | null;     // JWT bearer token for Munshot APIs
  userName: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
}

export interface MarketContext {
  selectedTicker: string | null;        // e.g. "AAPL"
  selectedTickerCompany: string | null; // e.g. "Apple Inc."
  selectedTickerCountry: string | null; // e.g. "US"
  selectedSymbol: string | null;        // TradingView format, e.g. "NASDAQ:AAPL"
}

export interface AppContext {
  route: string | null;
  query: string | null;
  viewMode: string | null;        // "grid" | "list"
  selectedCategory: string | null;
  searchQuery: string | null;
}

export interface DashboardHostContext {
  session?: SessionContext;
  market?: MarketContext;
  app?: AppContext;
}

export interface DashboardSdkEnvelope {
  namespace: string;
  version: string;
  channelId: string;
  source: "host" | "dashboard";
  kind: string;       // "host:init" | "host:context:update" | "host:event" | ...
  timestamp: number;
  requestId?: string;
  payload?: any;
}

export interface NormalizedTopic {
  topic: string;
  data: any;
  metadata?: any;
}

export interface TopicMeta {
  origin: string;
  topic: string;
  requestId?: string;
}

export interface RequestOptions {
  timeoutMs?: number;
  metadata?: unknown;
}

export interface DashboardClientSdk {
  getContext(): DashboardHostContext | null;
  getChannelId(): string | null;
  onMessage(
    handler: (envelope: DashboardSdkEnvelope, meta: { origin: string }) => void,
  ): () => void;
  onTopic(
    topic: string,
    handler: (t: NormalizedTopic, meta: TopicMeta, env: DashboardSdkEnvelope) => void,
  ): () => void;
  onRequest(
    topic: string,
    handler: (
      t: NormalizedTopic,
      meta: TopicMeta,
      env: DashboardSdkEnvelope,
    ) => unknown | Promise<unknown>,
  ): () => void;
  ready(): boolean;
  requestContext(): boolean;
  publish(topic: string, data?: unknown, metadata?: unknown): boolean;
  request(topic: string, data?: unknown, options?: RequestOptions): Promise<any>;
  sendError(message: string, code?: string, details?: unknown): boolean;
  destroy(): void;
}

export interface CreateClientConfig {
  dashboardId: string;
  dashboardName?: string;
  autoReady?: boolean;            // DEFAULT true — leave it
  requestTimeoutMs?: number;      // default 15000
  maxPayloadBytes?: number;       // default 524288 (512 KB)
  lockOriginOnFirstMessage?: boolean; // default true
  allowedOrigins?: string[];
  targetWindow?: Window | null;   // default window.parent ?? window.opener
  targetOrigin?: string;          // default "*"
}

type SdkFactory = (config: CreateClientConfig) => DashboardClientSdk;
type SdkCtor = new (config: CreateClientConfig) => DashboardClientSdk;

declare global {
  interface Window {
    MunshotDashboardSDK?: {
      createDashboardClientSdk?: SdkFactory;
      createClient?: SdkFactory;
      DashboardClientSdk?: SdkCtor;
      Client?: SdkCtor;
    };
  }
}

// Faithful no-op, used ONLY when the SDK script is absent (e.g. running the
// build standalone outside the Munshot host). Return types match the real
// client so app code behaves identically.
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
  };
}

function initSdk(): DashboardClientSdk {
  const g = window.MunshotDashboardSDK;
  const config: CreateClientConfig = {
    dashboardId: DASHBOARD_ID,
    dashboardName: DASHBOARD_NAME,
    // Leave autoReady default (true). The SDK sends dashboard:ready itself
    // from inside its host:init handler, once it knows the channelId.
  };

  const factory = g?.createDashboardClientSdk ?? g?.createClient;
  if (typeof factory === "function") {
    try {
      return factory(config);
    } catch (err) {
      console.error("[dashboard] SDK factory failed", err);
    }
  }

  const Ctor = g?.DashboardClientSdk ?? g?.Client;
  if (typeof Ctor === "function") {
    try {
      return new Ctor(config);
    } catch (err) {
      console.error("[dashboard] SDK constructor failed", err);
    }
  }

  console.warn(
    "[dashboard] MunshotDashboardSDK not found; using no-op SDK. " +
      "Expected only when running outside the Munshot host iframe.",
  );
  return createNoopSdk();
}

// Single client for the whole app. Created at import time so its message
// listener is live before host:init can arrive.
export const sdk: DashboardClientSdk = initSdk();
