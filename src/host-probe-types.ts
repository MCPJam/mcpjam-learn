import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

export interface HostProbeSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  mcp?: {
    clientInfo?: unknown;
    clientCapabilities?: unknown;
  };
  uiInitialize: {
    protocolVersion?: string;
    hostInfo?: unknown;
    hostCapabilities?: unknown;
    hostContext?: McpUiHostContext;
  };
  runtime: {
    location: {
      origin: string;
      href: string;
      ancestorOriginsLength: number;
    };
    navigator: {
      userAgent: string;
      platform: string;
      languages: readonly string[];
      hardwareConcurrency: number;
    };
    frame: {
      sandboxAttr: string | null;
      allowAttr: string | null;
      crossOriginBlocked: boolean;
      doubleIframed: boolean;
    };
    policies: {
      metaCsp: string | null;
      permissionsPolicy: string | null;
    };
    cspProbes?: Array<{ url: string; ok: boolean; errorName: string | null }>;
  };
  deltas: Array<{ at: string; hostContext: Partial<McpUiHostContext> }>;
  errors: Array<{ where: string; message: string }>;
}
