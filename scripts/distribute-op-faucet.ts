// scripts/distribute-op-faucet.ts
// Distribute OP Sepolia ETH evenly to 3000 wallets.
// - Wallets are generated once and stored in op-sepolia-faucet-wallets.json
// - Each run:
//   * Reads funder balance from network
//   * Counts remaining (unfunded) wallets
//   * Computes per-wallet amount = (balance - GAS_BUFFER_WEI) / remaining
//   * Funds only wallets with funded === false
//   * Updates JSON incrementally so reruns pick up where they left off
//
// NOTE: To avoid RPC rate-limit errors, we DO NOT call tx.wait() anymore.
//       We only wait for sendTransaction to be accepted by the RPC.
//       This removes eth_getTransactionReceipt polling (which was causing -32016).

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { Wallet, JsonRpcProvider, ethers } from "ethers";

const FAUCET_STATE_FILE = path.join(process.cwd(), "op-sepolia-faucet-wallets.json");
const TARGET_WALLET_COUNT = 3000;

// Safety buffer so we don't accidentally drain the funder completely.
const GAS_BUFFER_WEI = ethers.parseEther("0.05");

// Optional small delay between txs to be nicer to the free RPC
const PER_TX_DELAY_MS = 300; // tweak if still rate-limited

interface FaucetWallet {
    address: string;
    privateKey: string;
    funded: boolean;
}

interface FaucetState {
    wallets: FaucetWallet[];
}

// -----------------------------------------------------------------------------
// Helpers: file IO
// -----------------------------------------------------------------------------

async function loadFaucetState(): Promise<FaucetState | null> {
    try {
        const raw = await fs.readFile(FAUCET_STATE_FILE, "utf8");
        const parsed = JSON.parse(raw);

        // Backward compatible: if old file was just an array
        if (Array.isArray(parsed)) {
            return { wallets: parsed as FaucetWallet[] };
        }

        return parsed as FaucetState;
    } catch {
        return null;
    }
}

async function saveFaucetState(state: FaucetState): Promise<void> {
    const json = JSON.stringify(state, null, 2);
    await fs.writeFile(FAUCET_STATE_FILE, json, "utf8");
}

// -----------------------------------------------------------------------------
// Helpers: rate-limit / gas-error aware RPC wrapper
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: any): boolean {
    const code = err?.error?.code ?? err?.code;
    const msg: string | undefined = err?.error?.message ?? err?.message;

    if (code === -32016) return true;
    if (typeof msg === "string" && msg.includes("exceeded its requests per second capacity")) {
        return true;
    }
    return false;
}

function isReplacementUnderpricedError(err: any): boolean {
    const code = err?.code;
    const msg: string | undefined = err?.error?.message ?? err?.message;

    if (code === "REPLACEMENT_UNDERPRICED") return true;
    if (typeof msg === "string" && msg.toLowerCase().includes("replacement transaction underpriced")) {
        return true;
    }
    return false;
}

async function withRpcRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let attempt = 0;
    const maxAttempts = 20;

    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            if (isRateLimitError(err) && attempt < maxAttempts) {
                const delayMs = Math.min(10_000, 1000 * 2 ** attempt); // 1s,2s,...,max 10s
                console.log(
                    `   ⚠️ RPC rate limit on "${label}", sleeping ${delayMs} ms then retrying (attempt ${
                        attempt + 1
                    }/${maxAttempts})`,
                );
                await sleep(delayMs);
                attempt++;
                continue;
            }
            throw err;
        }
    }
}

// -----------------------------------------------------------------------------
// Wallet generation
// -----------------------------------------------------------------------------

async function ensureWallets(): Promise<FaucetState> {
    const existing = await loadFaucetState();
    if (existing && existing.wallets?.length === TARGET_WALLET_COUNT) {
        console.log(`Loaded existing faucet state with ${existing.wallets.length} wallets`);
        return existing;
    }

    console.log("No valid faucet state found, generating 3000 wallets...");

    const wallets: FaucetWallet[] = [];
    for (let i = 0; i < TARGET_WALLET_COUNT; i++) {
        const w = Wallet.createRandom();
        wallets.push({
            address: w.address,
            privateKey: w.privateKey,
            funded: false,
        });
    }

    const state: FaucetState = { wallets };
    await saveFaucetState(state);

    console.log(`✅ Wallet list written to ${FAUCET_STATE_FILE}`);
    return state;
}

// -----------------------------------------------------------------------------
// Main logic
// -----------------------------------------------------------------------------

async function main() {
    const rpcUrl = process.env.OP_SEPOLIA_RPC_URL;
    const privateKey = process.env.OP_SEPOLIA_PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
        throw new Error("Missing OP_SEPOLIA_RPC_URL or OP_SEPOLIA_PRIVATE_KEY in .env");
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const funder = new Wallet(privateKey, provider);
    const funderAddress = await funder.getAddress();

    console.log("Funder address:", funderAddress);
    console.log("RPC URL:", rpcUrl);

    // Ensure we have 3000 wallets on disk
    const state = await ensureWallets();
    const wallets = state.wallets;
    const totalWallets = wallets.length;

    // Determine which wallets still need funding (and keep their global index)
    const remaining = wallets
        .map((w, index) => ({ wallet: w, index })) // index is 0-based
        .filter((entry) => !entry.wallet.funded);

    const remainingCount = remaining.length;

    if (remainingCount === 0) {
        console.log("🎉 All faucet wallets are already funded. Nothing to do.");
        return;
    }

    // Fetch current funder balance from network with rate-limit aware wrapper
    const currentBalance = await withRpcRetry(
        () => provider.getBalance(funderAddress),
        "getBalance(initial)",
    );
    console.log("Current funder balance (wei):", currentBalance.toString());

    if (currentBalance <= GAS_BUFFER_WEI) {
        console.log(
            `❌ Balance (${currentBalance.toString()}) is below gas buffer (${GAS_BUFFER_WEI.toString()}), aborting.`,
        );
        return;
    }

    const distributable = currentBalance - GAS_BUFFER_WEI;
    const perWalletWei = distributable / BigInt(remainingCount);

    if (perWalletWei <= 0n) {
        console.log(
            `❌ Distributable balance (${distributable.toString()}) is too small for ${remainingCount} wallets. Aborting.`,
        );
        return;
    }

    console.log(`Remaining wallets to fund: ${remainingCount}`);
    console.log(`Per-wallet amount (wei):   ${perWalletWei.toString()}`);
    console.log(
        `Total intended distribution this run (wei): ${perWalletWei * BigInt(remainingCount)}`,
    );
    console.log("");

    // Fund remaining wallets, updating state after each successful tx.
    for (let i = 0; i < remaining.length; i++) {
        const { wallet: w, index: globalIndex } = remaining[i];
        const humanIndex = globalIndex + 1; // 1-based index for logs

        // Re-check funder balance before each transfer (with rate-limit handling)
        const latestBalance = await withRpcRetry(
            () => provider.getBalance(funderAddress),
            "getBalance(per-wallet)",
        );

        if (latestBalance <= perWalletWei + GAS_BUFFER_WEI) {
            console.log(
                `⚠️  Stopping: funder balance (${latestBalance.toString()}) is too low for another ${perWalletWei.toString()} transfer + gas buffer.`,
            );
            break;
        }

        console.log(
            `[#${humanIndex}/${totalWallets}] Sending ${perWalletWei.toString()} wei to ${w.address} ...`,
        );

        try {
            // sendTransaction itself may be rate-limited
            const tx = await withRpcRetry(
                () =>
                    funder.sendTransaction({
                        to: w.address,
                        value: perWalletWei,
                    }),
                "sendTransaction",
            );

            console.log(`   Tx sent: ${tx.hash}`);
            console.log("   ✅ Marking as funded (not waiting for on-chain receipt)");

            // Mark this wallet as funded and persist state
            wallets[globalIndex].funded = true;
            await saveFaucetState({ wallets });

            // little delay between txs to avoid hammering RPC
            if (PER_TX_DELAY_MS > 0) {
                await sleep(PER_TX_DELAY_MS);
            }
        } catch (err: any) {
            if (isReplacementUnderpricedError(err)) {
                console.warn(
                    `   ⚠️ Replacement-underpriced error for ${w.address}. ` +
                    "Likely a duplicate / gas-change issue. Marking as funded and continuing.",
                );
                // Treat as "probably in mempool"; mark funded so we don't get stuck on this address.
                wallets[globalIndex].funded = true;
                await saveFaucetState({ wallets });
                continue;
            }

            console.error(`   ❌ Failed to fund ${w.address}`, err);
            console.log("   Stopping loop due to non-recoverable error.");
            break;
        }
    }

    const stillRemaining = wallets.filter((w) => !w.funded).length;
    console.log("");
    console.log(`Run complete. Remaining unfunded wallets: ${stillRemaining}`);
    console.log(`State stored in: ${FAUCET_STATE_FILE}`);
}

// Just in case some lib promise escapes, log it instead of silent crash
process.on("unhandledRejection", (reason) => {
    console.error("⚠️ Unhandled promise rejection in faucet script:", reason);
});

main().catch((err) => {
    console.error("Unhandled error in faucet script:", err);
    process.exit(1);
});
