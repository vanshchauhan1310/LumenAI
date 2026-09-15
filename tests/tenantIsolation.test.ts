import { test, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { tableauAuthRegistry } from "../src/tableau/authManager.js";
import { TableauClient } from "../src/tableau/client.js";

/**
 * Proves the core tenant-isolation guarantee: a Tableau REST call made on
 * behalf of userA can never execute using userB's session/token, even when
 * both users' requests are in flight concurrently and share the same
 * in-process auth registry.
 */

test("user A's Tableau session is never handed to user B, even under concurrent sign-in", async () => {
  const signInCalls: string[] = [];

  mock.method(axios, "post", async (url: string, body: any) => {
    if (url.endsWith("/auth/signin")) {
      const patName = body.credentials.personalAccessTokenName as string;
      signInCalls.push(patName);
      // Simulate network latency so both sign-ins are genuinely concurrent.
      await new Promise((r) => setTimeout(r, 10));
      return {
        data: {
          credentials: {
            token: `token-for-${patName}`,
            site: { id: `site-${patName}` },
            user: { id: `user-${patName}` },
          },
        },
      };
    }
    throw new Error(`Unexpected axios.post to ${url}`);
  });

  const recordedRequests: { userId: string; token: string; url: string }[] = [];
  mock.method(axios, "request", async (config: any) => {
    recordedRequests.push({
      userId: "unknown", // filled in by caller context below
      token: config.headers["X-Tableau-Auth"],
      url: config.url,
    });
    return { data: { ok: true } };
  });

  const credsA = {
    siteUrl: "https://tenant-a.online.tableau.com",
    siteContentUrl: "siteA",
    patName: "pat-A",
    patValue: "secret-A",
    apiVersion: "3.24",
  };
  const credsB = {
    siteUrl: "https://tenant-b.online.tableau.com",
    siteContentUrl: "siteB",
    patName: "pat-B",
    patValue: "secret-B",
    apiVersion: "3.24",
  };

  const clientA = new TableauClient("userA", credsA);
  const clientB = new TableauClient("userB", credsB);

  // Fire both users' first requests concurrently — this is exactly the race
  // that a shared/global token cache would get wrong.
  const [sessionA, sessionB] = await Promise.all([
    tableauAuthRegistry.getSession("userA", credsA),
    tableauAuthRegistry.getSession("userB", credsB),
  ]);

  assert.equal(sessionA.token, "token-for-pat-A");
  assert.equal(sessionB.token, "token-for-pat-B");
  assert.notEqual(sessionA.token, sessionB.token);

  // Each user signed in with only their own PAT.
  assert.deepEqual(new Set(signInCalls), new Set(["pat-A", "pat-B"]));

  // Subsequent calls for userA must keep getting userA's cached session, never userB's.
  const sessionAAgain = await tableauAuthRegistry.getSession("userA", credsA);
  assert.equal(sessionAAgain.token, sessionA.token);

  // A REST call issued through clientA's TableauClient must carry userA's token.
  await clientA.restRequest("GET", "/sites/{siteId}");
  const lastRequest = recordedRequests[recordedRequests.length - 1];
  assert.equal(lastRequest.token, "token-for-pat-A");

  await clientB.restRequest("GET", "/sites/{siteId}");
  const lastRequestB = recordedRequests[recordedRequests.length - 1];
  assert.equal(lastRequestB.token, "token-for-pat-B");

  mock.reset();
});
