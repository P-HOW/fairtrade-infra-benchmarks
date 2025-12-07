
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
  ```

- **Inputs**
    - **Env vars**
        - `OP_SEPOLIA_PRIVATE_RPCS_JSON` – JSON array of HTTP RPC URLs.
        - `BATCH_SIZE` *(optional)* – CIDs per transaction (default `200`).
        - `DURATION_MS` *(optional)* – max sending time window (default `30000`).
        - `WORKERS_PER_RPC` *(optional)* – worker coroutines per RPC (default `3`).
        - `CID_RUN_ID` *(optional)* – tag to make product/step IDs unique.
        - `FAUCET_STATE_FILE` *(optional)* – path to faucet wallets JSON.
    - **Files**
        - Faucet state file (`op-sepolia-faucet-wallets-batch.json` by default), containing wallets with `funded: true`.

- **Outputs**
    - Per-wallet / worker logs with tx hashes.
    - Summary with total attempts, successes, failures, elapsed time, and approximate tx/s (send-only).

- **Tuning tips**
    - Increase `WORKERS_PER_RPC` to push the RPC harder; decrease if you see rate-limit errors.
    - Increase `BATCH_SIZE` to amortize gas overhead per tx; decrease if batches start reverting.
    - Adjust `DURATION_MS` to balance run time vs. number of wallets consumed.
    - Keep the internal `sleep(100)` between sends if you see frequent provider throttling.

---

#### `scripts/benchmark-op-infura-multiwallet.ts`

Single-RPC multi-wallet RPS benchmark for an Infura Optimism Sepolia endpoint.

- **Purpose**
    - Estimate raw tx/s throughput for a **single** Infura OP Sepolia RPC using many pre-funded wallets.

- **Invocation**

  ```bash
  npx tsx scripts/benchmark-op-infura-multiwallet.ts
  ```

- **Inputs**
    - **Env vars**
        - `OP_SEPOLIA_RPC_URL` – Infura (or similar) OP Sepolia RPC URL.
    - **Files**
        - `op-sepolia-faucet-wallets.json` – faucet wallet list with `funded: true`.

- **Outputs**
    - One tx per funded wallet, broadcast in parallel.
    - Summary with successful sends, failures, elapsed time, and approximate successful RPS.

- **Tuning tips**
    - The per-tx value is `balance / 100_000_000n` of the sample wallet; change the divisor in the script if you want larger/smaller transfers.
    - If the endpoint rate-limits you, consider adding an explicit `sleep` or reducing the wallet count in the faucet file.

---

#### `scripts/benchmark-op-rpcs.ts`

Benchmark multiple OP Sepolia RPC endpoints with bounded concurrency.

- **Purpose**
    - Compare multiple public RPC providers in terms of successful tx/s under controlled load.

- **Invocation**

  ```bash
  npx tsx scripts/benchmark-op-rpcs.ts
  ```

- **Inputs**
    - **Env vars**
        - `OP_SEPOLIA_PUBLIC_RPCS_JSON` – JSON array of RPC URLs to test.
        - `OP_SEPOLIA_PRIVATE_KEY` – funder private key used across all RPCs.
        - `RPC_BENCH_TX_COUNT` *(optional)* – txs to attempt per RPC (default `60`).
        - `RPC_BENCH_CONCURRENCY` *(optional)* – max in-flight txs per RPC (default `20`).
        - `RPC_BENCH_GAS_BUFFER_ETH` *(optional)* – ETH kept aside as gas buffer (default `0.05`).
    - No additional files required.

- **Outputs**
    - Per-RPC summary: successful txs, failures, elapsed time, approximate tx RPS.

- **Tuning tips**
    - Increase `RPC_BENCH_TX_COUNT` for more stable averages; keep an eye on total spend.
    - Adjust `RPC_BENCH_CONCURRENCY` to match the rate limits of each provider.
    - Raise `RPC_BENCH_GAS_BUFFER_ETH` if you want a more conservative safety margin on the funder wallet.

---

#### `scripts/estimate-cid-batch-limit.ts`

Binary search for the maximum `CidRollup.submitCidBatch` size that fits within gas limits.

- **Purpose**
    - Empirically determine the largest batch size that can be confirmed without out-of-gas or similar reverts, using real transactions.

- **Invocation**

  ```bash
  npx tsx scripts/estimate-cid-batch-limit.ts
  ```

- **Inputs**
    - **Env vars**
        - `OP_SEPOLIA_RPC_URL`
        - `OP_SEPOLIA_PRIVATE_KEY`
        - `CID_MIN_BATCH` *(optional)* – lower bound (default `100`).
        - `CID_MAX_BATCH` *(optional)* – upper bound (default `4096`).
        - `CID_INITIAL_BATCH` *(optional)* – starting size (default `800`).
        - `CID_RUN_ID` *(optional)* – run tag for unique IDs.
        - `CID_TRIAL_DELAY_MS` *(optional)* – delay between trials (default `10000`).
    - Uses hard-coded `ACTOR_REGISTRY_ADDRESS` and `CID_ROLLUP_ADDRESS` for OP Sepolia.

- **Outputs**
    - Logs for each attempted batch size (success/failure, gas used).
    - Final report with best confirmed batch size and gas usage.

- **Tuning tips**
    - Narrow `CID_MIN_BATCH` / `CID_MAX_BATCH` once you have a rough idea of the range to speed up the search.
    - Increase `CID_TRIAL_DELAY_MS` if your RPC gets rate-limited.
    - The script auto-registers the sender as a `Producer` if needed; ensure the deployer has enough ETH before running.

---

### Faucet & Actor Management

#### `scripts/distribute-op-faucet.ts`

Distribute OP Sepolia ETH from a funder wallet to a pool of test wallets.

- **Purpose**
    - Generate and maintain a set of funded test wallets used by the benchmark scripts.

- **Invocation**

  ```bash
  npx hardhat run scripts/distribute-op-faucet.ts --network opSepolia
  # or
  npx tsx scripts/distribute-op-faucet.ts
  ```

- **Inputs**
    - **Env vars**
        - `OP_SEPOLIA_RPC_URL`
        - `OP_SEPOLIA_PRIVATE_KEY` – funder wallet with OP Sepolia ETH.
    - **Constants (in-script)**
        - `TARGET_WALLET_COUNT` – total wallets to maintain (default `50`).
        - `GAS_BUFFER_WEI` – safety buffer to leave on funder.
        - `PER_TX_DELAY_MS` – delay between sends (default `300ms`).

- **Outputs**
    - `op-sepolia-faucet-wallets-batch.json` with:
        - `address`, `privateKey`, `funded` for each wallet.
    - Logs describing per-wallet funding and remaining unfunded count.

- **Tuning tips**
    - Increase `TARGET_WALLET_COUNT` if you need more parallel senders; this will also spread the available balance thinner.
    - Raise `PER_TX_DELAY_MS` if you hit rate limits; lower it if your RPC is tolerant and you want faster runs.
    - Adjust `GAS_BUFFER_WEI` to control how aggressively the script spends the funder’s balance.

---

#### `scripts/register-actors-from-faucet.ts`

Registers funded faucet wallets as `Producer` actors in `ActorRegistry`.

- **Purpose**
    - Ensure all funded test wallets are recognized as active actors so they can call `CidRollup`, `DocumentRegistry`, etc.

- **Invocation**

  ```bash
  npx tsx scripts/register-actors-from-faucet.ts
  ```

- **Inputs**
    - **Env vars**
        - `OP_SEPOLIA_RPC_URL`
        - `OP_SEPOLIA_PRIVATE_KEY` – must correspond to `ActorRegistry.owner()`.
        - `ACTOR_REGISTRY_ADDRESS` *(optional)* – defaults to the deployed OP Sepolia address.
        - `REGISTER_MIN_BALANCE_ETH` *(optional)* – minimum balance to consider a wallet “funded” (default `0.0000001`).
        - `REGISTER_BALANCE_CONCURRENCY` *(optional)* – concurrency for balance checks (capped at `1`).
        - `REGISTER_REGISTER_CONCURRENCY` *(optional)* – concurrency for registrations (capped at `1`).
    - **Files**
        - `op-sepolia-faucet-wallets-batch.json` – produced by the faucet script.

- **Outputs**
    - For each qualifying wallet, a `registerActor` transaction as `Role.Producer`.
    - Summary of how many wallets had funds, how many were newly registered, and how many failed.

- **Tuning tips**
    - If you only care about a subset of wallets, reduce `TARGET_WALLET_COUNT` or edit the faucet file.
    - Keep the concurrency settings at `1` if your RPC is fragile; increase slightly only if you understand the rate limits.
    - `REGISTER_MIN_BALANCE_ETH` can be raised if you want to ignore near-empty wallets.

---

#### `scripts/gen-test-wallet.ts`

Generate a single throwaway test wallet.

- **Purpose**
    - Quickly create a new OP Sepolia test wallet and get a ready-to-paste `.env` line.

- **Invocation**

  ```bash
  npx tsx scripts/gen-test-wallet.ts
  ```

- **Inputs**
    - None.

- **Outputs**
    - Prints:
        - Generated address.
        - Private key.
        - Suggested `.env` line: `OP_SEPOLIA_PRIVATE_KEY=...`.

- **Tuning tips**
    - There are no parameters; use as-is and make sure the printed private key does not end up in version control.

---

### Deployment & Project Tooling

#### `scripts/deploy-op-sepolia.ts`

Deploy the FairTrade infra contracts to OP Sepolia and record the addresses.

- **Purpose**
    - One-shot deployer for `ActorRegistry`, `DocumentRegistry`, `ProcessManager`, `CidRollup`, and `PaymentRouter`.

- **Invocation**

  ```bash
  npx hardhat run scripts/deploy-op-sepolia.ts --network opSepolia
  ```

- **Inputs**
    - **Env vars**
        - `OP_SEPOLIA_RPC_URL`
        - `OP_SEPOLIA_PRIVATE_KEY` – deployer address; becomes `ActorRegistry.owner()` and initial `PaymentRouter` recipient.
    - Uses artifacts from `artifacts/contracts`.

- **Outputs**
    - Deploys any missing contracts and writes/updates `op-sepolia-deployments.json`:

      ```json
      {
        "ActorRegistry": "0x...",
        "DocumentRegistry": "0x...",
        "ProcessManager": "0x...",
        "CidRollup": "0x...",
        "PaymentRouter": "0x..."
      }
      ```

- **Tuning tips**
    - If you redeploy individual contracts, delete their entry from `op-sepolia-deployments.json` to force a fresh deployment.
    - For multi-env setups, you can copy or rename the deployments file per network.

---

#### `scripts/dump-project.ts`

Emit a textual snapshot of the project into `project_snapshot.txt`.

- **Purpose**
    - Produce a self-contained textual dump of key source files (contracts, scripts, tests) for archival or analysis.

- **Invocation**

  ```bash
  npx tsx scripts/dump-project.ts
  ```

- **Inputs**
    - Uses in-script constants:
        - `FOLDERS = ["contracts", "scripts", "src", "test"]`.
        - `ALLOWED_EXTENSIONS = [".sol", ".ts", ".js"]`.

- **Outputs**
    - `project_snapshot.txt` at the repository root, with each file delimited by `>>> BEGIN FILE` / `<<< END FILE`.

- **Tuning tips**
    - Add/remove entries in `FOLDERS` or `ALLOWED_EXTENSIONS` if you want a different snapshot scope.
    - The script ignores `.d.ts` files by design.

---

### Minimal Example

#### `scripts/send-op-tx.ts`

Minimal Hardhat 3 example for sending a transaction on an OP-style chain.

- **Purpose**
    - Demonstrate `network.connect({ network: "hardhatOp", chainType: "op" })` usage and a trivial L2 transaction.

- **Invocation**

  ```bash
  npx hardhat run scripts/send-op-tx.ts --network hardhatOp
  ```

- **Inputs**
    - Hardhat 3 config must define a `hardhatOp` network with `chainType: "op"`.

- **Outputs**
    - Sends 1 wei from the default signer to itself.
    - Logs the sender address and tx status.

- **Tuning tips**
    - Useful as a smoke test for OP configuration before running the heavier benchmark scripts.

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

- Total CID-anchor events: **13**
- Average gas per anchor: **≈ 62,841 gas**
- Total gas over the batch: **≈ 816,939 gas**
- At a representative gas price, this corresponds to a per-event and per-batch USD cost in the low sub-cent range.

This provides a concrete data point for the per-batch model used in the accompanying paper, and can be recomputed with different RPCs, gas prices, or contract revisions.

---

## Environment & Prerequisites

- Node.js ≥ 18.x
- npm (or pnpm/yarn)
- Access to OP Sepolia RPC endpoints (public and/or private).
- A funded OP Sepolia account for deployments and benchmarks.

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
