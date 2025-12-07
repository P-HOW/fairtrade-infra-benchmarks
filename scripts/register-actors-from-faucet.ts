// scripts/register-actors-from-faucet.ts
//
// Register all funded faucet wallets as active actors in ActorRegistry.
//
// - Reads op-sepolia-faucet-wallets-batch.json
// - For each wallet:
//     * Check on-chain balance (sequential / max 1 RPC in-flight)
//     * If balance >= MIN_BALANCE_ETH and NOT already an active actor,
//       call ActorRegistry.registerActor(...) from the owner key.
// - Uses NonceManager so multiple register txs *could* be in-flight,
//   but we cap RPC concurrency to 1 to avoid overloading providers.
//
// Usage:
//   npx tsx scripts/register-actors-from-faucet.ts
//
// Required .env:
//   OP_SEPOLIA_RPC_URL=...
//   OP_SEPOLIA_PRIVATE_KEY=...   # MUST be ActorRegistry.owner()
//
// Optional .env (values are *upper bounds*, but hard-capped at 1):
//   REGISTER_MIN_BALANCE_ETH=0.0000001
//   REGISTER_BALANCE_CONCURRENCY=1
//   REGISTER_REGISTER_CONCURRENCY=1

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import {
    JsonRpcProvider,
    Wallet,
    ethers,
    NonceManager,
} from "ethers";

import actorRegistryArtifact from "../artifacts/contracts/ActorRegistry.sol/ActorRegistry.json";

const FAUCET_STATE_FILE = path.join(
    process.cwd(),
    "op-sepolia-faucet-wallets-batch.json",
);

// Deployed ActorRegistry on OP Sepolia
const ACTOR_REGISTRY_ADDRESS =
    process.env.ACTOR_REGISTRY_ADDRESS ??
    "0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1";

// Role = Producer (1) from FairtradeTypes.Role
const ROLE_PRODUCER = 1;

// Threshold for "has funds"
const MIN_BALANCE_ETH = process.env.REGISTER_MIN_BALANCE_ETH ?? "0.0000001";
const MIN_BALANCE_WEI = ethers.parseEther(MIN_BALANCE_ETH);

// ---- GLOBAL RPC CONCURRENCY CAP ----
const MAX_RPC_CONCURRENCY = 1;

// Concurrency settings (clamped to MAX_RPC_CONCURRENCY)
const BALANCE_CONCURRENCY = Math.min(
    Number(process.env.REGISTER_BALANCE_CONCURRENCY ?? "1"),
    MAX_RPC_CONCURRENCY,
);
const REGISTER_CONCURRENCY = Math.min(
    Number(process.env.REGISTER_REGISTER_CONCURRENCY ?? "1"),
    MAX_RPC_CONCURRENCY,
);

interface FaucetWallet {
    address: string;
    privateKey: string;
    funded?: boolean;
}
interface FaucetState {
    wallets: FaucetWallet[];
}

// ---------- helpers ----------

async function loadFaucetState(): Promise<FaucetState> {
    const raw = await fs.readFile(FAUCET_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
        return { wallets: parsed as FaucetWallet[] };
    }
    return parsed as FaucetState;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let idx = 0;
    const total = items.length;

    async function loop() {
        while (true) {
            const i = idx++;
            if (i >= total) break;
            await worker(items[i], i);
        }
    }

    const n = Math.min(limit, total);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < n; i++) promises.push(loop());
    await Promise.all(promises);
}

function toBytes32(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
}

// ---------- main ----------

async function main() {
    const rpcUrl = process.env.OP_SEPOLIA_RPC_URL;
    const pk = process.env.OP_SEPOLIA_PRIVATE_KEY;

    if (!rpcUrl || !pk) {
        throw new Error(
            "Missing OP_SEPOLIA_RPC_URL or OP_SEPOLIA_PRIVATE_KEY in .env",
        );
    }

    console.log("RPC URL:", rpcUrl);
    console.log("ActorRegistry:", ACTOR_REGISTRY_ADDRESS);
    console.log("MIN_BALANCE_ETH:", MIN_BALANCE_ETH);
    console.log("BALANCE_CONCURRENCY:", BALANCE_CONCURRENCY);
    console.log("REGISTER_CONCURRENCY:", REGISTER_CONCURRENCY);
    console.log("");

    const provider = new JsonRpcProvider(rpcUrl);
    const ownerWallet = new Wallet(pk, provider);
    const ownerAddr = await ownerWallet.getAddress();
    console.log("Owner (caller) address:", ownerAddr);

    const actorRegistry = new ethers.Contract(
        ACTOR_REGISTRY_ADDRESS,
        (actorRegistryArtifact as any).abi,
        ownerWallet,
    );

    // Ensure caller is actually the owner
    const onChainOwner: string = await actorRegistry.owner();
    if (onChainOwner.toLowerCase() !== ownerAddr.toLowerCase()) {
        throw new Error(
            `OP_SEPOLIA_PRIVATE_KEY is not ActorRegistry.owner(). ` +
            `owner on-chain=${onChainOwner}`,
        );
    }
    console.log("✅ Caller is ActorRegistry.owner()");
    console.log("");

    // Load wallets
    const state = await loadFaucetState();
    const wallets = state.wallets ?? [];
    console.log(`Loaded ${wallets.length} wallets from JSON.\n`);

    // Step 1: check balances (sequential, max 1 RPC)
    console.log(
        `Step 1: Checking balances (>= ${MIN_BALANCE_ETH} ETH) with concurrency=${BALANCE_CONCURRENCY} ...`,
    );

    const walletsWithBalance: { wallet: FaucetWallet; balance: bigint }[] = [];

    await runWithConcurrency(
        wallets,
        BALANCE_CONCURRENCY,
        async (w, idx) => {
            try {
                const bal = await provider.getBalance(w.address);
                if (bal >= MIN_BALANCE_WEI) {
                    walletsWithBalance.push({ wallet: w, balance: bal });
                }
                if ((idx + 1) % 200 === 0 || idx === wallets.length - 1) {
                    console.log(
                        `  ...checked ${idx + 1}/${wallets.length}, ` +
                        `${walletsWithBalance.length} have balance`,
                    );
                }
            } catch (err) {
                console.warn(
                    `  ⚠️  Failed to getBalance for ${w.address}: ${
                        (err as any)?.message ?? err
                    }`,
                );
                // back off a bit on error
                await sleep(1000);
            }
        },
    );

    console.log(
        `\nWallets with >= ${MIN_BALANCE_ETH} ETH: ${walletsWithBalance.length}\n`,
    );

    if (walletsWithBalance.length === 0) {
        console.log("Nothing to register, exiting.");
        return;
    }

    // Step 2: filter out already-active actors
    console.log(
        "Step 2: Checking ActorRegistry status for wallets with balance...",
    );

    const toRegister: { wallet: FaucetWallet; balance: bigint }[] = [];

    await runWithConcurrency(
        walletsWithBalance,
        BALANCE_CONCURRENCY,
        async (entry, idx) => {
            const addr = entry.wallet.address;
            try {
                const [orgIdHash, , status] = (await actorRegistry.getActor(
                    addr,
                )) as [string, bigint, bigint, string];

                const hasOrg = orgIdHash !== ethers.ZeroHash;
                const isActive = Number(status) === 1; // FairtradeTypes.Status.Active

                if (!hasOrg || !isActive) {
                    toRegister.push(entry);
                }

                if ((idx + 1) % 100 === 0 || idx === walletsWithBalance.length - 1) {
                    console.log(
                        `  ...queried ${idx + 1}/${walletsWithBalance.length}, ` +
                        `${toRegister.length} need registration`,
                    );
                }
            } catch (err) {
                console.warn(
                    `  ⚠️  getActor failed for ${addr}: ${
                        (err as any)?.message ?? err
                    } (will try to register)`,
                );
                await sleep(1000);
                toRegister.push(entry);
            }
        },
    );

    console.log(
        `\nWallets needing registration (have funds & not active): ${toRegister.length}\n`,
    );

    if (toRegister.length === 0) {
        console.log("All funded wallets are already active actors. Done.");
        return;
    }

    // Step 3: register (sequential, max 1 RPC; nonce-safe via NonceManager)
    console.log(
        `Step 3: Registering wallets with concurrency=${REGISTER_CONCURRENCY} ...`,
    );

    const nonceManager = new NonceManager(ownerWallet);
    const actorRegistryOwned = actorRegistry.connect(
        nonceManager as any,
    ) as ethers.Contract;

    let success = 0;
    let failure = 0;

    await runWithConcurrency(
        toRegister,
        REGISTER_CONCURRENCY,
        async (entry, idx) => {
            const addr = entry.wallet.address;
            const orgIdHash = toBytes32(`faucet-org-${addr.toLowerCase()}`);
            const metadataHash = toBytes32(`faucet-meta-${addr.toLowerCase()}`);

            try {
                const tx = await actorRegistryOwned.registerActor(
                    orgIdHash,
                    addr,
                    ROLE_PRODUCER,
                    metadataHash,
                );
                console.log(
                    `  → registerActor(${addr}) sent, tx=${tx.hash}, idx=${idx}`,
                );
                const receipt = await tx.wait();
                console.log(
                    `    ✓ confirmed for ${addr} in block ${receipt?.blockNumber?.toString()}`,
                );
                success++;
            } catch (err) {
                failure++;
                console.warn(
                    `    ✗ registerActor FAILED for ${addr}: ${
                        (err as any)?.shortMessage ??
                        (err as any)?.reason ??
                        (err as any)?.message ??
                        err
                    }`,
                );
                await sleep(1000);
            }
        },
    );

    console.log("\n=== Registration summary ===");
    console.log(`Total wallets in JSON:          ${wallets.length}`);
    console.log(
        `Wallets with balance >= ${MIN_BALANCE_ETH}: ${walletsWithBalance.length}`,
    );
    console.log(`Attempted registrations:        ${toRegister.length}`);
    console.log(`Successful registrations:       ${success}`);
    console.log(`Failed registrations:           ${failure}`);
}

main().catch((err) => {
    console.error("Fatal error in register-actors-from-faucet:", err);
    process.exit(1);
});
