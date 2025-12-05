// scripts/benchmark-op-rpcs.ts
//
// Benchmark approximate tx RPS per OP Sepolia RPC endpoint.
// - Reads endpoints from OP_SEPOLIA_RPCS_JSON (JSON array of URLs) in .env
// - Uses OP_SEPOLIA_PRIVATE_KEY as the funder wallet
// - For each HTTP RPC:
//    * Get current balance
//    * amountPerTx = balance / 10_000_000n
//    * Send TX_COUNT_PER_RPC transactions in parallel to the zero address
//    * Uses retry for rate-limit / backend errors
//    * Prints approximate successful tx/s
//
// Usage:
//   npx tsx scripts/benchmark-op-rpcs.ts
//   or
//   npx hardhat run scripts/benchmark-op-rpcs.ts --network opSepolia
//
// Important: This script spends real testnet ETH from OP_SEPOLIA_PRIVATE_KEY.

import "dotenv/config";
import { JsonRpcProvider, Wallet, ethers } from "ethers";

const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

// How many txs per RPC to attempt
const TX_COUNT_PER_RPC = Number(process.env.RPC_BENCH_TX_COUNT ?? "60");

// How many txs in flight per RPC at once
const CONCURRENCY_PER_RPC = Number(process.env.RPC_BENCH_CONCURRENCY ?? "20");

// Safety gas buffer so we don't drain the wallet
const GAS_BUFFER_WEI = ethers.parseEther(
    process.env.RPC_BENCH_GAS_BUFFER_ETH ?? "0.05",
);

// Max retry attempts for transient RPC errors
const MAX_RETRIES = 15;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function parseRpcUrls(): string[] {
    const raw = process.env.OP_SEPOLIA_PUBLIC_RPCS_JSON;
    if (!raw) {
        throw new Error("OP_SEPOLIA_RPCS_JSON is not set in .env");
    }

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            throw new Error("OP_SEPOLIA_RPCS_JSON is not a JSON array");
        }
        // Only keep strings
        return parsed.filter((u) => typeof u === "string") as string[];
    } catch (e) {
        throw new Error(`Failed to parse OP_SEPOLIA_RPCS_JSON: ${(e as Error).message}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: any): boolean {
    const code = err?.error?.code ?? err?.code;
    const msg: string | undefined = err?.error?.message ?? err?.message;

    // OP free endpoint style
    if (code === -32016) return true;
    if (typeof msg === "string" && msg.includes("exceeded its requests per second capacity")) {
        return true;
    }
    // generic HTTP 429-ish from some providers may come through as message
    if (typeof msg === "string" && msg.toLowerCase().includes("too many requests")) {
        return true;
    }

    return false;
}

function isBackendDownError(err: any): boolean {
    const code = err?.error?.code ?? err?.code;
    const msg: string | undefined = err?.error?.message ?? err?.message;

    // "no backend is currently healthy to serve traffic"
    if (code === -32011) return true;
    if (typeof msg === "string" && msg.toLowerCase().includes("no backend is currently healthy")) {
        return true;
    }

    return false;
}

async function withRpcRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            const retryable =
                isRateLimitError(err) ||
                isBackendDownError(err);

            if (retryable && attempt < MAX_RETRIES) {
                const delayMs = Math.min(15_000, 1000 * 2 ** attempt); // 1s, 2s, 4s ... 15s max
                console.log(
                    `   ⚠️  RPC error on "${label}" (attempt ${attempt + 1}/${MAX_RETRIES}),` +
                    ` sleeping ${delayMs} ms then retrying...`,
                );
                await sleep(delayMs);
                attempt++;
                continue;
            }

            // Non-retryable or exceeded attempts — just rethrow (caller decides how noisy)
            throw err;
        }
    }
}

// Run N sendTransaction calls in parallel with bounded concurrency
async function runTxBurst(
    txCount: number,
    concurrency: number,
    sendFn: (txIndex: number) => Promise<void>,
): Promise<{ successes: number; failures: number }> {
    let successes = 0;
    let failures = 0;

    const indices = Array.from({ length: txCount }, (_, i) => i);

    async function worker() {
        while (true) {
            const idx = indices.shift();
            if (idx === undefined) break;

            try {
                await sendFn(idx);
                successes++;
            } catch {
                // We silently count failures; no noisy stack traces
                failures++;
            }
        }
    }

    const workerCount = Math.min(concurrency, txCount);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);
    return { successes, failures };
}

// -----------------------------------------------------------------------------
// Per-RPC test
// -----------------------------------------------------------------------------

async function testRpcEndpoint(url: string, privateKey: string) {
    if (!url.startsWith("http")) {
        console.log(`Skipping non-HTTP endpoint: ${url}`);
        return;
    }

    console.log("\n============================================================");
    console.log(`RPC: ${url}`);
    console.log("============================================================");

    const provider = new JsonRpcProvider(url);
    const wallet = new Wallet(privateKey, provider);
    const address = await wallet.getAddress();

    const balance = await withRpcRetry(
        () => provider.getBalance(address),
        "getBalance",
    );

    console.log("Funder address:", address);
    console.log("Current balance (wei):", balance.toString());

    if (balance <= GAS_BUFFER_WEI) {
        console.log(
            `   ❌ Balance below gas buffer (${GAS_BUFFER_WEI.toString()}) on this RPC. Skipping.`,
        );
        return;
    }

    const distributable = balance - GAS_BUFFER_WEI;
    const amountPerTx = distributable / 10_000_000n; // 1/10,000,000 of balance

    if (amountPerTx <= 0n) {
        console.log("   ❌ Computed amountPerTx is 0. Skipping.");
        return;
    }

    // Ensure we can't accidentally overspend
    const maxAffordable = Number(distributable / amountPerTx);
    const txCount = Math.min(TX_COUNT_PER_RPC, maxAffordable);

    if (txCount <= 0) {
        console.log(
            `   ❌ Not enough balance to send even one tx with amountPerTx=${amountPerTx.toString()}.`,
        );
        return;
    }

    const effectiveConcurrency = Math.min(CONCURRENCY_PER_RPC, txCount);

    console.log(`Planned tx count on this RPC: ${txCount}`);
    console.log(`Concurrency:                  ${effectiveConcurrency}`);
    console.log(`Amount per tx (wei):          ${amountPerTx.toString()}`);
    console.log("");

    const start = Date.now();

    const { successes, failures } = await runTxBurst(
        txCount,
        effectiveConcurrency,
        async () => {
            // We intentionally don't log individual tx hashes or errors here.
            await withRpcRetry(
                () =>
                    wallet.sendTransaction({
                        to: NULL_ADDRESS,
                        value: amountPerTx,
                    }),
                "sendTransaction",
            );
        },
    );

    const end = Date.now();
    const durationSec = (end - start) / 1000;
    const rps = durationSec > 0 ? successes / durationSec : 0;

    console.log("\n--- RPC Result Summary ---");
    console.log(`RPC URL:            ${url}`);
    console.log(`Successful tx:      ${successes}`);
    console.log(`Failed tx:          ${failures}`);
    console.log(`Elapsed time (sec): ${durationSec.toFixed(2)}`);
    console.log(`Approx tx RPS:      ${rps.toFixed(2)}`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
    const privateKey = process.env.OP_SEPOLIA_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("OP_SEPOLIA_PRIVATE_KEY is not set in .env");
    }

    const rpcUrls = parseRpcUrls();
    console.log("Loaded RPC endpoints from OP_SEPOLIA_RPCS_JSON:");
    rpcUrls.forEach((u, i) => console.log(`  [${i}] ${u}`));
    console.log("");

    for (const url of rpcUrls) {
        try {
            await testRpcEndpoint(url, privateKey);
        } catch {
            // Quiet: just show a one-line failure for this RPC
            console.log(`\n❌ Benchmark failed for RPC ${url}`);
        }
    }

    console.log("\nAll RPCs tested (or skipped).");
}

main().catch((err) => {
    console.error("Fatal error in RPC benchmark script:", err);
    process.exit(1);
});
