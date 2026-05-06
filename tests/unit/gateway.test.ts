// Unit: src/core/gateway.ts — env-driven config + transparent fallback.
// Pure logic + the gateway-disabled paths; HTTP fetch is exercised by
// integration runs against a real gateway.

import assert from "node:assert/strict";
import { gwFetchRows, gwFetchAllRows, gwNotify } from "../../src/core/gateway";

// Without GATEWAY_URL set, gwFetchRows must NOT throw — it falls back to
// SDK's readTableRows. We can't actually exercise that here without a
// real RPC, so we only verify gwNotify is a no-op and the function exports
// resolve.
delete process.env.GATEWAY_URL;
await gwNotify("FakePda", "FakeSig"); // no-op when no gateway, must not throw

// With GATEWAY_URL=invalid, gwNotify silently swallows the error.
process.env.GATEWAY_URL = "https://this-host-does-not-exist.invalid";
await gwNotify("FakePda", "FakeSig"); // must not throw

// Sanity: the public exports are functions
assert.equal(typeof gwFetchRows, "function");
assert.equal(typeof gwFetchAllRows, "function");
assert.equal(typeof gwNotify, "function");

delete process.env.GATEWAY_URL;
console.log("gateway unit ok");
