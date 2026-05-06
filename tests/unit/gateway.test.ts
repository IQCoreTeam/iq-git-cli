// Unit: src/core/gateway.ts — exercises the real HTTP code path against
// a node:http mock listener. No mocks, no new deps; just a tiny server
// per test that captures the request and returns a canned response.

import assert from "node:assert/strict";
import http from "node:http";
import { Buffer } from "node:buffer";
import {
  gwFetchAllRows,
  gwFetchRows,
  gwLoadBlobBase64,
  gwLoadTreeJson,
  gwNotify,
} from "../../src/core/gateway";

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}
interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

function start(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = [];
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
        handler(req, body, res);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

// 1. gwFetchRows: 200 → returns rows[]; URL contains pda + limit
{
  const s = await start((_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rows: [{ id: "a" }, { id: "b" }] }));
  });
  process.env.GATEWAY_URL = s.url;
  const rows = await gwFetchRows("FakePda", 50);
  assert.equal(rows.length, 2);
  assert.equal((rows[0] as { id: string }).id, "a");
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].method, "GET");
  assert.match(s.requests[0].url, /\/table\/FakePda\/rows\?limit=50/);
  await s.close();
  delete process.env.GATEWAY_URL;
}

// 2. multi-URL fallback chain: first URL 500s → second URL takes over
{
  let firstHits = 0;
  const a = await start((_req, _body, res) => {
    firstHits++;
    res.writeHead(500);
    res.end();
  });
  const b = await start((_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rows: [{ id: "fallback" }] }));
  });
  process.env.GATEWAY_URL = `${a.url},${b.url}`;
  const rows = await gwFetchRows("FakePda", 25);
  assert.equal(firstHits, 1, "first URL was tried");
  assert.equal((rows[0] as { id: string }).id, "fallback");
  assert.equal(b.requests.length, 1);
  await a.close();
  await b.close();
  delete process.env.GATEWAY_URL;
}

// 3. gwFetchAllRows: paginates via __txSignature cursor; second page uses ?before=
{
  let page = 0;
  const s = await start((_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    page++;
    if (page === 1) {
      const rows = Array.from({ length: 50 }, (_, i) => ({ idx: i, __txSignature: `sig${i}` }));
      res.end(JSON.stringify({ rows }));
    } else {
      const rows = Array.from({ length: 5 }, (_, i) => ({ idx: 50 + i, __txSignature: `sig${50 + i}` }));
      res.end(JSON.stringify({ rows }));
    }
  });
  process.env.GATEWAY_URL = s.url;
  const all = await gwFetchAllRows("FakePda", 100);
  assert.equal(all.length, 55, "should collect 50 + 5 = 55 rows");
  assert.equal((all[54] as { idx: number }).idx, 54);
  assert.equal(s.requests.length, 2);
  assert.match(s.requests[1].url, /before=sig49/, "second page uses last sig as cursor");
  await s.close();
  delete process.env.GATEWAY_URL;
}

// 4. gwLoadTreeJson: unwraps {data: "<JSON-string>"} envelope
{
  const tree = { "README.md": { txId: "T1", hash: "H1" } };
  const s = await start((_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: JSON.stringify(tree), metadata: "ignored" }));
  });
  process.env.GATEWAY_URL = s.url;
  const got = await gwLoadTreeJson<typeof tree>("Sig123");
  assert.equal(got["README.md"].txId, "T1");
  assert.equal(got["README.md"].hash, "H1");
  assert.match(s.requests[0].url, /\/data\/Sig123$/);
  await s.close();
  delete process.env.GATEWAY_URL;
}

// 5. gwLoadBlobBase64: returns the raw `data` field as base64 string
{
  const s = await start((_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: "SGVsbG8gV29ybGQ=" })); // "Hello World"
  });
  process.env.GATEWAY_URL = s.url;
  const got = await gwLoadBlobBase64("Sig456");
  assert.equal(got, "SGVsbG8gV29ybGQ=");
  assert.equal(Buffer.from(got, "base64").toString("utf8"), "Hello World");
  await s.close();
  delete process.env.GATEWAY_URL;
}

// 6. gwNotify: POST /table/{pda}/notify with {txSignature, row, signer} body
{
  const s = await start((_req, _body, res) => {
    res.writeHead(200);
    res.end();
  });
  process.env.GATEWAY_URL = s.url;
  await gwNotify("FakePda", "FakeSig", { col: "value" }, "FakeSigner");
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].method, "POST");
  assert.equal(s.requests[0].url, "/table/FakePda/notify");
  const body = JSON.parse(s.requests[0].body) as {
    txSignature: string;
    row: { col: string };
    signer: string;
  };
  assert.equal(body.txSignature, "FakeSig");
  assert.equal(body.row.col, "value");
  assert.equal(body.signer, "FakeSigner");
  await s.close();
  delete process.env.GATEWAY_URL;
}

// 7. GATEWAY_URL=off: gwNotify is a true no-op (zero HTTP requests)
{
  const s = await start((_req, _body, res) => {
    res.writeHead(200);
    res.end();
  });
  process.env.GATEWAY_URL = "off";
  await gwNotify("FakePda", "FakeSig");
  assert.equal(s.requests.length, 0, "GATEWAY_URL=off → no HTTP at all");
  await s.close();
  delete process.env.GATEWAY_URL;
}

console.log("gateway unit ok");
