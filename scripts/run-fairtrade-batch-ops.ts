// scripts/run-fairtrade-batch-ops.ts
//
// Run one full FairTrade coffee-batch scenario and measure gas per operation.
// For each StepType s in S = {Produced, Processed, Shipped, Received, AtRetail, Sold},
// we send n_s CidRollup.submitCidBatch(...) transactions, each anchoring ONE CidEvent,
// and wait for confirmation before sending the next tx.
//
// Step counts per batch (CID anchors):
//   Produced : n_Produced  = 1
//   Processed: n_Processed = 2
//   Shipped  : n_Shipped   = 4
//   Received : n_Received  = 4
//   AtRetail : n_AtRetail  = 1
//   Sold     : n_Sold      = 1
//
// Usage:
//   1) Put in .env:
//        OP_SEPOLIA_RPC_URL=...
//        OP_SEPOLIA_PRIVATE_KEY=0xa77e00ca1d46c8718c185139e2755f320e729fab38ec0da616818e20c8f2d9f6
//   2) Ensure op-sepolia-deployments.json exists (from deploy-op-sepolia.ts)
//   3) Run:
//        npx tsx scripts/run-fairtrade-batch-ops.ts

import "dotenv/config";
import { JsonRpcProvider, Wallet, ethers } from "ethers";
import { promises as fs } from "fs";
import path from "path";

import actorRegistryArtifact from "../artifacts/contracts/ActorRegistry.sol/ActorRegistry.json";
import cidRollupArtifact from "../artifacts/contracts/CidRollup.sol/CidRollup.json";

// -----------------------------------------------------------------------------
// Types / enums
// -----------------------------------------------------------------------------

// Must match FairtradeTypes.StepType in Solidity
enum StepType {
    Unknown = 0,
    Produced = 1,
    Processed = 2,
    Shipped = 3,
    Received = 4,
    AtRetail = 5,
    Sold = 6,
}

type CidEvent = {
    productId: string;
    stepId: string;
    cidHash: string;
    stepType: number;
};

type DeploymentMap = { [name: string]: string };

// Step set S and per-step operation counts n_s
const STEP_ORDER: StepType[] = [
    StepType.Produced,
    StepType.Processed,
    StepType.Shipped,
    StepType.Received,
    StepType.AtRetail,
    StepType.Sold,
];

const STEP_LABEL: Record<StepType, string> = {
    [StepType.Unknown]: "Unknown",
    [StepType.Produced]: "Produced",
    [StepType.Processed]: "Processed",
    [StepType.Shipped]: "Shipped",
    [StepType.Received]: "Received",
    [StepType.AtRetail]: "AtRetail",
    [StepType.Sold]: "Sold",
};

// n_s for each s ∈ S
const OPS_PER_STEP: Record<StepType, number> = {
    [StepType.Unknown]: 0,
    [StepType.Produced]: 1,
    [StepType.Processed]: 2,
    [StepType.Shipped]: 4,
    [StepType.Received]: 4,
    [StepType.AtRetail]: 1,
    [StepType.Sold]: 1,
};

// Role = Producer (1) from FairtradeTypes.Role
const ROLE_PRODUCER = 1;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const DEPLOYMENTS_FILE = path.join(process.cwd(), "op-sepolia-deployments.json");

async function loadDeployments(): Promise<DeploymentMap> {
    const raw = await fs.readFile(DEPLOYMENTS_FILE, "utf8");
    return JSON.parse(raw) as DeploymentMap;
}

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
        console.log(`Actor already active: ${addr}`);
        return;
    }

    console.log(`Actor not active, registering as Producer: ${addr}`);

    const orgIdHash = toBytes32(`fairtrade-org-${addr.toLowerCase()}`);
    const metadataHash = toBytes32(`fairtrade-meta-${addr.toLowerCase()}`);

    const tx = await actorRegistry.registerActor(
        orgIdHash,
        addr,
        ROLE_PRODUCER,
        metadataHash,
    );
    console.log(`  registerActor tx=${tx.hash}`);
    const receipt = await tx.wait();
    console.log(
        `  registerActor confirmed in block ${receipt?.blockNumber?.toString()}`,
    );
}

// Build ONE CidEvent for a given step / operation index (unique stepId + cidHash)
function buildCidEvent(
    batchTag: string,
    step: StepType,
    opIndex: number,
): CidEvent {
    const productId = toBytes32(`batch-${batchTag}`); // same productId for whole batch

    const stepLabel = STEP_LABEL[step];
    const stepId = toBytes32(
        `batch-${batchTag}-step-${stepLabel}-${opIndex}`,
    );
    const cidHash = toBytes32(
        `cid-${batchTag}-${stepLabel}-${opIndex}`,
    );

    return {
        productId,
        stepId,
        cidHash,
        stepType: step,
    };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
    const rpcUrl = process.env.OP_SEPOLIA_RPC_URL;
    const pk = process.env.OP_SEPOLIA_PRIVATE_KEY;

    if (!rpcUrl || !pk) {
        throw new Error(
            "Missing OP_SEPOLIA_RPC_URL or OP_SEPOLIA_PRIVATE_KEY in .env",
        );
    }

    const deployments = await loadDeployments();
    const actorRegistryAddress = deployments["ActorRegistry"];
    const cidRollupAddress = deployments["CidRollup"];

    if (!actorRegistryAddress || !cidRollupAddress) {
        throw new Error(
            "ActorRegistry or CidRollup address missing in op-sepolia-deployments.json",
        );
    }

    console.log("RPC URL:", rpcUrl);
    console.log("ActorRegistry:", actorRegistryAddress);
    console.log("CidRollup:", cidRollupAddress);
    console.log("");

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(pk, provider);
    const sender = await wallet.getAddress();
    console.log("Sender (funder) address:", sender);
    console.log("");

    const actorRegistry = new ethers.Contract(
        actorRegistryAddress,
        (actorRegistryArtifact as any).abi,
        wallet,
    );
    const cidRollup = new ethers.Contract(
        cidRollupAddress,
        (cidRollupArtifact as any).abi,
        wallet,
    );

    // Ensure the wallet is registered as an active actor
    await ensureRegisteredActor(actorRegistry, wallet);
    console.log("");

    const batchTag = `${Date.now()}`; // unique tag so (productId, stepId) pairs are fresh

    let totalOps = 0;
    let totalGas = 0n;

    console.log("=== Starting FairTrade batch walkthrough ===");
    console.log(`Batch tag: ${batchTag}`);
    console.log("");

    for (const step of STEP_ORDER) {
        const stepLabel = STEP_LABEL[step];
        const n_s = OPS_PER_STEP[step];

        console.log(
            `--- Step ${stepLabel} (StepType=${step}, n_s=${n_s}) ---`,
        );

        for (let j = 0; j < n_s; j++) {
            const event = buildCidEvent(batchTag, step, j);
            const events: CidEvent[] = [event];

            const tx = await cidRollup.submitCidBatch(events);
            console.log(
                `  [${stepLabel} op ${j + 1}/${n_s}] tx sent: ${tx.hash}`,
            );
            const receipt = await tx.wait();
            const gasUsed = receipt?.gasUsed ?? 0n;

            console.log(
                `      ✓ confirmed in block ${receipt?.blockNumber?.toString()} ` +
                `gasUsed=${gasUsed.toString()}`,
            );

            totalOps += 1;
            totalGas += gasUsed;
        }

        console.log("");
    }

    console.log("=== Batch walkthrough complete ===");
    console.log(`Total CID-anchor operations (∑_s n_s): ${totalOps}`);
    console.log(`Total gas over all ops:               ${totalGas.toString()}`);
    if (totalOps > 0) {
        const avgGasPerOp = totalGas / BigInt(totalOps);
        console.log(`Average gas per CID anchor:          ${avgGasPerOp.toString()}`);
    }
}

main().catch((err) => {
    console.error("Fatal error in run-fairtrade-batch-ops:", err);
    process.exit(1);
});
