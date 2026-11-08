const EXPIRED_MESSAGE =
  "The local session expired. Refresh Pagecraft and try again.";

export function createApiClient({
  fetch: fetchImpl = globalThis.fetch,
  onRenew = async () => undefined,
} = {}) {
  let session;
  let sessionFlight;
  let sessionVersion = 0;

  async function loadSession() {
    const version = sessionVersion;
    const response = await fetchImpl("/api/session?local=1", {
      method: "GET",
      cache: "no-store",
    });
    let result;
    try {
      result = await response.json();
    } catch {
      result = {};
    }
    if (!response.ok) {
      const error = new Error(
        result.error || "The local session is unavailable.",
      );
      error.status = response.status;
      if (result.pendingCommit) error.pendingCommit = result.pendingCommit;
      throw error;
    }
    if (version === sessionVersion) session = result;
    return session;
  }

  function getSession() {
    if (session !== undefined) return Promise.resolve(session);
    if (!sessionFlight) {
      sessionFlight = loadSession().finally(() => {
        sessionFlight = undefined;
      });
    }
    return sessionFlight;
  }

  function refreshSession() {
    if (!sessionFlight) {
      sessionFlight = loadSession().finally(() => {
        sessionFlight = undefined;
      });
    }
    return sessionFlight;
  }

  function setSession(value) {
    sessionVersion++;
    session = value;
  }

  async function send(endpoint, body, activeSession) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pagecraft-Token": activeSession?.token ?? "",
      },
      body: JSON.stringify(body),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      result = {};
    }
    return { response, result };
  }

  function responseError(response, result) {
    const error = new Error(
      result.error || "The request could not be completed.",
    );
    error.status = response.status;
    if (result.pendingCommit) error.pendingCommit = result.pendingCommit;
    return error;
  }

  async function request(endpoint, body) {
    const oldSession = await getSession();
    const first = await send(endpoint, body, oldSession);
    if (
      first.response.status !== 403 ||
      first.result.error !== EXPIRED_MESSAGE
    ) {
      if (!first.response.ok) throw responseError(first.response, first.result);
      return first.result;
    }

    const newSession = await refreshSession();
    const replacement = await onRenew({
      endpoint,
      body,
      oldSession,
      newSession,
    });
    const retryBody = replacement === undefined ? body : replacement;
    const retry = await send(endpoint, retryBody, newSession);
    if (!retry.response.ok) throw responseError(retry.response, retry.result);
    return retry.result;
  }

  return {
    getSession,
    setSession,
    request,
    get currentSession() {
      return session;
    },
  };
}
