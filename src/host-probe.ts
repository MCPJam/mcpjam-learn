import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import "./global.css";
import "./host-probe.css";
import type { HostProbeSnapshot } from "./host-probe-types";
import {
  captureRuntime,
  findUiInitializeResult,
  runCspProbes,
} from "./host-probe-capture";

// Install message listener BEFORE constructing App so we capture the
// raw ui/initialize response envelope (App SDK doesn't expose it).
const rawMessages: Array<{ at: string; data: unknown }> = [];
window.addEventListener("message", (ev) => {
  rawMessages.push({ at: new Date().toISOString(), data: ev.data });
});

const sections = {
  mcp: document.getElementById("section-mcp")!,
  ui: document.getElementById("section-ui")!,
  runtime: document.getElementById("section-runtime")!,
  deltas: document.getElementById("section-deltas")!,
  raw: document.getElementById("section-raw")!,
} as const;
const statusEl = document.getElementById("status")!;
const probeBtn = document.getElementById("btn-csp-probes") as HTMLButtonElement;
const reuploadBtn = document.getElementById("btn-reupload") as HTMLButtonElement;

type SectionKey = keyof typeof sections;

function render(key: SectionKey, value: unknown) {
  const pre = sections[key].querySelector("pre")!;
  try {
    pre.textContent = JSON.stringify(value, null, 2);
  } catch {
    pre.textContent = String(value);
  }
}

async function copyText(text: string): Promise<boolean> {
  // Async Clipboard API needs `clipboard-write` permission policy on the
  // iframe. Hosts that don't honor _meta.ui.permissions.clipboardWrite
  // will reject it — fall back to execCommand via a hidden textarea.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

for (const btn of Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-copy]"),
)) {
  btn.addEventListener("click", async () => {
    const key = btn.dataset.copy as SectionKey;
    const pre = sections[key]?.querySelector("pre");
    const text = pre?.textContent;
    if (!text) return;
    const original = btn.textContent;
    const ok = await copyText(text);
    btn.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => {
      btn.textContent = original;
    }, 1200);
  });
}

const deltas: HostProbeSnapshot["deltas"] = [];
const errors: HostProbeSnapshot["errors"] = [];
let snapshot: HostProbeSnapshot | null = null;

const app = new App({ name: "MCP Host Probe", version: "1.0.0" });

app.onhostcontextchanged = (ctx: McpUiHostContext) => {
  deltas.push({ at: new Date().toISOString(), hostContext: ctx });
  render("deltas", deltas);
};

app.onerror = (err: unknown) => {
  errors.push({
    where: "app.onerror",
    message: err instanceof Error ? err.message : String(err),
  });
};

app.onteardown = async () => ({});

// Raw JSON-RPC tools/call via postMessage. SEP-1865 defines this as
// the canonical wire protocol; this doesn't depend on whatever helper
// the App SDK might expose for tool invocation.
let nextRpcId = 1_000_000;
function callTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  const id = ++nextRpcId;
  return new Promise((resolve, reject) => {
    const listener = (ev: MessageEvent) => {
      const data = ev.data as
        | { id?: number | string; result?: unknown; error?: { message?: string } }
        | undefined;
      if (!data || typeof data !== "object" || data.id !== id) return;
      window.removeEventListener("message", listener);
      clearTimeout(timer);
      if (data.error) {
        reject(new Error(data.error.message ?? JSON.stringify(data.error)));
      } else {
        resolve(data.result);
      }
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error(`tools/call ${name} timed out`));
    }, timeoutMs);
    window.addEventListener("message", listener);
    window.parent.postMessage(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      "*",
    );
  });
}

async function uploadSnapshot(snap: HostProbeSnapshot): Promise<void> {
  try {
    statusEl.textContent = "Uploading snapshot...";
    await callTool("record-host-probe", snap as unknown as Record<string, unknown>);
    statusEl.textContent = `Uploaded at ${new Date().toLocaleTimeString()}. Call get-host-probe to retrieve.`;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ where: "uploadSnapshot", message });
    statusEl.textContent = `Upload failed: ${message}`;
  }
}

reuploadBtn.addEventListener("click", () => {
  if (!snapshot) return;
  snapshot.capturedAt = new Date().toISOString();
  snapshot.deltas = [...deltas];
  snapshot.errors = [...errors];
  void uploadSnapshot(snapshot);
});

probeBtn.addEventListener("click", async () => {
  probeBtn.disabled = true;
  // The declared URLs MUST match the resource's `_meta.ui.csp.connectDomains`
  // (see src/index.ts host-probe resource registration). Keeping these in
  // lockstep is what lets `assert-host-probe-csp` distinguish:
  //   - declared+blocked  → host over-restricted (or deny override active)
  //   - canary+allowed    → host LOOSENED declared CSP (SEP-1865 violation)
  const cspProbes = await runCspProbes([
    { url: "https://api.openai.com/v1/models", expectation: "declared" },
    { url: "https://api.anthropic.com/v1/messages", expectation: "declared" },
    {
      url: "https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json",
      expectation: "declared",
    },
    // Canary: not in declared connectDomains. If this succeeds, the host
    // failed to enforce CSP — strict regression.
    { url: "https://canary.invalid.example/", expectation: "canary" },
  ]);
  if (snapshot) {
    snapshot.runtime.cspProbes = cspProbes;
    render("runtime", snapshot.runtime);
    await uploadSnapshot(snapshot);
  }
  probeBtn.disabled = false;
});

statusEl.textContent = "Connecting to host...";

app
  .connect()
  .then(async () => {
    const hostContext = app.getHostContext() ?? undefined;
    const uiInit = findUiInitializeResult(rawMessages) ?? {};
    const runtime = captureRuntime();

    let mcp: HostProbeSnapshot["mcp"] = undefined;
    try {
      const result = (await callTool("get-mcp-init", {})) as
        | {
            structuredContent?: {
              clientInfo?: unknown;
              clientCapabilities?: unknown;
            };
          }
        | undefined;
      const sc = result?.structuredContent;
      if (sc) {
        mcp = {
          clientInfo: sc.clientInfo,
          clientCapabilities: sc.clientCapabilities,
        };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ where: "get-mcp-init", message });
    }

    snapshot = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      mcp,
      uiInitialize: {
        protocolVersion: uiInit.protocolVersion,
        hostInfo: uiInit.hostInfo,
        hostCapabilities: uiInit.hostCapabilities,
        hostContext,
      },
      runtime,
      deltas: [...deltas],
      errors: [...errors],
    };

    render("mcp", snapshot.mcp ?? { error: "get-mcp-init returned no data" });
    render("ui", snapshot.uiInitialize);
    render("runtime", snapshot.runtime);
    render("deltas", snapshot.deltas);
    render("raw", rawMessages.slice(0, 20));

    return uploadSnapshot(snapshot);
  })
  .catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ where: "app.connect", message });
    statusEl.textContent = `Connect failed: ${message}`;
  });
