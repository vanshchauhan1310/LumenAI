import axios, { AxiosRequestConfig } from "axios";
import { tableauAuthRegistry, TableauCreds } from "./authManager.js";

/**
 * A TableauClient is always constructed for one specific userId + that user's
 * own stored credentials. There is no code path here that can borrow another
 * user's session — the auth registry is keyed by this instance's userId.
 */
export class TableauClient {
  constructor(
    private userId: string,
    private creds: TableauCreds,
  ) {}

  /** Exposes the userId this client is bound to (used for usage logging). */
  getUserId(): string {
    return this.userId;
  }

  /**
   * The connected user's Tableau site user id (from the sign-in response),
   * used by content tools that operate on "my" content (favorites,
   * subscriptions, data alerts). Distinct from the platform's own userId.
   */
  async getTableauUserId(): Promise<string> {
    const session = await this.getSession();
    return session.userId;
  }

  private async getSession() {
    return tableauAuthRegistry.getSession(this.userId, this.creds);
  }

  /**
   * Builds the direct browser URL for a piece of published content, so tool
   * results can offer the user a link to open something themselves in
   * Tableau instead of always pulling its data/image into the chat (which
   * costs LLM tokens the user may not need — see chat.ts's "offer the link
   * first" system prompt rule). Matches Tableau's standard URL scheme:
   * {siteUrl}/#/site/{siteContentUrl}/{kind}/{contentUrl} — or without the
   * /site/{..} segment for the Default site, where siteContentUrl is "".
   */
  getContentUrl(kind: "workbooks" | "views", contentUrl: string): string {
    const sitePart = this.creds.siteContentUrl ? `/site/${this.creds.siteContentUrl}` : "";
    // Tableau's REST API returns a view's contentUrl as
    // "workbookRepoUrl/sheets/viewName", but the actual browser URL drops
    // the "/sheets/" segment entirely — passing the raw field through 404s.
    const browserContentUrl = kind === "views" ? contentUrl.replace("/sheets/", "/") : contentUrl;
    return `${this.creds.siteUrl}/#${sitePart}/${kind}/${browserContentUrl}`;
  }

  /**
   * Verifies the PAT is valid by signing in — nothing more. Deliberately does
   * NOT follow up with a REST call like GET /sites/{siteId}: that endpoint
   * (and several others) requires the caller to be a Site/Server Admin,
   * which most real Tableau users (Explorer/Creator/Viewer) are not. A
   * successful sign-in already proves the PAT/site/site-content-URL are
   * correct — that's the only thing worth validating here.
   */
  async verifySignIn(): Promise<void> {
    try {
      await this.getSession();
    } catch (err: any) {
      // Reuse the same "Tableau API error (STATUS): BODY" wrapping used by
      // requestWithRetry, so callers (e.g. the connections route) get a
      // consistent, parseable error shape regardless of which call failed.
      throw this.describeError(err);
    }
  }

  async restRequest<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { body?: any; params?: Record<string, string> } = {},
  ): Promise<T> {
    return this.requestWithRetry(async () => {
      const session = await this.getSession();
      const url = `${this.creds.siteUrl}/api/${this.creds.apiVersion}${path.replace(
        "{siteId}",
        session.siteId,
      )}`;
      const config: AxiosRequestConfig = {
        method,
        url,
        params: opts.params,
        data: opts.body,
        headers: {
          "X-Tableau-Auth": session.token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      };
      const res = await axios.request(config);
      return res.data as T;
    });
  }

  /** Authenticated GET returning raw binary content (e.g. a view/workbook image or PDF export). */
  async restRequestBinary(path: string, params: Record<string, string> = {}): Promise<Buffer> {
    return this.requestWithRetry(async () => {
      const session = await this.getSession();
      const url = `${this.creds.siteUrl}/api/${this.creds.apiVersion}${path.replace("{siteId}", session.siteId)}`;
      const res = await axios.get(url, {
        params,
        responseType: "arraybuffer",
        headers: { "X-Tableau-Auth": session.token },
      });
      return Buffer.from(res.data);
    });
  }

  /**
   * Authenticated request against an unversioned REST endpoint (path already
   * starts with "/api/..."), e.g. the Pulse API which uses "/api/-/pulse/..."
   * instead of "/api/{version}/...".
   */
  async restRequestUnversioned<T = any>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: any; params?: Record<string, string> } = {},
  ): Promise<T> {
    return this.requestWithRetry(async () => {
      const session = await this.getSession();
      const url = `${this.creds.siteUrl}${path}`;
      const config: AxiosRequestConfig = {
        method,
        url,
        params: opts.params,
        data: opts.body,
        headers: {
          "X-Tableau-Auth": session.token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      };
      const res = await axios.request(config);
      return res.data as T;
    });
  }

  async vdsRequest<T = any>(path: string, body: any): Promise<T> {
    return this.requestWithRetry(async () => {
      const session = await this.getSession();
      const url = `${this.creds.siteUrl}/api/v1/vizql-data-service${path}`;
      const res = await axios.post(url, body, {
        headers: {
          "X-Tableau-Auth": session.token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
      return res.data as T;
    });
  }

  async metadataQuery<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
    return this.requestWithRetry(async () => {
      const session = await this.getSession();
      const url = `${this.creds.siteUrl}/api/metadata/graphql`;
      const res = await axios.post(
        url,
        { query, variables },
        { headers: { "X-Tableau-Auth": session.token, "Content-Type": "application/json" } },
      );
      if (res.data.errors) {
        throw new Error(`Metadata API error: ${JSON.stringify(res.data.errors)}`);
      }
      return res.data.data as T;
    });
  }

  async restRequestAllPages<T = any>(
    path: string,
    extractList: (page: any) => T[],
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const pageSize = 1000;
    let pageNumber = 1;
    const all: T[] = [];

    while (true) {
      const data = await this.restRequest<any>("GET", path, {
        params: { pageSize: String(pageSize), pageNumber: String(pageNumber), ...params },
      });
      const list = extractList(data);
      all.push(...list);
      const totalAvailable = Number(data?.pagination?.totalAvailable ?? all.length);
      if (all.length >= totalAvailable || list.length === 0) break;
      pageNumber++;
    }
    return all;
  }

  private async requestWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.response?.status === 401) {
        tableauAuthRegistry.invalidate(this.userId);
        try {
          return await fn();
        } catch (retryErr: any) {
          throw this.describeError(retryErr);
        }
      }
      throw this.describeError(err);
    }
  }

  /** Wraps axios errors with the Tableau response body. Never includes the PAT or auth token. */
  private describeError(err: any): Error {
    const status = err?.response?.status;
    let data = err?.response?.data;
    // Binary-response requests (restRequestBinary) use responseType:
    // "arraybuffer", so an error body arrives as raw bytes too — decode it
    // back to text first, or JSON.stringify on an ArrayBuffer/Buffer just
    // silently produces "{}" and the real Tableau error detail is lost.
    if (data instanceof Buffer || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      try {
        data = Buffer.from(data as any).toString("utf8");
      } catch {
        // leave as-is if it truly isn't text
      }
    }
    if (status) {
      const detail = typeof data === "string" ? data : data ? JSON.stringify(data) : err.message;
      return new Error(`Tableau API error (${status}): ${detail}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
