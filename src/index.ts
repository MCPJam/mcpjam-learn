import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import mcpAppHtml from "../dist/mcp-app.html";
import hostProbeHtml from "../dist/host-probe.html";
import authorizeHtml from "../dist/authorize.html";
import type { HostProbeSnapshot } from "./host-probe-types";

const RESOURCE_URI = "ui://mcp-demo/mcp-app.html";
const RESOURCE_URI_PROBE = "ui://mcp-demo/host-probe.html";

type RawInitializeParams = {
  protocolVersion?: unknown;
  capabilities?: unknown;
  clientInfo?: unknown;
};

async function getInitializeParamsFromStorage(
  agent: unknown,
): Promise<RawInitializeParams | undefined> {
  const a = agent as {
    getInitializeRequest?: () => Promise<
      { params?: RawInitializeParams } | undefined
    >;
  };
  try {
    const req = await a.getInitializeRequest?.();
    return req?.params;
  } catch {
    return undefined;
  }
}

type McpInitInfo = {
  protocolVersion: unknown;
  clientInfo: unknown;
  clientCapabilities: unknown;
  parsedClientCapabilities: unknown;
};

// Pulls the outer MCP `initialize` params. Reads from persisted JSON-RPC
// storage because the transport-level `initializeParams` is only set on
// cold-start and is lost after Durable Object eviction. The SDK's
// ClientCapabilitiesSchema is also strict z.object — it strips non-standard
// keys (e.g. `extensions.io.modelcontextprotocol/ui`) — so for raw payloads
// we cannot rely on getClientCapabilities().
async function readMcpInit(
  server: McpServer,
  agent: unknown,
): Promise<McpInitInfo> {
  const raw = await getInitializeParamsFromStorage(agent);
  const underlying = (server as { server?: unknown }).server as
    | {
        getClientVersion?: () => unknown;
        getClientCapabilities?: () => unknown;
      }
    | undefined;
  return {
    protocolVersion: raw?.protocolVersion ?? null,
    clientInfo: raw?.clientInfo ?? underlying?.getClientVersion?.() ?? null,
    clientCapabilities:
      raw?.capabilities ?? underlying?.getClientCapabilities?.() ?? null,
    parsedClientCapabilities: underlying?.getClientCapabilities?.() ?? null,
  };
}

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "MCP App Demo",
    version: "1.0.0",
  });

  lastProbe: HostProbeSnapshot | null = null;
  lastProbeAt: string | null = null;

  async init() {
    registerAppTool(
      this.server,
      "display-mcp-app",
      {
        title: "Display MCP App",
        description:
          "Renders a minimal interactive card inside the host UI. " +
          "Pass a title and body to see how tool I/O maps to a live visual.",
        inputSchema: z.object({
          title: z.string().describe("Heading shown at the top of the card"),
          body: z.string().describe("Supporting text displayed below the heading"),
        }),
        outputSchema: z.object({
          title: z.string(),
          body: z.string(),
          renderedAt: z.string(),
        }),
        _meta: { ui: { resourceUri: RESOURCE_URI } },
      },
      async ({ title, body }) => {
        const renderedAt = new Date().toISOString();
        return {
          content: [
            {
              type: "text" as const,
              text: `${title} — ${body}`,
            },
          ],
          structuredContent: { title, body, renderedAt },
        };
      },
    );

    registerAppResource(
      this.server,
      RESOURCE_URI,
      RESOURCE_URI,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: mcpAppHtml,
          },
        ],
      }),
    );

    // ── Host Probe ───────────────────────────────────
    // Renders a View that captures the host's ui/initialize handshake
    // (hostCapabilities, hostInfo, hostContext, theming variables, etc.)
    // plus runtime sandbox/CSP info. Used to replace educated-guess
    // host presets in MCPJam/inspector with empirically captured data.

    registerAppTool(
      this.server,
      "start-host-probe",
      {
        title: "Start Host Probe",
        description:
          "Probe this MCP host. Returns the outer MCP `initialize` clientInfo " +
          "and clientCapabilities (always available) plus the most recent " +
          "host-probe View snapshot if one exists (hostCapabilities, hostInfo, " +
          "hostContext, theming, display modes, runtime sandbox/CSP). On hosts " +
          "that support MCP UI resources, this also (re)renders the host-probe " +
          "View, which uploads a fresh snapshot via record-host-probe — call " +
          "this tool again to read it. On hosts without UI support, the " +
          "MCP-layer fields still come back as a tool result, so the server " +
          "can be probed from any client.",
        inputSchema: z.object({}),
        _meta: { ui: { resourceUri: RESOURCE_URI_PROBE } },
      },
      async () => {
        const mcp = await readMcpInit(this.server, this);
        const status: "ok" | "no-snapshot-yet" = this.lastProbe
          ? "ok"
          : "no-snapshot-yet";
        const payload = {
          status,
          mcp,
          recordedAt: this.lastProbeAt,
          snapshot: this.lastProbe,
          note:
            status === "no-snapshot-yet"
              ? "View has not uploaded a snapshot yet. If this host supports " +
                "MCP UI resources, it is rendering now — call this tool again " +
                "shortly. If not, only the `mcp` block is available."
              : "Snapshot is from the last View render. Call this tool again " +
                "to re-render the View and refresh.",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
          structuredContent: payload,
        };
      },
    );

    registerAppTool(
      this.server,
      "record-host-probe",
      {
        title: "Record Host Probe Snapshot (internal)",
        description:
          "Internal sink invoked by the host-probe View. Not intended for " +
          "direct invocation by the model.",
        inputSchema: z.object({
          schemaVersion: z.number(),
          capturedAt: z.string(),
          uiInitialize: z.any(),
          runtime: z.any(),
          deltas: z.array(z.any()),
          errors: z.array(z.any()),
          mcp: z.any().optional(),
        }),
        _meta: { ui: { visibility: ["app"] } },
      },
      async (snapshot) => {
        const mcp = await readMcpInit(this.server, this);
        this.lastProbe = {
          ...(snapshot as unknown as HostProbeSnapshot),
          mcp,
        };
        this.lastProbeAt = new Date().toISOString();
        return {
          content: [
            {
              type: "text" as const,
              text: `recorded at ${this.lastProbeAt}`,
            },
          ],
          structuredContent: { ok: true, recordedAt: this.lastProbeAt },
        };
      },
    );

    // Declared CSP/permissions on the probe resource. The host MUST enforce
    // this allow-list — and host configs (e.g. inspector mcpProfile) MAY
    // further restrict (deny) but MUST NOT loosen (SEP-1865 §Host Behavior).
    // The View's runtime probes MUST stay in lockstep with these domains
    // (see src/host-probe.ts cspProbes) so assert-host-probe-csp can flag
    // both over-restriction and loosening regressions.
    registerAppResource(
      this.server,
      RESOURCE_URI_PROBE,
      RESOURCE_URI_PROBE,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [
          {
            uri: RESOURCE_URI_PROBE,
            mimeType: RESOURCE_MIME_TYPE,
            text: hostProbeHtml,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [
                    "https://api.openai.com",
                    "https://api.anthropic.com",
                    "https://cdn.jsdelivr.net",
                  ],
                  resourceDomains: ["https://cdn.jsdelivr.net"],
                },
                permissions: {
                  clipboardWrite: {},
                },
              },
            },
          },
        ],
      }),
    );

    // ── Regression assertion tools ─────────────────────
    // These exist to catch regressions in inspector PR 2103
    // (mcpProfile: clientInfo / supportedProtocolVersions pin + sandbox
    // CSP/permissions overrides). Each returns structured pass/fail so
    // they're cheap to script against during manual smoke tests.

    registerAppTool(
      this.server,
      "assert-mcp-init",
      {
        title: "Assert MCP Initialize Params",
        description:
          "Verify that the host's MCP `initialize` request carried the " +
          "expected clientInfo and protocolVersion. Used to regression-test " +
          "inspector mcpProfile clientInfo / supportedProtocolVersions pins. " +
          "Every field is optional; only provided fields are checked. " +
          "clientInfoExtras checks non-standard keys (e.g. " +
          "defaultClientInfoExtras from mcpProfile). Strict equality only.",
        inputSchema: z.object({
          expectedClientName: z.string().optional(),
          expectedClientVersion: z.string().optional(),
          expectedClientInfoExtras: z.record(z.string(), z.unknown()).optional(),
          expectedProtocolVersion: z.string().optional(),
        }),
        _meta: {},
      },
      async (expected) => {
        const mcp = await readMcpInit(this.server, this);
        const clientInfo = mcp.clientInfo as
          | Record<string, unknown>
          | undefined;
        const protocolVersion = mcp.protocolVersion;

        const checks: Array<{
          field: string;
          expected: unknown;
          actual: unknown;
          pass: boolean;
        }> = [];

        if (expected.expectedClientName !== undefined) {
          const actual = clientInfo?.name;
          checks.push({
            field: "clientInfo.name",
            expected: expected.expectedClientName,
            actual,
            pass: actual === expected.expectedClientName,
          });
        }
        if (expected.expectedClientVersion !== undefined) {
          const actual = clientInfo?.version;
          checks.push({
            field: "clientInfo.version",
            expected: expected.expectedClientVersion,
            actual,
            pass: actual === expected.expectedClientVersion,
          });
        }
        if (expected.expectedClientInfoExtras !== undefined) {
          for (const [key, expectedVal] of Object.entries(
            expected.expectedClientInfoExtras,
          )) {
            const actual = clientInfo?.[key];
            checks.push({
              field: `clientInfo.${key}`,
              expected: expectedVal,
              actual,
              pass:
                JSON.stringify(actual) === JSON.stringify(expectedVal),
            });
          }
        }
        if (expected.expectedProtocolVersion !== undefined) {
          checks.push({
            field: "protocolVersion",
            expected: expected.expectedProtocolVersion,
            actual: protocolVersion,
            pass: protocolVersion === expected.expectedProtocolVersion,
          });
        }

        const allPass = checks.every((c) => c.pass);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { pass: allPass, checks, actual: { clientInfo, protocolVersion } },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            pass: allPass,
            checks,
            actual: { clientInfo, protocolVersion },
          },
        };
      },
    );

    registerAppTool(
      this.server,
      "assert-host-probe-csp",
      {
        title: "Assert Sandbox CSP Enforcement",
        description:
          "Verify that the most recent host-probe snapshot's empirical CSP " +
          "probes match expectations. Used to regression-test inspector " +
          "mcpProfile.csp overrides (host MAY further restrict, MUST NOT " +
          "loosen the server's declared CSP).\n\n" +
          "Behavior:\n" +
          "  - With no input: pass iff every `declared` probe succeeded AND " +
          "every `canary` probe was blocked. A canary success is a strict " +
          "spec violation (host loosened CSP).\n" +
          "  - With expectedBlockedUrls: those URLs are *additionally* " +
          "required to be blocked. Use this to verify a deny override " +
          "(e.g. inspector denies api.openai.com → assert it's blocked).\n" +
          "  - With expectedAllowedUrls: those URLs are required to be " +
          "allowed.\n\n" +
          "Run start-host-probe first and click `Run CSP probes` in the View.",
        inputSchema: z.object({
          expectedAllowedUrls: z.array(z.string()).optional(),
          expectedBlockedUrls: z.array(z.string()).optional(),
        }),
        _meta: {},
      },
      async ({ expectedAllowedUrls, expectedBlockedUrls }) => {
        if (!this.lastProbe) {
          return {
            content: [
              {
                type: "text" as const,
                text: "no-probe-yet — run start-host-probe and click `Run CSP probes` first",
              },
            ],
            structuredContent: { pass: false, reason: "no-probe-yet" as const },
          };
        }
        const probes = this.lastProbe.runtime.cspProbes ?? [];
        if (probes.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "no-csp-probes-yet — click `Run CSP probes` in the host-probe View",
              },
            ],
            structuredContent: {
              pass: false,
              reason: "no-csp-probes-yet" as const,
            },
          };
        }

        const checks: Array<{
          url: string;
          rule: string;
          expectedAllowed: boolean;
          actualAllowed: boolean;
          pass: boolean;
        }> = [];

        for (const probe of probes) {
          // Implicit per-expectation rules: declared SHOULD be ok, canary
          // SHOULD be blocked.
          const expectedAllowed = probe.expectation === "declared";
          checks.push({
            url: probe.url,
            rule:
              probe.expectation === "declared"
                ? "declared→allowed"
                : "canary→blocked",
            expectedAllowed,
            actualAllowed: probe.ok,
            pass: probe.ok === expectedAllowed,
          });
        }

        // Explicit per-URL overrides from input (let users assert deny/
        // restrictTo behavior on top of the implicit rules).
        const byUrl = new Map(probes.map((p) => [p.url, p]));
        for (const url of expectedAllowedUrls ?? []) {
          const probe = byUrl.get(url);
          if (!probe) {
            checks.push({
              url,
              rule: "expectedAllowed",
              expectedAllowed: true,
              actualAllowed: false,
              pass: false,
            });
            continue;
          }
          checks.push({
            url,
            rule: "expectedAllowed",
            expectedAllowed: true,
            actualAllowed: probe.ok,
            pass: probe.ok === true,
          });
        }
        for (const url of expectedBlockedUrls ?? []) {
          const probe = byUrl.get(url);
          if (!probe) {
            checks.push({
              url,
              rule: "expectedBlocked",
              expectedAllowed: false,
              actualAllowed: false,
              pass: false,
            });
            continue;
          }
          checks.push({
            url,
            rule: "expectedBlocked",
            expectedAllowed: false,
            actualAllowed: probe.ok,
            pass: probe.ok === false,
          });
        }

        const allPass = checks.every((c) => c.pass);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { pass: allPass, checks, metaCsp: this.lastProbe.runtime.policies.metaCsp },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            pass: allPass,
            checks,
            metaCsp: this.lastProbe.runtime.policies.metaCsp,
          },
        };
      },
    );

    registerAppTool(
      this.server,
      "assert-host-probe-permissions",
      {
        title: "Assert Sandbox Permissions Policy",
        description:
          "Verify that the most recent host-probe snapshot's iframe " +
          "Permissions-Policy / `allow` attribute matches expectations. " +
          "Used to regression-test inspector mcpProfile.permissions " +
          "overrides. Input lists feature names (e.g. 'camera', " +
          "'microphone', 'geolocation', 'clipboard-write'). " +
          "`expectedAllowedFeatures` must appear in the iframe `allow` " +
          "attribute or document Permissions-Policy. " +
          "`expectedBlockedFeatures` must NOT appear. " +
          "Run start-host-probe first.",
        inputSchema: z.object({
          expectedAllowedFeatures: z.array(z.string()).optional(),
          expectedBlockedFeatures: z.array(z.string()).optional(),
        }),
        _meta: {},
      },
      async ({ expectedAllowedFeatures, expectedBlockedFeatures }) => {
        if (!this.lastProbe) {
          return {
            content: [
              {
                type: "text" as const,
                text: "no-probe-yet — run start-host-probe first",
              },
            ],
            structuredContent: { pass: false, reason: "no-probe-yet" as const },
          };
        }
        const allowAttr = this.lastProbe.runtime.frame.allowAttr ?? "";
        const permissionsPolicy =
          this.lastProbe.runtime.policies.permissionsPolicy ?? "";
        // A feature is considered granted if either the iframe's `allow`
        // attribute lists it, or document.permissionsPolicy.allowedFeatures()
        // reports it as allowed. Both sources are normalized to lowercased
        // tokens. Note: `allow` attribute uses kebab-case feature names
        // (`clipboard-write`), matching the Permissions Policy spec.
        const tokens = new Set<string>();
        for (const tok of allowAttr.toLowerCase().split(/[\s;,]+/)) {
          if (tok) tokens.add(tok);
        }
        for (const tok of permissionsPolicy.toLowerCase().split(/\s+/)) {
          if (tok) tokens.add(tok);
        }

        const checks: Array<{
          feature: string;
          rule: "expectedAllowed" | "expectedBlocked";
          actualAllowed: boolean;
          pass: boolean;
        }> = [];

        for (const feature of expectedAllowedFeatures ?? []) {
          const allowed = tokens.has(feature.toLowerCase());
          checks.push({
            feature,
            rule: "expectedAllowed",
            actualAllowed: allowed,
            pass: allowed,
          });
        }
        for (const feature of expectedBlockedFeatures ?? []) {
          const allowed = tokens.has(feature.toLowerCase());
          checks.push({
            feature,
            rule: "expectedBlocked",
            actualAllowed: allowed,
            pass: !allowed,
          });
        }

        const allPass = checks.every((c) => c.pass);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { pass: allPass, checks, allowAttr, permissionsPolicy },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            pass: allPass,
            checks,
            allowAttr,
            permissionsPolicy,
          },
        };
      },
    );

    // ── Sample Prompt ────────────────────────────────────
    // Prompts are reusable message templates that clients can discover
    // and fill in with parameters.
    this.server.prompt(
      "explain-concept",
      "Generates a prompt asking for a clear explanation of a concept",
      {
        concept: z.string().describe("The concept or topic to explain"),
        audience: z
          .enum(["beginner", "intermediate", "expert"])
          .describe("Target audience level"),
      },
      async ({ concept, audience }) => ({
        description: `Explain "${concept}" for a ${audience} audience`,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Please explain the concept of "${concept}" ` +
                `in a way that is appropriate for a ${audience}-level audience. ` +
                `Use clear language, relevant examples, and keep it concise.`,
            },
          },
        ],
      }),
    );

    // ── Sample Resource ──────────────────────────────────
    // Resources expose read-only data that clients can fetch by URI.
    this.server.resource(
      "server-info",
      "info://mcp-demo/server-info",
      {
        description: "General information about this MCP demo server",
        mimeType: "text/plain",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text:
              "MCP App Demo Server v1.0.0\n" +
              "==========================\n\n" +
              "This is an educational MCP server demonstrating the three core primitives:\n\n" +
              "1. Tools     – Functions the client can invoke (e.g., 'greet', 'display-mcp-app')\n" +
              "2. Prompts   – Reusable message templates (e.g., 'explain-concept')\n" +
              "3. Resources – Read-only data the client can fetch (e.g., this document)\n\n" +
              "Built with:\n" +
              "  - @modelcontextprotocol/sdk\n" +
              "  - @modelcontextprotocol/ext-apps\n" +
              "  - Cloudflare Workers (agents package)\n" +
              "  - Zod for schema validation\n",
          },
        ],
      }),
    );
  }
}

// ── Auth helpers ───────────────────────────────────────────

function getResourceMetadataUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/.well-known/oauth-protected-resource`;
}

function unauthorized(request: Request): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${getResourceMetadataUrl(request)}"`,
    },
  });
}

async function verifyToken(token: string, env: Env): Promise<boolean> {
  try {
    const issuer = env.STYTCH_DOMAIN;
    const jwksUrl = new URL("/.well-known/jwks.json", env.STYTCH_DOMAIN);
    const jwks = createRemoteJWKSet(jwksUrl);
    await jwtVerify(token, jwks, { issuer });
    return true;
  } catch {
    return false;
  }
}

// ── Worker entrypoint ──────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // RFC 9728 — Protected Resource Metadata
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      return new Response(
        JSON.stringify({
          resource: `${url.origin}/mcp`,
          authorization_servers: [`${env.STYTCH_DOMAIN}/`],
          scopes_supported: ["openid", "email", "profile"],
          bearer_methods_supported: ["header"],
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Proxy Stytch's OAuth Authorization Server Metadata
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp"
    ) {
      const res = await fetch(
        new URL("/.well-known/oauth-authorization-server", env.STYTCH_DOMAIN),
      );
      const metadata = await res.json();
      return new Response(JSON.stringify(metadata), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Stytch IdentityProvider — OAuth authorize + login pages
    if (url.pathname === "/oauth/authorize" || url.pathname === "/login") {
      return new Response(authorizeHtml, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // MCP endpoint — require Bearer token
    if (url.pathname === "/mcp") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return unauthorized(request);
      }

      const token = authHeader.slice(7);
      const valid = await verifyToken(token, env);
      if (!valid) {
        return unauthorized(request);
      }

      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // Simple landing page
    return new Response(
      `<html><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
        <div style="text-align:center">
          <h1>MCP App Demo</h1>
          <p>Connect to this server at <code>/mcp</code></p>
        </div>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
};
