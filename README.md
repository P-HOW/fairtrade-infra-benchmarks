# Sample Hardhat 3 Beta Project (`mocha` and `ethers`)

This project showcases a Hardhat 3 Beta project using `mocha` for tests and the `ethers` library for Ethereum interactions.

To learn more about the Hardhat 3 Beta, please visit the [Getting Started guide](https://hardhat.org/docs/getting-started#getting-started-with-hardhat-3). To share your feedback, join our [Hardhat 3 Beta](https://hardhat.org/hardhat3-beta-telegram-group) Telegram group or [open an issue](https://github.com/NomicFoundation/hardhat/issues/new) in our GitHub issue tracker.

## Project Overview

This example project includes:

- A simple Hardhat configuration file.
- Foundry-compatible Solidity unit tests.
- TypeScript integration tests using `mocha` and ethers.js
- Examples demonstrating how to connect to different types of networks, including locally simulating OP mainnet.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

You can also selectively run the Solidity or `mocha` tests:

```shell
npx hardhat test solidity
npx hardhat test mocha
```

### Make a deployment to Sepolia

This project includes an example Ignition module to deploy the contract. You can deploy this module to a locally simulated chain or to Sepolia.

To run the deployment to a local chain:

```shell
npx hardhat ignition deploy ignition/modules/Counter.ts
```

To run the deployment to Sepolia, you need an account with funds to send the transaction. The provided Hardhat configuration includes a Configuration Variable called `SEPOLIA_PRIVATE_KEY`, which you can use to set the private key of the account you want to use.

You can set the `SEPOLIA_PRIVATE_KEY` variable using the `hardhat-keystore` plugin or by setting it as an environment variable.

To set the `SEPOLIA_PRIVATE_KEY` config variable using `hardhat-keystore`:

```shell
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```

After setting the variable, you can run the deployment with the Sepolia network:

```shell
npx hardhat ignition deploy --network sepolia ignition/modules/Counter.ts
```

# Fairtrade Infra Benchmarks – Wallet Setup

This section explains how to generate and configure a **test-only** wallet
for running benchmarks against Optimism Sepolia (and other testnets).
Never use a real / mainnet wallet here.

---

## 1. Using the built-in generator script (recommended)

1. Run the wallet generator from the project root:

   ```bash
   npm run gen:test-wallet
   # or
   npx tsx scripts/gen-test-wallet.ts
   ```

2. The script will print something like:

   ```text
   === New test wallet generated ===

   Address:
     0x1234...

   Private key (keep this secret, even for testnets):
     0xabc...

   Add this line to your .env file:

   OP_SEPOLIA_PRIVATE_KEY=0xabc...
   ```

3. Create or edit your `.env` file and paste the suggested line:

   ```env
   OP_SEPOLIA_PRIVATE_KEY=0xabc...   # from the generator
   ```

4. Fund the printed **address** (not the private key) with test ETH on
   Optimism Sepolia from a faucet.

---

## 2. Using an external wallet (e.g. MetaMask)

1. In MetaMask (or a similar wallet), create a new **throwaway** account.
2. Export that account’s private key.
3. Add it to your `.env` file:

   ```env
   OP_SEPOLIA_PRIVATE_KEY=0x<exported_private_key>
   ```

4. Fund that address with test ETH on the appropriate testnet.

---

## 3. Security Notes

- `.env` is already in `.gitignore`, but double-check before committing.
- Treat every private key as sensitive, even on testnets.
- Do **not** reuse these accounts on mainnet or with real funds.

### Deployed Contracts – Optimism Sepolia

| Contract         | Address                                      | Notes              |
|------------------|----------------------------------------------|--------------------|
| ActorRegistry    | `0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1` | Actor/role registry |
| DocumentRegistry | `0xBEb8140eeaf2f23916dA88F8F0886827a0f5145c` | IPFS doc anchors    |
| ProcessManager   | `0xeD7AA6c4B1fA3FFCEC378dcFEAc0406540F5078c` | Batch state machine |
| CidRollup        | `0xC6d171F707bA43BdF490362a357D975B76976264` | CID batch events    |
| PaymentRouter    | `0x87d6582186520Ca818F0E4e3acc0826e7bAeaCfe` | Fee distribution    |

OP Sepolia faucet distribution utility
======================================

Script
------
- scripts/distribute-op-faucet.ts

Prerequisites
-------------
- .env must define:
   - OP_SEPOLIA_RPC_URL – Optimism Sepolia RPC endpoint
   - OP_SEPOLIA_PRIVATE_KEY – private key of the funder wallet (with OP Sepolia ETH)

Usage
-----
Run from the project root:

npx hardhat run scripts/distribute-op-faucet.ts --network opSepolia

What it does
------------
- On the first run:
   - Generates TARGET_WALLET_COUNT test wallets.
   - Saves them to op-sepolia-faucet-wallets.json.
- On every run:
   - Reads the funder balance from the network.
   - Keeps a safety gas buffer (GAS_BUFFER_WEI).
   - Divides the remaining balance evenly across wallets with funded === false.
   - Sends funds and marks those wallets as funded in op-sepolia-faucet-wallets.json.

Tunable parameters
------------------
You can change these constants at the top of scripts/distribute-op-faucet.ts:

- TARGET_WALLET_COUNT – how many wallets to generate and fund in total.
- GAS_BUFFER_WEI – minimum ETH (in wei) to keep on the funder wallet as a safety buffer.
- PER_TX_DELAY_MS – delay (in milliseconds) between transactions to avoid RPC rate limits.

## FairTrade Batch Operation Walkthrough

Script: `scripts/run-fairtrade-batch-ops.ts`  
Network: Optimism Sepolia  
RPC: `https://opt-sepolia.g.alchemy.com/v2/wehjZRRb7NBxavvr5DW5c`

Contracts used:
- `ActorRegistry`: `0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1`
- `CidRollup`: `0xC6d171F707bA43BdF490362a357D975B76976264`

Sender (and registered actor):  
`0xde701e967ea625451819f95bC461e9Fcf8c507df`

Batch tag for this run: `1765113054419`

The script walks a single **traceable coffee batch** through the six FairTrade step types, anchoring one CID-event per on-chain transaction and waiting for confirmation after each tx. This directly realises the per-batch model used in the paper (∑ₛ nₛ = 13 CID anchors).

---

### Per-step summary

| StepType   | Enum value | nₛ (ops per batch) | # tx sent | Block range        | Avg gas / tx | Gas range    |
|-----------:|-----------:|--------------------:|---------:|--------------------|-------------:|-------------:|
| Produced   | 1          | 1                  | 1        | 36,655,258         | 62,847       | 62,847       |
| Processed  | 2          | 2                  | 2        | 36,655,261–36,655,263 | 62,841    | 62,835–62,847 |
| Shipped    | 3          | 4                  | 4        | 36,655,263–36,655,266 | 62,838    | 62,823–62,847 |
| Received   | 4          | 4                  | 4        | 36,655,269–36,655,274 | 62,844    | 62,835–62,847 |
| AtRetail   | 5          | 1                  | 1        | 36,655,276         | 62,847       | 62,847       |
| Sold       | 6          | 1                  | 1        | 36,655,276         | 62,847       | 62,847       |

All transactions were confirmed successfully, with gas usage tightly concentrated around **≈ 6.28 × 10⁴ gas** per CID-anchor event.

---

### Global metrics for the batch

| Metric                                  | Value      |
|----------------------------------------|-----------:|
| Total CID-anchor operations ∑ₛ nₛ      | **13**     |
| Total gas over all operations          | **816,951** |
| Average gas per CID anchor             | **62,842** |

This single-batch walkthrough provides a concrete, chain-level realisation of the theoretical model used in Section 4.8: a realistic FairTrade coffee batch generates 13 CID-anchor events across the six lifecycle steps, each costing ~6.3×10⁴ gas on Optimism Sepolia under the current contract design.
