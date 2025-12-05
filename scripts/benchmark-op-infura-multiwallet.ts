// scripts/benchmark-op-infura-multiwallet.ts
//
// RPS benchmark for a single OP Sepolia RPC (OP_SEPOLIA_RPC_URL) using many wallets.
//
// Design:
// - Uses op-sepolia-faucet-wallets.json
// - Filters wallets where funded === true
// - Fetches balance ONCE from the first funded wallet
// - amountPerTx = balance / 100_000_000n
// - Fetches chainId, blockNumber, feeData ONCE
// - For each funded wallet:
//     * get nonce once
//     * build tx with shared chainId + gas params
//     * sign locally
//     * provider.broadcastTransaction(raw) WITHOUT awaiting in-loop
// - After loop, await Promise.allSettled on all send promises
// - Prints summary RPS numbers
//
// Usage:
//   npx tsx scripts/benchmark-op-infura-multiwallet.ts
//
// Env required:
//   OP_SEPOLIA_RPC_URL=https://optimism-sepolia.infura.io/v3/....

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { JsonRpcProvider, Wallet, ethers } from "ethers";

const FAUCET_STATE_FILE = path.join(process.cwd(), "op-sepolia-faucet-wallets.json");
const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

interface FaucetWallet {
    address: string;
    privateKey: string;
    funded: boolean;
}

interface FaucetState {
    wallets: FaucetWallet[];
}

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

// Small retry helper for transient RPC issues, but without noisy error dumps
async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    maxAttempts = 5,
): Promise<T> {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            const msg: string | undefined = err?.error?.message ?? err?.message;
            const code = err?.error?.code ?? err?.code;

            const retryable =
                code === -32016 || // too many requests / capacity
                code === -32011 || // "no backend is currently healthy"
                (typeof msg === "string" &&
                    (msg.toLowerCase().includes("too many requests") ||
                        msg.toLowerCase().includes("exceeded its requests per second capacity") ||
                        msg.toLowerCase().includes("no backend is currently healthy")));

            if (!retryable || attempt >= maxAttempts) {
                // Just rethrow; caller will count as failure
                throw err;
            }

            const delayMs = Math.min(10_000, 1000 * 2 ** attempt);
            console.log(
                `   ⚠️  RPC issue during "${label}" (attempt ${attempt + 1}/${maxAttempts}), sleeping ${delayMs} ms...`,
            );
            await sleep(delayMs);
            attempt++;
        }
    }
}

async function main() {
    const rpcUrl = process.env.OP_SEPOLIA_RPC_URL;
    if (!rpcUrl) {
        throw new Error("OP_SEPOLIA_RPC_URL is not set in .env");
    }

    console.log("Using RPC:", rpcUrl);

    // Load faucet wallets
    const state = await loadFaucetState();
    const allWallets = state.wallets ?? [];
    const fundedWallets = allWallets.filter((w) => w.funded);

    if (fundedWallets.length === 0) {
        console.log("❌ No funded wallets found in op-sepolia-faucet-wallets.json");
        return;
    }

    console.log(`Total wallets in state: ${allWallets.length}`);
    console.log(`Funded wallets:         ${fundedWallets.length}`);

    const provider = new JsonRpcProvider(rpcUrl);

    // ---- Fetch shared chain meta ONCE ----
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    const blockNumber = await provider.getBlockNumber();

    const feeData = await provider.getFeeData();
    const maxFeePerGas =
        feeData.maxFeePerGas ??
        feeData.gasPrice ??
        ethers.parseUnits("0.0000001", "gwei"); // tiny fallback

    const maxPriorityFeePerGas =
        feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.001", "gwei");

    const gasLimit = 21_000n; // simple transfer

    console.log(`chainId:       ${chainId}`);
    console.log(`blockNumber:   ${blockNumber}`);
    console.log(`maxFeePerGas:  ${maxFeePerGas.toString()}`);
    console.log(`maxPrioFee:    ${maxPriorityFeePerGas.toString()}`);
    console.log("");

    // ---- Fetch sample balance ONCE from first funded wallet ----
    const sampleWallet = new Wallet(fundedWallets[0].privateKey);
    const sampleAddress = await sampleWallet.getAddress();

    const balance = await withRetry(
        () => provider.getBalance(sampleAddress),
        "getBalance(sample)",
    );

    console.log(`Sample funded wallet: ${sampleAddress}`);
    console.log(`Sample balance (wei): ${balance.toString()}`);

    const amountPerTx = balance / 100_000_000n; // 1/100000000
    if (amountPerTx <= 0n) {
        console.log("❌ Computed amountPerTx is 0, aborting.");
        return;
    }

    console.log(`Amount per tx (wei):   ${amountPerTx.toString()}`);
    console.log("");

    // ---- Fire txs: one per funded wallet, all in same Node thread ----
    const startMs = Date.now();
    const sendPromises: Promise<any>[] = [];

    fundedWallets.forEach((fw, idx) => {
        const wallet = new Wallet(fw.privateKey);

        const p = (async () => {
            try {
                const address = await wallet.getAddress();
                // nonce per wallet — must still be fetched individually, but only once
                const nonce = await provider.getTransactionCount(address, "latest");

                const tx: ethers.TransactionRequest = {
                    to: NULL_ADDRESS,
                    from: address,
                    chainId,
                    nonce,
                    type: 2,
                    gasLimit,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                    value: amountPerTx,
                };

                const signed = await wallet.signTransaction(tx);

                // broadcast raw tx via provider (ethers v6)
                await withRetry(
                    () => provider.broadcastTransaction(signed),
                    "broadcastTransaction",
                );

                return true;
            } catch {
                return false;
            }
        })();

        sendPromises.push(p);

        // Light progress log
        if ((idx + 1) % 100 === 0 || idx === fundedWallets.length - 1) {
            console.log(`... queued tx for ${idx + 1}/${fundedWallets.length} wallets`);
        }
    });

    console.log("\nAll txs queued; waiting for send results...");

    const settled = await Promise.allSettled(sendPromises);
    const successes = settled.filter((r) => r.status === "fulfilled" && r.value === true).length;
    const failures = settled.length - successes;

    const endMs = Date.now();
    const elapsedSec = (endMs - startMs) / 1000;
    const rps = elapsedSec > 0 ? successes / elapsedSec : 0;

    console.log("\n--- Infura RPC RPS Summary (multi-wallet, same-thread) ---");
    console.log(`RPC URL:               ${rpcUrl}`);
    console.log(`Wallets attempted:     ${fundedWallets.length}`);
    console.log(`Successful tx sends:   ${successes}`);
    console.log(`Failed tx sends:       ${failures}`);
    console.log(`Elapsed time (sec):    ${elapsedSec.toFixed(2)}`);
    console.log(`Approx successful RPS: ${rps.toFixed(2)}`);
}

main().catch((err) => {
    console.error("Fatal error in benchmark script:", err);
    process.exit(1);
});
