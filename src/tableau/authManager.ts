import axios from "axios";

interface Session {
  token: string;
  siteId: string;
  userId: string;
  expiresAt: number;
}

interface TableauCreds {
  siteUrl: string;
  siteContentUrl: string;
  patName: string;
  patValue: string;
  apiVersion: string;
}

const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * Caches one Tableau sign-in session per platform userId. Never shares a
 * session across users — each entry is keyed by the userId that owns the
 * underlying TableauConnection, so user A's queries can never execute with
 * user B's token.
 */
class TableauAuthRegistry {
  private sessions = new Map<string, Session>();
  private inflight = new Map<string, Promise<Session>>();

  async getSession(userId: string, creds: TableauCreds): Promise<Session> {
    const existing = this.sessions.get(userId);
    if (existing && existing.expiresAt > Date.now()) {
      return existing;
    }
    let pending = this.inflight.get(userId);
    if (!pending) {
      pending = this.signIn(creds).finally(() => this.inflight.delete(userId));
      this.inflight.set(userId, pending);
    }
    const session = await pending;
    this.sessions.set(userId, session);
    return session;
  }

  invalidate(userId: string) {
    this.sessions.delete(userId);
  }

  private async signIn(creds: TableauCreds): Promise<Session> {
    const url = `${creds.siteUrl}/api/${creds.apiVersion}/auth/signin`;
    const body = {
      credentials: {
        personalAccessTokenName: creds.patName,
        personalAccessTokenSecret: creds.patValue,
        site: { contentUrl: creds.siteContentUrl },
      },
    };

    const res = await axios.post(url, body, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    });

    const c = res.data?.credentials;
    if (!c?.token) {
      throw new Error("Tableau sign-in failed: no token in response");
    }

    return {
      token: c.token,
      siteId: c.site.id,
      userId: c.user.id,
      expiresAt: Date.now() + TOKEN_LIFETIME_MS - SAFETY_MARGIN_MS,
    };
  }
}

export const tableauAuthRegistry = new TableauAuthRegistry();
export type { TableauCreds };
