# FairTrade Infra Benchmarks

> High-throughput, low-cost FairTrade traceability and payment benchmarking on Optimism Sepolia.

---

## Table of Contents

1. [Introduction](#introduction)
2. [Repository Layout](#repository-layout)
3. [Smart Contracts](#smart-contracts)
    - [Deployed Addresses (Optimism Sepolia)](#deployed-addresses-optimism-sepolia)
    - [Contract Reference](#contract-reference)
4. [Benchmark & Utility Scripts](#benchmark--utility-scripts)
    - [RPC / Throughput Benchmarks](#rpc--throughput-benchmarks)
    - [Faucet & Actor Management](#faucet--actor-management)
    - [Deployment & Project Tooling](#deployment--project-tooling)
    - [Evidence Verifiability Simulation (IPFS RPC)](#evidence-verifiability-simulation-ipfs-rpc)
    - [Audit Reconstruction (On-chain Logs)](#audit-reconstruction-on-chain-logs)
    - [Minimal Example](#minimal-example)
5. [FairTrade Batch Example](#fairtrade-batch-example)
6. [Environment & Prerequisites](#environment--prerequisites)
7. [Testing & Development Workflow](#testing--development-workflow)
8. [License](#license)

---

## Introduction

This repository contains a compact Hardhat 3 project that implements and benchmarks an on-chain infrastructure for FairTrade-style supply-chain transparency:

- **Traceability:** Supply-chain steps and supporting documents are referenced via IPFS CIDs and anchored on-chain as **events**, keeping storage usage minimal.
- **Registries:** A lightweight actor registry controls which wallets can participate and in which roles.
- **Lifecycle management:** A coarse-grained process manager tracks product/batch lifecycle states.
- **Payments:** A simple router splits FairTrade premiums across stakeholders.
- **Benchmarks:** TypeScript scripts measure gas costs and approximate transactions-per-second for different Optimism Sepolia RPC setups.
- **Evidence verifiability (added):** A simulation script validates that off-chain evidence stored via an IPFS RPC endpoint is retrievable by CID and re-hashes to the same CID after retrieval (integrity verification). This supports paper-style “evidence verifiability” metrics.
- **Audit reconstruction (added):** A script reconstructs an auditable batch timeline from on-chain logs across `CidRollup`, `DocumentRegistry`, and `ProcessManager`, producing a machine-readable JSON report plus a human-readable timeline.

The goal is to provide **realistic, reproducible benchmarks** for a FairTrade-like workflow (e.g., coffee batches) while keeping the on-chain footprint small enough to be practical for low-margin supply chains.

---

## Repository Layout

- `contracts/` – Solidity contracts for the FairTrade infra and sample Counter.
- `scripts/` – Deployment, benchmarking, faucet, and utility scripts (TypeScript).
- `src/` – Minimal TypeScript entrypoint used by the Hardhat 3 template.
- `test/` – Mocha / Hardhat tests for the sample Counter contract.

---

## Smart Contracts

### Deployed Addresses (Optimism Sepolia)

| Contract         | Address                                      | Purpose                        |
|------------------|----------------------------------------------|--------------------------------|
| `ActorRegistry`  | `0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1` | Actor and role registry        |
| `DocumentRegistry` | `0xBEb8140eeaf2f23916dA88F8F0886827a0f5145c` | IPFS document anchors          |
| `ProcessManager` | `0xeD7AA6c4B1fA3FFCEC378dcFEAc0406540F5078c` | Batch lifecycle state machine  |
| `CidRollup`      | `0xC6d171F707bA43BdF490362a357D975B76976264` | High-throughput CID batch log  |
| `PaymentRouter`  | `0x87d6582186520Ca818F0E4e3acc0826e7bAeaCfe` | Premium split / payout router  |

> Network: **Optimism Sepolia**  
> For local deployments, see [`scripts/deploy-op-sepolia.ts`](#deploy-op-sepolia-ts).

### Contract Reference

#### `FairtradeTypes.sol`

Shared enums used across the infra contracts:

- `Role` – `Producer`, `Processor`, `Logistics`, `Retailer`, `Certifier`, `Regulator`, `Operator`.
- `Status` – `Unknown`, `Active`, `Suspended`, `Revoked`.
- `StepType` – Fine-grained supply-chain step classification (Produced, Processed, Shipped, Received, AtRetail, Sold).
- `ProcessStatus` – Coarse lifecycle state for products/batches (Created, InTransit, AtRetail, Sold, Certified, etc.).

This file has no storage or external functions; it is purely a type library.

---

#### `ActorRegistry.sol`

Ownable registry mapping wallets to organizations and roles.

- **State:**
    - `owner` – admin wallet (set in constructor).
    - `_actors[wallet]` – `Actor { orgIdHash, role, status, metadataHash }`.
    - `_walletByOrg[orgIdHash]` – primary wallet for an organization.

- **Key functions:**
    - `registerActor(orgIdHash, wallet, role, metadataHash)` – owner-only, registers a new active actor; enforces unique `orgIdHash` and wallet.
    - `updateActorRole(orgIdHash, newRole)` – owner-only.
    - `updateActorStatus(orgIdHash, newStatus)` – owner-only.
    - `updateActorMetadata(orgIdHash, newMetadataHash)` – owner-only.
    - `getActor(wallet)` / `getActorByOrg(orgIdHash)` – read-only views for other contracts.
    - `hasRole(wallet, role)` – checks if wallet has given role and is active.
    - `isActiveActor(wallet)` – checks that wallet is registered and status is `Active`.

This registry is the **single source of truth** for who is allowed to interact with the infra contracts.

---

#### `CidRollup.sol`

High-throughput batch anchor for supply-chain CID events.

- **Dependencies:** `IActorRegistryForCid` interface (ActorRegistry view subset).
- **State:**
    - `actorRegistry` – immutable registry reference.
    - `usedStepKey[keccak256(productId, stepId)]` – optional anti-replay guard.

- **Core types:**
    - `CidEvent { productId, stepId, cidHash, stepType }` – encoded in calldata; `stepType` is `FairtradeTypes.StepType` as `uint8`.

- **Key functions:**
    - `submitCidBatch(CidEvent[] calldata events)`:
        - Requires `msg.sender` to be an `Active` actor.
        - Ensures each `(productId, stepId)` pair has not been seen before.
        - Emits:
            - `CidAnchored(...)` once per event (includes `orgIdHash` and `actor`).
            - `CidBatchSubmitted(submitter, count)` once per batch.

All detailed data lives in **events**, keeping on-chain storage minimal and allowing efficient off-chain indexing.

---

#### `DocumentRegistry.sol`

Anchors supporting documents (PDFs, photos, reports) by CID.

- **Dependencies:** `IActorRegistryForDocs` interface.
- **Key function:**
    - `anchorDocument(productId, stepId, cidHash, docType)`:
        - Requires `msg.sender` to be an active actor.
        - Looks up `orgIdHash` from the actor registry.
        - Emits `DocumentAnchored(productId, stepId, cidHash, docType, orgIdHash, actor)`.

No per-document storage is kept; everything is represented by events.

---

#### `ProcessManager.sol`

Simple lifecycle state machine for product/batch IDs.

- **Dependencies:** `IActorRegistryForProcess` interface.
- **State:**
    - `_processes[productId] = Process { status, creatorOrgId }`.

- **Key functions:**
    - `createProcess(productId)`:
        - `onlyActiveActor`.
        - Requires no existing process for `productId`.
        - Marks status as `ProcessStatus.Created`.
        - Emits `ProcessCreated` and `ProcessStatusChanged`.
    - `advanceStatus(productId, newStatus)`:
        - `onlyActiveActor`.
        - Requires existing process.
        - Enforces `uint8(newStatus) > uint8(oldStatus)` (monotonic).
        - Emits `ProcessStatusChanged`.
    - `getStatus(productId)` / `getProcess(productId)` – read-only views.

This contract provides a **coarse, monotonic lifecycle** that can be reconciled with the richer event-level data from `CidRollup` and `DocumentRegistry`.

---

#### `PaymentRouter.sol`

Splits FairTrade premiums among recipients using basis points.

- **Dependencies:** `IActorRegistryForPayments` interface.
- **State:**
    - `_splits[] = Split { recipient, bps }`.
    - `totalBps` – sum of configured basis points (must be `<= 10_000`).

- **Key functions:**
    - **Constructor** – takes:
        - `actorRegistry` address.
        - `recipients[]` and parallel `bps[]`.
        - Validates non-zero addresses, non-zero bps, and total `<= 10_000`.
    - `routePayment(productId)`:
        - `msg.value` is split across recipients according to basis points.
        - Sender must be an `Active` actor.
        - Emits:
            - `PaymentReceived(productId, payer, amount)` once.
            - `PaymentRouted(productId, recipient, share)` per recipient.
        - Any remainder due to integer division stays in the contract.
    - `getSplits()` – returns a copy of the configured splits.

---

#### `Counter.sol` & `Counter.t.sol`

A minimal counter contract and Foundry-compatible Solidity tests, kept from the original Hardhat 3 template. They are useful as sanity checks but are not part of the FairTrade infra.

---

## Benchmark & Utility Scripts

Below is an overview of the main scripts. All scripts are intended to be run from the project root using `npx tsx <path>` or via `npx hardhat run` where indicated.

### RPC / Throughput Benchmarks

#### `scripts/benchmark-cid-batch.ts`

Multi-wallet flood of `CidRollup.submitCidBatch` calls across multiple private Optimism Sepolia RPC endpoints.

- **Purpose**
    - Measure how many high-density CID batches can be submitted over a short interval using many funded wallets and multiple RPC providers.

- **Invocation**

```bash
npx tsx scripts/benchmark-cid-batch.ts
````

* **Inputs**

    * **Env vars**

        * `OP_SEPOLIA_PRIVATE_RPCS_JSON` – JSON array of HTTP RPC URLs.
        * `BATCH_SIZE` *(optional)* – CIDs per transaction (default `200`).
        * `DURATION_MS` *(optional)* – max sending time window (default `30000`).
        * `WORKERS_PER_RPC` *(optional)* – worker coroutines per RPC (default `3`).
        * `CID_RUN_ID` *(optional)* – tag to make product/step IDs unique.
        * `FAUCET_STATE_FILE` *(optional)* – path to faucet wallets JSON.
    * **Files**

        * Faucet state file (`op-sepolia-faucet-wallets-batch.json` by default), containing wallets with `funded: true`.

* **Outputs**

    * Per-wallet / worker logs with tx hashes.
    * Summary with total attempts, successes, failures, elapsed time, and approximate tx/s (send-only).

* **Tuning tips**

    * Increase `WORKERS_PER_RPC` to push the RPC harder; decrease if you see rate-limit errors.
    * Increase `BATCH_SIZE` to amortize gas overhead per tx; decrease if batches start reverting.
    * Adjust `DURATION_MS` to balance run time vs. number of wallets consumed.
    * Keep the internal `sleep(100)` between sends if you see frequent provider throttling.

---

#### `scripts/benchmark-op-infura-multiwallet.ts`

Single-RPC multi-wallet RPS benchmark for an Infura Optimism Sepolia endpoint.

* **Purpose**

    * Estimate raw tx/s throughput for a **single** Infura OP Sepolia RPC using many pre-funded wallets.

* **Invocation**

```bash
npx tsx scripts/benchmark-op-infura-multiwallet.ts
```

* **Inputs**

    * **Env vars**

        * `OP_SEPOLIA_RPC_URL` – Infura (or similar) OP Sepolia RPC URL.
    * **Files**

        * `op-sepolia-faucet-wallets.json` – faucet wallet list with `funded: true`.

* **Outputs**

    * One tx per funded wallet, broadcast in parallel.
    * Summary with successful sends, failures, elapsed time, and approximate successful RPS.

* **Tuning tips**

    * The per-tx value is `balance / 100_000_000n` of the sample wallet; change the divisor in the script if you want larger/smaller transfers.
    * If the endpoint rate-limits you, consider adding an explicit `sleep` or reducing the wallet count in the faucet file.

---

#### `scripts/benchmark-op-rpcs.ts`

Benchmark multiple OP Sepolia RPC endpoints with bounded concurrency.

* **Purpose**

    * Compare multiple public RPC providers in terms of successful tx/s under controlled load.

* **Invocation**

```bash
npx tsx scripts/benchmark-op-rpcs.ts
```

* **Inputs**

    * **Env vars**

        * `OP_SEPOLIA_PUBLIC_RPCS_JSON` – JSON array of RPC URLs to test.
        * `OP_SEPOLIA_PRIVATE_KEY` – funder private key used across all RPCs.
        * `RPC_BENCH_TX_COUNT` *(optional)* – txs to attempt per RPC (default `60`).
        * `RPC_BENCH_CONCURRENCY` *(optional)* – max in-flight txs per RPC (default `20`).
        * `RPC_BENCH_GAS_BUFFER_ETH` *(optional)* – ETH kept aside as gas buffer (default `0.05`).
    * No additional files required.

* **Outputs**

    * Per-RPC summary: successful txs, failures, elapsed time, approximate tx RPS.

* **Tuning tips**

    * Increase `RPC_BENCH_TX_COUNT` for more stable averages; keep an eye on total spend.
    * Adjust `RPC_BENCH_CONCURRENCY` to match the rate limits of each provider.
    * Raise `RPC_BENCH_GAS_BUFFER_ETH` if you want a more conservative safety margin on the funder wallet.

---

#### `scripts/estimate-cid-batch-limit.ts`

Binary search for the maximum `CidRollup.submitCidBatch` size that fits within gas limits.

* **Purpose**

    * Empirically determine the largest batch size that can be confirmed without out-of-gas or similar reverts, using real transactions.

* **Invocation**

```bash
npx tsx scripts/estimate-cid-batch-limit.ts
```

* **Inputs**

    * **Env vars**

        * `OP_SEPOLIA_RPC_URL`
        * `OP_SEPOLIA_PRIVATE_KEY`
        * `CID_MIN_BATCH` *(optional)* – lower bound (default `100`).
        * `CID_MAX_BATCH` *(optional)* – upper bound (default `4096`).
        * `CID_INITIAL_BATCH` *(optional)* – starting size (default `800`).
        * `CID_RUN_ID` *(optional)* – run tag for unique IDs.
        * `CID_TRIAL_DELAY_MS` *(optional)* – delay between trials (default `10000`).
    * Uses hard-coded `ACTOR_REGISTRY_ADDRESS` and `CID_ROLLUP_ADDRESS` for OP Sepolia.

* **Outputs**

    * Logs for each attempted batch size (success/failure, gas used).
    * Final report with best confirmed batch size and gas usage.

* **Tuning tips**

    * Narrow `CID_MIN_BATCH` / `CID_MAX_BATCH` once you have a rough idea of the range to speed up the search.
    * Increase `CID_TRIAL_DELAY_MS` if your RPC gets rate-limited.
    * The script auto-registers the sender as a `Producer` if needed; ensure the deployer has enough ETH before running.

---

### Faucet & Actor Management

#### `scripts/distribute-op-faucet.ts`

Distribute OP Sepolia ETH from a funder wallet to a pool of test wallets.

* **Purpose**

    * Generate and maintain a set of funded test wallets used by the benchmark scripts.

* **Invocation**

```bash
npx hardhat run scripts/distribute-op-faucet.ts --network opSepolia
# or
npx tsx scripts/distribute-op-faucet.ts
```

* **Inputs**

    * **Env vars**

        * `OP_SEPOLIA_RPC_URL`
        * `OP_SEPOLIA_PRIVATE_KEY` – funder wallet with OP Sepolia ETH.
    * **Constants (in-script)**

        * `TARGET_WALLET_COUNT` – total wallets to maintain (default `50`).
        * `GAS_BUFFER_WEI` – safety buffer to leave on funder.
        * `PER_TX_DELAY_MS` – delay between sends (default `300ms`).

* **Outputs**

    * `op-sepolia-faucet-wallets-batch.json` with:

        * `address`, `privateKey`, `funded` for each wallet.
    * Logs describing per-wallet funding and remaining unfunded count.

---

#### `scripts/register-actors-from-faucet.ts`

Registers funded faucet wallets as `Producer` actors in `ActorRegistry`.

* **Purpose**

    * Ensure all funded test wallets are recognized as active actors so they can call `CidRollup`, `DocumentRegistry`, etc.

* **Invocation**

```bash
npx tsx scripts/register-actors-from-faucet.ts
```

---

#### `scripts/gen-test-wallet.ts`

Generate a single throwaway test wallet.

* **Purpose**

    * Quickly create a new OP Sepolia test wallet and get a ready-to-paste `.env` line.

* **Invocation**

```bash
npx tsx scripts/gen-test-wallet.ts
```

---

### Deployment & Project Tooling

#### `scripts/deploy-op-sepolia.ts`

Deploy the FairTrade infra contracts to OP Sepolia and record the addresses.

* **Invocation**

```bash
npx hardhat run scripts/deploy-op-sepolia.ts --network opSepolia
```

---

#### `scripts/dump-project.ts`

Emit a textual snapshot of the project into `project_snapshot.txt`.

* **Invocation**

```bash
npx tsx scripts/dump-project.ts
```

---

## Evidence Verifiability Simulation (IPFS RPC)

### `scripts/sim-filebase-evidence.ts`

This script validates **off-chain evidence** storage and retrieval using an IPFS RPC endpoint (e.g., Filebase):

* Uploads evidence blobs at multiple sizes (10KB, 100KB, 1MB, 5MB) using `/api/v0/add`.
* Fetches them back using `/api/v0/cat`.
* Recomputes the CID locally and verifies the fetched bytes **rehash to the same CID** (integrity verification).
* Logs upload/fetch latency and writes a machine-readable report to `evidence_results.json` in the repo root.

#### What it measures (paper-style metrics)

* **Retrievability rate** = fetched / total
* **CID match rate** = CID-match / fetched
* **Upload latency** = p50/p95 (ms)
* **Fetch latency** = p50/p95 (ms)

#### Usage

1. Install dependencies:

```bash
npm install
npm i undici dotenv ipfs-only-hash
```

2. Add these env vars to `.env` (example):

```env
FILEBASE_IPFS_RPC_ENDPOINT=https://rpc.filebase.io
FILEBASE_IPFS_RPC_AUTH_TYPE=bearer
FILEBASE_IPFS_RPC_TOKEN=YOUR_IPFS_RPC_API_KEY
EVIDENCE_REPEATS=10
```

3. Run:

```bash
npx tsx scripts/sim-filebase-evidence.ts
```

#### Output

* Writes `evidence_results.json` in the repo root.
* Summary fields include: `objects_total`, `upload_success`, `fetch_success`, `cid_match_success`, `retrievability_rate`, `cid_match_rate`, `upload_latency_ms`, `fetch_latency_ms`, `failure_count`.

#### Reference run results (2026-02-23)

* `objects_total: 40`
* `upload_success: 40`
* `fetch_success: 40`
* `cid_match_success: 40`
* `retrievability_rate: 1.00`
* `cid_match_rate: 1.00`
* `upload_latency_ms: p50 = 737 ms, p95 = 5237 ms`
* `fetch_latency_ms: p50 = 361 ms, p95 = 770 ms`
* `failure_count: 0`

---

## Audit Reconstruction (On-chain Logs)

### `scripts/reconstruct-audit-from-logs.ts`

This script reconstructs an auditable batch timeline from on-chain logs for a given `productId`.

**It answers:** “Given a batch ID, can an auditor reconstruct the full chain-of-custody and evidence pointers purely from immutable logs?”

#### What it does

* Queries logs from:

    * `CidRollup` events (CID anchors per step)
    * `DocumentRegistry` events (evidence/document anchors)
    * `ProcessManager` events (process creation and status transitions)
* Filters by indexed `productId`
* Sorts by `(blockNumber, logIndex)` (canonical chain order)
* Decodes key fields into a unified event timeline
* Prints a readable timeline and writes a machine-readable JSON report

#### Usage

```bash
# productId can be a string (hashed to bytes32 in-script)
npx tsx scripts/reconstruct-audit-from-logs.ts --productId "coffee-batch-001" --lookback 200000

# or a bytes32 hex productId
npx tsx scripts/reconstruct-audit-from-logs.ts --productId 0x<64-hex-chars> --fromBlock 39900000 --toBlock 40100000
```

#### Inputs

**Env vars**

* `OP_SEPOLIA_RPC_URL` (required)

Optional overrides (otherwise defaults to README deployment addresses):

* `CID_ROLLUP_ADDRESS`
* `DOCUMENT_REGISTRY_ADDRESS`
* `PROCESS_MANAGER_ADDRESS`

**CLI flags**

* `--productId` (required)
* `--lookback` (optional)
* `--fromBlock`, `--toBlock` (optional)
* `--out` (optional)

#### Output

* Prints a merged timeline of events in chronological chain order.
* Writes a JSON report: `audit_reconstruction_<productIdPrefix>.json` with:

    * `summary` (counts, scan bounds, completeness proxy)
    * `events[]` (decoded events with timestamps and tx hashes)

#### Practical note on RPC rate limits

Some RPC providers limit the `eth_getLogs` block range per request (free tiers can be as low as 10 blocks). If you see errors like “block range should work: [a,b]”, use:

* a different RPC from `OP_SEPOLIA_PUBLIC_RPCS_JSON`, or
* chunked scanning (the script is designed to support this), or
* an indexer (recommended for production).

---

## Minimal Example

### `scripts/send-op-tx.ts`

Minimal Hardhat 3 example for sending a transaction on an OP-style chain.

* **Invocation**

```bash
npx hardhat run scripts/send-op-tx.ts --network hardhatOp
```

---

## FairTrade Batch Example

A dedicated batch walkthrough script (see README notes for `scripts/run-fairtrade-batch-ops.ts`) moves a single **coffee batch** through six step types:

1. `Produced`
2. `Processed`
3. `Shipped`
4. `Received`
5. `AtRetail`
6. `Sold`

For one representative run:

* Total CID-anchor events: **13**
* Average gas per anchor: **≈ 62,841 gas**
* Total gas over the batch: **≈ 816,939 gas**
* At a representative gas price, this corresponds to a per-event and per-batch USD cost in the low sub-cent range.

This provides a concrete data point for the per-batch model used in the accompanying paper, and can be recomputed with different RPCs, gas prices, or contract revisions.

---

## Environment & Prerequisites

* Node.js ≥ 18.x
* npm (or pnpm/yarn)
* Access to OP Sepolia RPC endpoints (public and/or private).
* A funded OP Sepolia account for deployments and benchmarks.

Typical `.env` variables used across scripts:

```env
OP_SEPOLIA_RPC_URL=https://...
OP_SEPOLIA_PRIVATE_KEY=0x...

OP_SEPOLIA_PUBLIC_RPCS_JSON=["https://...","https://..."]
OP_SEPOLIA_PRIVATE_RPCS_JSON=["https://..."]

# Optional benchmark knobs:
RPC_BENCH_TX_COUNT=60
RPC_BENCH_CONCURRENCY=20
RPC_BENCH_GAS_BUFFER_ETH=0.05
BATCH_SIZE=200
DURATION_MS=30000
WORKERS_PER_RPC=3

# Evidence verifiability simulation (IPFS RPC)
FILEBASE_IPFS_RPC_ENDPOINT=https://rpc.filebase.io
FILEBASE_IPFS_RPC_AUTH_TYPE=bearer
FILEBASE_IPFS_RPC_TOKEN=YOUR_IPFS_RPC_API_KEY
EVIDENCE_REPEATS=10
```

(See each script section for additional optional variables.)

---

## Testing & Development Workflow

Install dependencies:

```bash
npm install
```

Compile contracts:

```bash
npx hardhat compile
```

Run all tests (Solidity + mocha):

```bash
npx hardhat test
```

Run only Solidity tests:

```bash
npx hardhat test solidity
```

Run only TypeScript/mocha tests:

```bash
npx hardhat test mocha
```

For local experimentation, you can also wire the contracts into Hardhat’s in-process network or other testnets by adjusting the Hardhat config and reusing the deployment script.

---

## License

Each Solidity file declares its own SPDX license identifier (`MIT` or `UNLICENSED`).
Please refer to individual source files for the precise licensing terms.

```
::contentReference[oaicite:0]{index=0}
```
