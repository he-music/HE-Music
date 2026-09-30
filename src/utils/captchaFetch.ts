const normalizeRedeemResponse = async (response: Response): Promise<Response> => {
  if (!response.ok) return response;
  let data: { success?: boolean; expires?: unknown };
  try {
    data = (await response.clone().json()) as typeof data;
  } catch {
    return response;
  }
  if (data?.success !== true || typeof data.expires !== "string" || !/^\d+$/.test(data.expires)) {
    return response;
  }
  const expires = Number(data.expires);
  if (!Number.isSafeInteger(expires) || !Number.isFinite(new Date(expires).getTime())) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  return new Response(JSON.stringify({ ...data, expires }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const createCaptchaFetch = (
  sessionId: string,
  previousFetch: typeof fetch | undefined,
  fetchImpl: typeof fetch = fetch,
): typeof fetch => {
  const redeemed = new Map<string, Promise<Response>>();

  return (url: RequestInfo | URL, init: RequestInit = {}) => {
    const address = typeof url === "string" || url instanceof URL ? url : url.url;
    const path = new URL(address, globalThis.location?.origin ?? "http://localhost").pathname;
    const isChallenge = path.endsWith("/v1/captcha/challenge");
    const isRedeem = path.endsWith("/v1/captcha/redeem");
    if (!isChallenge && !isRedeem) {
      return previousFetch ? previousFetch(url, init) : fetchImpl(url, init);
    }

    if (init.body && typeof init.body !== "string") {
      throw new TypeError("Cap request body must be a JSON string");
    }
    const payload = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    const request = () =>
      fetchImpl(url, {
        ...init,
        headers,
        body: JSON.stringify({ ...payload, session_id: sessionId }),
      }).then((response) => (isRedeem ? normalizeRedeemResponse(response) : response));

    if (isRedeem && typeof payload.token === "string") {
      // Redeem tokens are single-use. The widget may submit the speculative solve again on click.
      let response = redeemed.get(payload.token);
      if (!response) {
        response = request();
        redeemed.set(payload.token, response);
      }
      return response.then((result) => result.clone());
    }
    return request();
  };
};
