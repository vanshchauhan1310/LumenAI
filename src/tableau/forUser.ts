import { supabase, Tables, logSupabaseError } from "../lib/db.js";
import { decryptSecret } from "../lib/crypto.js";
import { TableauClient } from "./client.js";

/**
 * Loads the given user's own TableauConnection and builds a TableauClient
 * from it. Every caller passes its own authenticated userId — there is no
 * path here that can build a client from another user's credentials.
 */
export async function getTableauClientForUser(userId: string): Promise<TableauClient | null> {
  // orderBy is defense-in-depth: /connections/tableau now replaces rather
  // than accumulates, but this guards against any pre-existing duplicate
  // rows by always preferring the most recently saved connection.
  const { data: conn, error } = await supabase
    .from(Tables.tableauConnections)
    .select("site_url, site_content_url, encrypted_pat")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  logSupabaseError("load tableau connection", error);
  if (!conn) return null;

  const { patName, patValue } = JSON.parse(decryptSecret(conn.encrypted_pat));
  return new TableauClient(userId, {
    siteUrl: conn.site_url,
    siteContentUrl: conn.site_content_url,
    patName,
    patValue,
    apiVersion: process.env.TABLEAU_API_VERSION || "3.24",
  });
}
