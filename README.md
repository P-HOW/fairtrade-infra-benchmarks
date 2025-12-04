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
