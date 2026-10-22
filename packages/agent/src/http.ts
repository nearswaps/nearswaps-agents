import type { FetchLike } from "./rpc.js";

export interface HttpError extends Error { status?: number; retryAfter?: number }

/** GET a JSON document with a timeout (pulse.js getJson). */
export async function getJson(fetchFn: FetchLike, url: string, ms = 9000): Promise<any> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    let r;
    try { r = await fetchFn(url, { headers: { Accept: "application/json" }, signal: ctl.signal }); }
    catch (e) { throw Object.assign(new Error(`${hostOf(url)} didn't answer`), { status: 0 }); }
    if (!r.ok) {
      let msg = "";
      try { const j = await r.json(); msg = j && j.error ? String(j.error) : ""; } catch (e) { /* no body */ }
      throw Object.assign(new Error(msg || `${hostOf(url)} answered ${r.status}`), { status: r.status }) as HttpError;
    }
    return await r.json();
  } finally { clearTimeout(t); }
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch (e) { return "the service"; } };
