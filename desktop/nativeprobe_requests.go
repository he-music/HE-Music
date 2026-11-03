//go:build nativeprobe

package main

// Observe only the two public requests the shared app already makes. Never retain
// URLs, headers, response bodies, credentials, or unrelated request metadata.
const nativePublicRequestObserver = `
(() => {
  window.__nativePublicRequests = [];
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, rawURL, ...rest) {
    let category;
    try {
      const path = new URL(rawURL, location.href).pathname;
      if (path.endsWith("/v1/auth/providers")) category = "providers";
      if (path.endsWith("/v1/platforms")) category = "platforms";
    } catch {}
    if (category && String(method).toUpperCase() === "GET") {
      this.addEventListener("loadend", () => {
        const entry = { category, status: this.status,
          corsReadable: this.status > 0 };
        if (category === "providers" && this.status >= 200 && this.status < 300) {
          try {
            const body = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            if (Array.isArray(body.list)) entry.providerCount = body.list.length;
          } catch {}
        }
        window.__nativePublicRequests.push(entry);
      }, { once: true });
    }
    return originalOpen.call(this, method, rawURL, ...rest);
  };
})();
`
