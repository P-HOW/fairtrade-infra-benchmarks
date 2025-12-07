// scripts/cid-anchor-multiwallet-30s.ts
//
// Send as many 400-CID anchor batches as possible in ~30 seconds,
// using many pre-generated wallets and multiple private RPC providers.
//
// - Wallets are loaded from op-sepolia-faucet-wallets-batch.json
//   (same format as previous faucet scripts: { address, privateKey, funded }).
// - Only wallets with funded === true are used.
// - Each wallet sends AT MOST ONE submitCidBatch(...) tx.
// - Each tx anchors BATCH_SIZE synthetic CIDs (default 400).
// - RPC endpoints are read from OP_SEPOLIA_PRIVATE_RPCS_JSON (JSON array).
// - For each RPC, we spawn WORKERS_PER_RPC async workers (default 10).
// - Workers:
//     * take the next funded wallet
//     * build a unique CID batch (using a RUN_ID prefix)
//     * send cidRollup.submitCidBatch(events)
//     * DO NOT await .wait() – just log the tx hash and move on.
// - The sending loop stops after DURATION_MS (default 30_000 ms)
//   or when we run out of funded wallets.
//
// Usage:
//   npx tsx scripts/cid-anchor-multiwallet-30s.ts
//
// Env:
//   OP_SEPOLIA_PRIVATE_RPCS_JSON=[ "...", "..." ]
//   BATCH_SIZE (optional, default 400)
//   DURATION_MS (optional, default 30000)
//   WORKERS_PER_RPC (optional, default 10)
//   CID_RUN_ID (optional, default Date.now())
//   FAUCET_STATE_FILE (optional, default ./op-sepolia-faucet-wallets-batch.json)

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { JsonRpcProvider, Wallet, ethers } from "ethers";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const CID_ROLLUP_ADDRESS = "0xC6d171F707bA43BdF490362a357D975B76976264";

// Artifacts – relies on tsconfig: "resolveJsonModule": true
import cidRollupArtifact from "../artifacts/contracts/CidRollup.sol/CidRollup.json";

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "200");
const DURATION_MS = Number(process.env.DURATION_MS ?? "30000");
const WORKERS_PER_RPC = Number(process.env.WORKERS_PER_RPC ?? "3");
const RUN_ID_BASE = process.env.CID_RUN_ID ?? `${Date.now()}`;

const FAUCET_STATE_FILE =
    process.env.FAUCET_STATE_FILE ??
    path.join(process.cwd(), "op-sepolia-faucet-wallets-batch.json");

// -----------------------------------------------------------------------------
// Types & helpers
// -----------------------------------------------------------------------------

interface FaucetWallet {
    address: string;
    privateKey: string;
    funded: boolean;
}

interface FaucetState {
    wallets: FaucetWallet[];
}

type CidEvent = {
    productId: string;
    stepId: string;
    cidHash: string;
    stepType: number;
};

function toBytes32(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
}

// NEW: simple sleep helper
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadFaucetState(): Promise<FaucetWallet[]> {
    const raw = await fs.readFile(FAUCET_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const wallets = (Array.isArray(parsed)
        ? (parsed as FaucetWallet[])
        : (parsed as FaucetState).wallets) as FaucetWallet[];

    return wallets ?? [];
}

function parsePrivateRpcs(): string[] {
    const raw = process.env.OP_SEPOLIA_PRIVATE_RPCS_JSON;
    if (!raw) {
        throw new Error("OP_SEPOLIA_PRIVATE_RPCS_JSON is not set in .env");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(
            `Failed to parse OP_SEPOLIA_PRIVATE_RPCS_JSON: ${(e as Error).message}`,
        );
    }
    if (!Array.isArray(parsed)) {
        throw new Error("OP_SEPOLIA_PRIVATE_RPCS_JSON must be a JSON array");
    }

    const urls = (parsed as unknown[])
        .filter((u) => typeof u === "string")
        .map((u) => u as string)
        .filter((u) => u.startsWith("http"));

    if (urls.length === 0) {
        throw new Error("OP_SEPOLIA_PRIVATE_RPCS_JSON has no HTTP URLs");
    }
    return urls;
}

// Build a batch of synthetic CidEvent entries for this run+wallet
function buildCidEvents(runTag: string, batchSize: number): CidEvent[] {
    const events: CidEvent[] = [];

    for (let i = 0; i < batchSize; i++) {
        const productIndex = Math.floor(i / 10); // 10 steps per product, arbitrary

        const productId = toBytes32(
            `run-${runTag}-product-${productIndex}`,
        );
        const stepId = toBytes32(`run-${runTag}-step-${i}`);
        const cidHash = toBytes32(`run-${runTag}-cid-${i}`);

        // StepType enum (1..6): Produced, Processed, Shipped, Received, AtRetail, Sold
        const stepType = ((i % 6) + 1) as number;

        events.push({
            productId,
            stepId,
            cidHash,
            stepType,
        });
    }

    return events;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
    const rpcUrls = parsePrivateRpcs();
    console.log("Using private RPCs:");
    rpcUrls.forEach((u, i) => console.log(`  [${i}] ${u}`));
    console.log("");

    const allWallets = await loadFaucetState();
    const fundedWallets = allWallets.filter((w) => w.funded);

    if (fundedWallets.length === 0) {
        console.log("❌ No funded wallets found in faucet state file.");
        return;
    }

    console.log(`Total wallets in state:  ${allWallets.length}`);
    console.log(`Funded wallets:          ${fundedWallets.length}`);
    console.log(`Batch size (CIDs/tx):    ${BATCH_SIZE}`);
    console.log(`Duration limit (ms):     ${DURATION_MS}`);
    console.log(`Workers per RPC:         ${WORKERS_PER_RPC}`);
    console.log(`RUN_ID_BASE:             ${RUN_ID_BASE}`);
    console.log("");

    // One provider per RPC
    const providers = rpcUrls.map((u) => new JsonRpcProvider(u));

    // Shared wallet index across all workers
    let nextWalletIndex = 0;
    const totalWallets = fundedWallets.length;

    const startMs = Date.now();
    const deadlineMs = startMs + DURATION_MS;

    // Stats
    let sentCount = 0;
    let failedCount = 0;

    // Worker logic for a single RPC
    async function worker(rpcIdx: number, workerId: number) {
        const provider = providers[rpcIdx];

        while (true) {
            const now = Date.now();
            if (now >= deadlineMs) {
                return;
            }

            const myIndex = nextWalletIndex++;
            if (myIndex >= totalWallets) {
                return;
            }

            const fw = fundedWallets[myIndex];
            const wallet = new Wallet(fw.privateKey, provider);

            const runTag = `${RUN_ID_BASE}-rpc${rpcIdx}-w${workerId}-widx${myIndex}`;
            const events = buildCidEvents(runTag, BATCH_SIZE);

            try {
                const cidRollup = new ethers.Contract(
                    CID_ROLLUP_ADDRESS,
                    (cidRollupArtifact as any).abi,
                    wallet,
                );

                const t0 = Date.now();
                const tx = await cidRollup.submitCidBatch(events);

                const sendMs = Date.now() - t0;
                sentCount++;

                console.log(
                    `[RPC ${rpcIdx} W${workerId}] wallet=${fw.address} ` +
                    `batch=${BATCH_SIZE} txHash=${tx.hash} sendMs=${sendMs}`,
                );
                // DO NOT await tx.wait(); just loop on to next wallet (if time left).
            } catch (err: any) {
                failedCount++;
                const msg =
                    err?.shortMessage ??
                    err?.reason ??
                    err?.error?.message ??
                    err?.message ??
                    String(err);
                console.log(
                    `[RPC ${rpcIdx} W${workerId}] ❌ FAILED wallet=${fw.address} ` +
                    `batch=${BATCH_SIZE} reason=${msg}`,
                );
            }

            // NEW: wait 50ms before going for the next one
            await sleep(100);
        }
    }

    // Launch workers: WORKERS_PER_RPC for each RPC
    const workerPromises: Promise<void>[] = [];
    rpcUrls.forEach((_u, rpcIdx) => {
        for (let w = 0; w < WORKERS_PER_RPC; w++) {
            workerPromises.push(worker(rpcIdx, w));
        }
    });

    await Promise.all(workerPromises);

    const totalMs = Date.now() - startMs;

    console.log("\n=== CID multiwallet flood summary ===");
    console.log(`Total funded wallets:     ${fundedWallets.length}`);
    console.log(`Total tx attempts:        ${sentCount + failedCount}`);
    console.log(`Successful tx sends:      ${sentCount}`);
    console.log(`Failed sends:             ${failedCount}`);
    console.log(`Elapsed time (ms):        ${totalMs}`);
    console.log(
        `Approx tx/s (send only):  ${
            totalMs > 0 ? ((sentCount * 1000) / totalMs).toFixed(2) : "0.00"
        }`,
    );
}

main().catch((err) => {
    console.error("Fatal error in cid-anchor-multiwallet-30s:", err);
    process.exit(1);
});
