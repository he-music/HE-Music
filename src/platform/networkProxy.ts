export interface NetworkProxyConfig {
  protocol: string;
  server: string;
  port: number;
}

export interface NetworkProxyReceipt {
  saved: boolean;
  webviewApplied: boolean;
  downloadsApplied: boolean;
  restartRequired: boolean;
  errorCode: string;
}

export interface NetworkProxyTestResult {
  reachable: boolean;
  scope: string;
}

export interface PlatformNetworkProxy {
  current(): Promise<NetworkProxyConfig>;
  apply(config: NetworkProxyConfig): Promise<NetworkProxyReceipt>;
  test(config: NetworkProxyConfig): Promise<NetworkProxyTestResult>;
}

// Structurally matches generated NetworkProxy. The parent supplies its actual
// bound methods; this leaf needs no cast, placeholder binding or runtime import.
export function createNetworkProxyProvider(bindings: PlatformNetworkProxy): PlatformNetworkProxy {
  return {
    current: () => bindings.current(),
    apply: (config) => bindings.apply(validateNetworkProxy(config)),
    test: (config) => bindings.test(validateNetworkProxy(config)),
  };
}

export function validateNetworkProxy(config: NetworkProxyConfig): NetworkProxyConfig {
  if (config.protocol === "off") return { protocol: "off", server: "", port: 0 };
  const { protocol, server, port } = config;
  if (
    (protocol !== "HTTP" && protocol !== "HTTPS") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !server ||
    server.length > 253
  )
    throw new Error("invalid-proxy");
  if (server.includes(":")) {
    if (!/^[a-fA-F0-9:.]+$/.test(server)) throw new Error("invalid-proxy");
    try {
      new URL(`http://[${server}]:${port}`);
    } catch {
      throw new Error("invalid-proxy");
    }
  } else if (
    server
      .split(".")
      .some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  ) {
    throw new Error("invalid-proxy");
  }
  return { protocol, server: server.toLowerCase(), port };
}

export interface NetworkProxyState {
  active: boolean;
  loading: boolean;
  applying: boolean;
  testing: boolean;
  draft: NetworkProxyConfig;
  receipt: NetworkProxyReceipt | null;
  testResult: NetworkProxyTestResult | null;
  error: "load-failed" | "invalid-proxy" | "apply-failed" | "test-failed" | null;
}

// Construction is inert for settings search. The settings panel calls activate
// and deactivate explicitly, so no watcher or subscription is installed by a
// lazily evaluated settings builder. Each edit/owner generation rejects old work.
export function createNetworkProxySession(
  provider: PlatformNetworkProxy,
  onChange: (state: NetworkProxyState) => void,
) {
  let generation = 0;
  let revision = 0;
  let value: NetworkProxyState = {
    active: false,
    loading: false,
    applying: false,
    testing: false,
    draft: { protocol: "off", server: "", port: 0 },
    receipt: null,
    testResult: null,
    error: null,
  };
  const state = (): NetworkProxyState => ({
    ...value,
    draft: { ...value.draft },
    receipt: value.receipt ? { ...value.receipt } : null,
    testResult: value.testResult ? { ...value.testResult } : null,
  });
  const notify = () => onChange(state());
  const matches = (owner: number, edit: number) =>
    value.active && generation === owner && revision === edit;
  const activate = async () => {
    const owner = ++generation;
    const edit = ++revision;
    value = {
      ...value,
      active: true,
      loading: true,
      applying: false,
      testing: false,
      receipt: null,
      testResult: null,
      error: null,
    };
    notify();
    try {
      const config = await provider.current();
      if (matches(owner, edit)) value.draft = validateNetworkProxy(config);
    } catch {
      if (matches(owner, edit)) value.error = "load-failed";
    } finally {
      if (matches(owner, edit)) {
        value.loading = false;
        notify();
      }
    }
  };
  const deactivate = () => {
    generation++;
    value = {
      ...value,
      active: false,
      loading: false,
      applying: false,
      testing: false,
      receipt: null,
      testResult: null,
      error: null,
    };
    notify();
  };
  const edit = (config: NetworkProxyConfig) => {
    revision++;
    value = {
      ...value,
      draft: { ...config },
      loading: false,
      applying: false,
      testing: false,
      receipt: null,
      testResult: null,
      error: null,
    };
    notify();
  };
  const run = async (kind: "apply" | "test") => {
    if (!value.active || value.loading || value.applying || value.testing) return;
    const owner = generation;
    const changed = revision;
    let config: NetworkProxyConfig;
    try {
      config = validateNetworkProxy(value.draft);
    } catch {
      value.error = "invalid-proxy";
      notify();
      return;
    }
    value = {
      ...value,
      applying: kind === "apply",
      testing: kind === "test",
      receipt: null,
      testResult: null,
      error: null,
    };
    notify();
    try {
      if (kind === "apply") {
        const receipt = await provider.apply(config);
        if (matches(owner, changed)) {
          if (!receipt.saved) value.error = "apply-failed";
          else value.receipt = receipt;
        }
      } else {
        const result = await provider.test(config);
        if (matches(owner, changed)) value.testResult = result;
      }
    } catch {
      if (matches(owner, changed)) value.error = kind === "apply" ? "apply-failed" : "test-failed";
    } finally {
      if (matches(owner, changed)) {
        value.applying = false;
        value.testing = false;
        notify();
      }
    }
  };
  return { state, activate, deactivate, edit, apply: () => run("apply"), test: () => run("test") };
}
