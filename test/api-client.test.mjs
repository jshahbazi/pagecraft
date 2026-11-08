import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../public/api-client.js";

const expired = "The local session expired. Refresh Pagecraft and try again.";
const json = (status, value) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => value,
});
const session = (token) => ({ token, instanceId: `instance-${token}` });

test("refreshes expired session and retries a browse request once", async () => {
  const calls = [];
  const client = createApiClient({
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.startsWith("/api/session")) return json(200, session("new"));
      if (calls.filter((call) => call.url === url).length === 1)
        return json(403, { error: expired });
      return json(200, { folders: [] });
    },
  });
  client.setSession(session("old"));

  assert.deepEqual(
    await client.request("/api/local/browse", { directory: "/" }),
    { folders: [] },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers["X-Pagecraft-Token"], "old");
  assert.equal(calls[1].url, "/api/session?local=1");
  assert.equal(calls[1].options.cache, "no-store");
  assert.equal(calls[2].options.headers["X-Pagecraft-Token"], "new");
});

test("renews before retry so callback can make nested fresh-session requests", async () => {
  const calls = [];
  let client;
  client = createApiClient({
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.startsWith("/api/session")) return json(200, session("new"));
      if (
        url === "/api/local/open" &&
        calls.filter((call) => call.url === url).length === 1
      )
        return json(403, { error: expired });
      return json(200, { ok: true });
    },
    onRenew: async ({ endpoint, body, newSession }) => {
      assert.equal(client.currentSession.token, "new");
      assert.equal(newSession.token, "new");
      await client.request("/api/local/browse", { directory: "/" });
      return { ...body, renewedFor: endpoint };
    },
  });
  client.setSession(session("old"));

  await client.request("/api/local/open", { directory: "/site" });
  const openCalls = calls.filter((call) => call.url === "/api/local/open");
  assert.equal(openCalls.length, 2);
  assert.deepEqual(JSON.parse(openCalls[1].options.body), {
    directory: "/site",
    renewedFor: "/api/local/open",
  });
  assert.equal(openCalls[1].options.headers["X-Pagecraft-Token"], "new");
  assert.equal(
    calls.filter((call) => call.url === "/api/session?local=1").length,
    1,
  );
});

test("does not retry a second expiry", async () => {
  let posts = 0;
  let sessions = 0;
  const client = createApiClient({
    fetch: async (url) => {
      if (url.startsWith("/api/session")) {
        sessions++;
        return json(200, session(`token-${sessions}`));
      }
      posts++;
      return json(403, { error: expired });
    },
  });
  client.setSession(session("old"));

  await assert.rejects(client.request("/api/local/save", {}), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.message, expired);
    return true;
  });
  assert.equal(posts, 2);
  assert.equal(sessions, 1);
});

test("does not retry network failures, unrelated 403s, or other statuses", async () => {
  for (const scenario of [
    { response: null, expected: /offline/ },
    {
      response: json(403, { error: "Cross-origin requests are not allowed." }),
      expected: /Cross-origin/,
    },
    { response: json(409, { error: "Conflict." }), expected: /Conflict/ },
  ]) {
    let posts = 0;
    const client = createApiClient({
      fetch: async (url) => {
        if (url.startsWith("/api/session")) return json(200, session("token"));
        posts++;
        if (!scenario.response) throw new Error("offline");
        return scenario.response;
      },
    });
    client.setSession(session("token"));
    await assert.rejects(
      client.request("/api/local/save", {}),
      scenario.expected,
    );
    assert.equal(posts, 1);
  }
});

test("preserves pending commit metadata on API errors", async () => {
  const client = createApiClient({
    fetch: async (url) =>
      url.startsWith("/api/session")
        ? json(200, session("token"))
        : json(409, { error: "Push failed.", pendingCommit: "a".repeat(40) }),
  });
  client.setSession(session("token"));

  await assert.rejects(client.request("/api/local/push", {}), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.pendingCommit, "a".repeat(40));
    return true;
  });
});

test("deduplicates in-flight session reads and supports cached bootstrap sessions", async () => {
  let resolveSession;
  let reads = 0;
  const client = createApiClient({
    fetch: async () => {
      reads++;
      return new Promise((resolve) => {
        resolveSession = () => resolve(json(200, session("loaded")));
      });
    },
  });
  const first = client.getSession();
  const second = client.getSession();
  assert.equal(reads, 1);
  resolveSession();
  assert.deepEqual(await first, session("loaded"));
  assert.deepEqual(await second, session("loaded"));
  assert.equal(client.currentSession.token, "loaded");

  client.setSession({ token: "bootstrap", github: { connected: true } });
  assert.deepEqual(await client.getSession(), {
    token: "bootstrap",
    github: { connected: true },
  });
  assert.equal(reads, 1);
});
