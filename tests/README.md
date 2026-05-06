# tests

Style: plain `node:assert/strict` + top-level statements, matching
`iqlabs-solana-sdk/tests/contract/smoke.ts`. No vitest, no jest, one
file per concern, run via `tsx`.

## layers

| dir            | needs RPC | needs SOL | when                      |
|----------------|-----------|-----------|---------------------------|
| `unit/`        | no        | no        | every `npm test`          |
| `integration/` | no        | no        | every `npm test`          |
| `e2e/`         | yes       | yes (~0.05 SOL) | gated by env, opt-in |

## run

```bash
npm test                  # unit + integration (no chain)
npm run test:unit
npm run test:integration
npm run test:e2e          # mainnet — needs INTEGRATION_RPC + INTEGRATION_KEYPAIR
```

E2E env contract:

| var                  | example                                         |
|----------------------|-------------------------------------------------|
| `INTEGRATION_RPC`    | `https://mainnet.helius-rpc.com/?api-key=...`   |
| `INTEGRATION_KEYPAIR`| absolute path to a funded keypair JSON          |

E2E will refuse to run if balance is < 0.05 SOL.
