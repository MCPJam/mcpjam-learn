import type { HostProbeSnapshot } from "./host-probe-types";

export function captureRuntime(): HostProbeSnapshot["runtime"] {
  let sandboxAttr: string | null = null;
  let allowAttr: string | null = null;
  let crossOriginBlocked = false;
  try {
    const fe = window.frameElement as HTMLIFrameElement | null;
    if (fe) {
      sandboxAttr = fe.getAttribute("sandbox");
      allowAttr = fe.getAttribute("allow");
    }
  } catch {
    crossOriginBlocked = true;
  }

  let metaCsp: string | null = null;
  try {
    metaCsp =
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? null;
  } catch {
    /* ignore */
  }

  let permissionsPolicy: string | null = null;
  try {
    const doc = document as unknown as {
      permissionsPolicy?: { allowedFeatures?: () => string[] };
      featurePolicy?: { allowedFeatures?: () => string[] };
    };
    const pp = doc.permissionsPolicy ?? doc.featurePolicy;
    if (pp?.allowedFeatures) {
      permissionsPolicy = pp.allowedFeatures().join(" ");
    }
  } catch {
    /* ignore */
  }

  let ancestorOriginsLength = 0;
  try {
    ancestorOriginsLength = window.location.ancestorOrigins?.length ?? 0;
  } catch {
    /* ignore */
  }

  return {
    location: {
      origin: window.location.origin,
      href: window.location.href,
      ancestorOriginsLength,
    },
    navigator: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: navigator.languages ?? [],
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    },
    frame: {
      sandboxAttr,
      allowAttr,
      crossOriginBlocked,
      doubleIframed: window.parent !== window.top,
    },
    policies: {
      metaCsp,
      permissionsPolicy,
    },
  };
}

export async function runCspProbes(
  urls: string[],
): Promise<NonNullable<HostProbeSnapshot["runtime"]["cspProbes"]>> {
  const results: NonNullable<HostProbeSnapshot["runtime"]["cspProbes"]> = [];
  for (const url of urls) {
    try {
      await fetch(url, { mode: "no-cors" });
      results.push({ url, ok: true, errorName: null });
    } catch (e) {
      results.push({
        url,
        ok: false,
        errorName: e instanceof Error ? e.name : String(e),
      });
    }
  }
  return results;
}

// The `App` SDK exposes `getHostContext()` but not the rest of the
// `ui/initialize` result. Sniff the raw envelope from a parallel
// message log to recover hostInfo / hostCapabilities / protocolVersion.
export function findUiInitializeResult(
  messages: Array<{ data: unknown }>,
): {
  protocolVersion?: string;
  hostInfo?: unknown;
  hostCapabilities?: unknown;
} | null {
  for (const { data } of messages) {
    if (!data || typeof data !== "object") continue;
    const result = (data as { result?: unknown }).result;
    if (!result || typeof result !== "object") continue;
    const r = result as Record<string, unknown>;
    if ("hostCapabilities" in r || "hostInfo" in r) {
      return {
        protocolVersion:
          typeof r.protocolVersion === "string" ? r.protocolVersion : undefined,
        hostInfo: r.hostInfo,
        hostCapabilities: r.hostCapabilities,
      };
    }
  }
  return null;
}
