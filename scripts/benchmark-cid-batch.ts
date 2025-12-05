// scripts/benchmark-cid-batch.ts
//
// Send a single CidRollup.submitCidBatch() with N CidEvent entries.
//
// - Uses OP_SEPOLIA_RPC_URL and OP_SEPOLIA_PRIVATE_KEY from .env
// - Uses the already-deployed contracts on OP Sepolia:
//     * ActorRegistry: 0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1
//     * CidRollup:     0xC6d171F707bA43BdF490362a357D975B76976264
// - Ensures the caller wallet is a registered ACTIVE actor in ActorRegistry
//   (auto-registers as a Producer if not).
// - Builds a batch of N synthetic CidEvent structs (default 500)
// - Each run uses a unique RUN_ID so (productId, stepId) pairs are never reused,
//   avoiding "step already anchored" revert when you re-run the script.
// - Calls submitCidBatch(events) and logs timing in milliseconds.
//
// Usage:
//   npx tsx scripts/benchmark-cid-batch.ts
//   # or
//   npx hardhat run scripts/benchmark-cid-batch.ts --network opSepolia
//
// Optional env:
//   CID_BATCH_SIZE=500
//   CID_RUN_ID=some-string   # if you want deterministic runs; otherwise Date.now() is used

import "dotenv/config";
import { JsonRpcProvider, Wallet, ethers } from "ethers";

// Hard-coded deployed addresses (OP Sepolia)
const ACTOR_REGISTRY_ADDRESS = "0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1";
const CID_ROLLUP_ADDRESS = "0xC6d171F707bA43BdF490362a357D975B76976264";

// Artifacts – relies on tsconfig: "resolveJsonModule": true
import actorRegistryArtifact from "../artifacts/contracts/ActorRegistry.sol/ActorRegistry.json";
import cidRollupArtifact from "../artifacts/contracts/CidRollup.sol/CidRollup.json";

// Batch size (default 500, override via env CID_BATCH_SIZE)
const BATCH_SIZE = Number(process.env.CID_BATCH_SIZE ?? "1023");

// Unique run identifier to avoid replay on (productId, stepId).
// If CID_RUN_ID is not set, we just use current timestamp.
const RUN_ID = process.env.CID_RUN_ID ?? `${Date.now()}`;

// Role value from FairtradeTypes.Role (Producer = 1)
const ROLE_PRODUCER = 1;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function toBytes32(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
}

async function ensureRegisteredActor(
    actorRegistry: ethers.Contract,
    wallet: Wallet,
): Promise<void> {
    const addr = await wallet.getAddress();
    const isActive: boolean = await actorRegistry.isActiveActor(addr);

    if (isActive) {
        console.log(`Actor already active in registry: ${addr}`);
        return;
    }

    console.log(`Actor not registered, registering now as Producer: ${addr}`);

    const orgIdHash = toBytes32("fairtrade-bench-org");
    const metadataHash = toBytes32("fairtrade-bench-metadata");

    const tx = await actorRegistry.registerActor(
        orgIdHash,
        addr,
        ROLE_PRODUCER,
        metadataHash,
    );
    console.log("  registerActor tx hash:", tx.hash);
    const receipt = await tx.wait();
    console.log(
        "  registerActor confirmed in block",
        receipt?.blockNumber?.toString(),
    );
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
    const rpcUrl = process.env.OP_SEPOLIA_RPC_URL;
    const privateKey = process.env.OP_SEPOLIA_PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
        throw new Error(
            "Missing OP_SEPOLIA_RPC_URL or OP_SEPOLIA_PRIVATE_KEY in .env",
        );
    }

    console.log("RPC URL:", rpcUrl);

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const sender = await wallet.getAddress();

    console.log("Sender address:", sender);
    console.log("Batch size (CidEvent count):", BATCH_SIZE);
    console.log("RUN_ID:", RUN_ID);
    console.log("");

    // Instantiate contracts
    const actorRegistry = new ethers.Contract(
        ACTOR_REGISTRY_ADDRESS,
        (actorRegistryArtifact as any).abi,
        wallet,
    );

    const cidRollup = new ethers.Contract(
        CID_ROLLUP_ADDRESS,
        (cidRollupArtifact as any).abi,
        wallet,
    );

    // Ensure sender is a registered ACTIVE actor
    await ensureRegisteredActor(actorRegistry, wallet);
    console.log("");

    // Build synthetic CidEvent entries
    type CidEvent = {
        productId: string;
        stepId: string;
        cidHash: string;
        stepType: number;
    };

    const events: CidEvent[] = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
        const productIndex = Math.floor(i / 10); // 10 steps per product just for variety

        // Include RUN_ID so each script run gets unique (productId, stepId, cidHash)
        const productId = toBytes32(`run-${RUN_ID}-product-${productIndex}`);
        const stepId = toBytes32(`run-${RUN_ID}-step-${i}`);
        const cidHash = toBytes32(`run-${RUN_ID}-cid-${i}`);

        // StepType enum (1..6): Produced, Processed, Shipped, Received, AtRetail, Sold
        const stepType = ((i % 6) + 1) as number;

        events.push({
            productId,
            stepId,
            cidHash,
            stepType,
        });
    }

    console.log(
        `Prepared ${events.length} CidEvent entries. Calling submitCidBatch...`,
    );

    // Measure timing: send + mined
    const t0 = Date.now();
    const tx = await cidRollup.submitCidBatch(events);
    const t1 = Date.now();

    console.log("submitCidBatch tx hash:", tx.hash);
    console.log(`Time to send tx (ms):   ${t1 - t0}`);

    const receipt = await tx.wait();
    const t2 = Date.now();

    console.log("Tx mined in block:", receipt?.blockNumber?.toString());
    console.log("Gas used:", receipt?.gasUsed?.toString());
    console.log(`Total time to mined (ms): ${t2 - t0}`);
}

main().catch((err) => {
    console.error("Error in CID batch benchmark script:", err);
    process.exit(1);
});
