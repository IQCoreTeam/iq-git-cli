// Optional gateway-aware reads. Pattern + URL list mirror
// iq-chan/src/lib/config.ts: try the primary gateway, then the Akash
// direct ingress, then the backup gateway, then fall back to direct RPC.
//
// Why route reads through gateway:
//   - free RPCs (Helius free tier) rate-limit getTransaction; the SDK's
//     readTableRows fans out to N getTransaction calls per table. Gateway
//     has its own RPC + 3-tier cache so its reads don't burn the user's
//     RPC quota.
//   - decentralized: anyone can run a gateway. iqgit isn't tied to one.
//
// Configuration:
//   (no env)                          default 3-gateway chain (recommended)
//   GATEWAY_URL=https://my.example    single override, then RPC fallback
//   GATEWAY_URL=url1,url2,url3        comma-separated list, tried in order
//   GATEWAY_URL=off                   disable gateway, all reads via RPC

import iqlabs from "@iqlabs-official/solana-sdk";
import { loadTree } from "@iqlabs-official/git-sdk/node";

// Defaults match iq-chan/src/lib/config.ts so iqgit, blockchan and any
// other consumer hit the same 3 read endpoints.
const DEFAULT_GATEWAYS = [
  "https://gateway.solanainternet.com",
  "https://gateway.iqlabs.dev",
  "https://fem4pe7sthdm5f9fkhc1fnmpos.ingress.akashprovid.com",
  "https://fem4pe7sthdm5f9fkhc1fnmpos.ingress.cpu.aesservices.net",
];

function getGatewayUrls(): string[] {
  const raw = process.env.GATEWAY_URL?.trim();
  if (raw === undefined || raw === "") return DEFAULT_GATEWAYS;
  if (raw.toLowerCase() === "off") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Try each gateway in order with a per-request timeout. Returns the first
// 2xx Response, or null if all gateways failed (network error or non-2xx).
async function gwFetch(path: string, timeoutMs = 8000): Promise<Response | null> {
  for (const base of getGatewayUrls()) {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
    } catch {
      // try next gateway
    }
  }
  return null;
}

// Fetch rows for a table PDA. Always returns rows[] — gateway chain first,
// SDK readTableRows (which uses the global RPC) on full gateway failure.
// The SDK's RPC URL must be initialized via iqlabs.setRpcUrl before this
// is called; setup.ts handles that.
export async function gwFetchRows(
  tablePda: string,
  limit = 50,
  before?: string,
): Promise<Record<string, unknown>[]> {
  const path = `/table/${tablePda}/rows?limit=${limit}` + (before ? `&before=${before}` : "");
  const res = await gwFetch(path);
  if (res !== null) {
    try {
      const data = (await res.json()) as { rows?: Record<string, unknown>[] };
      return data.rows ?? [];
    } catch {
      // fall through to SDK
    }
  }
  return iqlabs.reader.readTableRows(tablePda, { limit, before });
}

// Page through gwFetchRows until at least maxRows or the gateway returns
// fewer than asked (signals end of table).
export async function gwFetchAllRows(
  tablePda: string,
  maxRows = 200,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let before: string | undefined;
  while (all.length < maxRows) {
    const limit = Math.min(50, maxRows - all.length);
    const rows = await gwFetchRows(tablePda, limit, before);
    all.push(...rows);
    if (rows.length < limit) break;
    const last = rows[rows.length - 1] as { __txSignature?: string };
    if (!last.__txSignature) break;
    before = last.__txSignature;
  }
  return all;
}

// Load a JSON blob by tx signature. Gateway-first via /data/{sig}, falls
// back to SDK's loadTree (RPC) on full chain failure.
export async function gwLoadTreeJson<T>(txSignature: string): Promise<T> {
  const res = await gwFetch(`/data/${txSignature}`);
  if (res !== null) {
    try {
      const env = (await res.json()) as { data?: string };
      if (typeof env.data === "string") return JSON.parse(env.data) as T;
    } catch {
      // fall through
    }
  }
  return (await loadTree(txSignature)) as T;
}

// Fire-and-forget cache-warm hint after a write. Tries each gateway until
// one ack-2xxs. Failures swallowed — the row is on chain, gateways will
// pick it up on their next poll regardless.
export async function gwNotify(
  tablePda: string,
  txSignature: string,
  row?: Record<string, unknown>,
  signer?: string,
): Promise<void> {
  const body = JSON.stringify({ txSignature, row, signer });
  for (const base of getGatewayUrls()) {
    try {
      const res = await fetch(`${base}/table/${tablePda}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
    } catch {
      // try next gateway
    }
  }
}
