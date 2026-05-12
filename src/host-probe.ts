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

for (const btn of Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-copy]"),
)) {
  btn.addEventListener("click", () => {
    const key = btn.dataset.copy as SectionKey;
    const pre = sections[key]?.querySelector("pre");
    if (pre?.textContent) {
      navigator.clipboard.writeText(pre.textContent).catch(() => {});
    }
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
  const cspProbes = await runCspProbes([
    "https://api.openai.com/v1/models",
    "https://api.anthropic.com/v1/messages",
    "https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json",
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
  .then(() => {
    const hostContext = app.getHostContext() ?? undefined;
    const uiInit = findUiInitializeResult(rawMessages) ?? {};
    const runtime = captureRuntime();

    snapshot = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
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
