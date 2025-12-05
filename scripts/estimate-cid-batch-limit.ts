// scripts/benchmark-cid-batch-limit-binary.ts
//
// Use real CidRollup.submitCidBatch() transactions + strict binary search
// to find the largest batch size (CidEvent count) that can be confirmed
// without reverting (e.g. out-of-gas).
//
// Rules:
// - Start from batchSize = 800 (configurable via CID_INITIAL_BATCH)
// - When a given batchSize fails, try (batchSize + 1) once to double-check
//   (in case of transient issues).
// - Then adjust [low, high] via standard binary search (mid = (low+high)/2),
//   NOT by decrementing size one by one.
// - Sleep CID_TRIAL_DELAY_MS (default 10000 ms) after each trial to avoid
//   hammering the RPC.
//
// Contracts on OP Sepolia:
//   ActorRegistry: 0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1
//   CidRollup:     0xC6d171F707bA43BdF490362a357D975B76976264
//
// Env:
//   OP_SEPOLIA_RPC_URL=...
//   OP_SEPOLIA_PRIVATE_KEY=...
//
// Optional env:
//   CID_MIN_BATCH=100
//   CID_MAX_BATCH=4096
//   CID_INITIAL_BATCH=800
//   CID_RUN_ID=tag
//   CID_TRIAL_DELAY_MS=10000  # delay after each testWithDoubleCheck
//
// Run:
//   npx tsx scripts/benchmark-cid-batch-limit-binary.ts

import "dotenv/config";
import { JsonRpcProvider, Wallet, ethers } from "ethers";

import actorRegistryArtifact from "../artifacts/contracts/ActorRegistry.sol/ActorRegistry.json";
import cidRollupArtifact from "../artifacts/contracts/CidRollup.sol/CidRollup.json";

// -----------------------------------------------------------------------------
// Deployed addresses (OP Sepolia)
// -----------------------------------------------------------------------------

const ACTOR_REGISTRY_ADDRESS = "0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1";
const CID_ROLLUP_ADDRESS = "0xC6d171F707bA43BdF490362a357D975B76976264";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const GLOBAL_MIN_BATCH = Number(process.env.CID_MIN_BATCH ?? "100");
const GLOBAL_MAX_BATCH = Number(process.env.CID_MAX_BATCH ?? "4096");

// Starting point for search – default 800 as requested
const INITIAL_BATCH = Number(process.env.CID_INITIAL_BATCH ?? "800");

// Unique base run id so each tx uses fresh (productId, stepId)
const RUN_ID_BASE = process.env.CID_RUN_ID ?? `${Date.now()}`;

// Delay between trials (ms) to avoid RPC issues
const TRIAL_DELAY_MS = Number(process.env.CID_TRIAL_DELAY_MS ?? "10000");

// FairtradeTypes.Role.Producer = 1
const ROLE_PRODUCER = 1;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        console.log(`Actor already active in registry: ${addr}`);
        return;
    }

    console.log(`Actor not registered, registering as Producer: ${addr}`);

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

type CidEvent = {
    productId: string;
    stepId: string;
    cidHash: string;
    stepType: number;
};

// 给某个 batchSize + 某次尝试，生成一批完全独立的 CidEvent
function buildEvents(batchSize: number, attemptTag: string): CidEvent[] {
    const events: CidEvent[] = [];

    for (let i = 0; i < batchSize; i++) {
        const productIndex = Math.floor(i / 10); // 10 steps per product, just for variety

        const productId = toBytes32(
            `run-${attemptTag}-product-${productIndex}`,
        );
        const stepId = toBytes32(`run-${attemptTag}-step-${i}`);
        const cidHash = toBytes32(`run-${attemptTag}-cid-${i}`);

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

// 只测一个 size，一次交易
async function tryOnce(
    cidRollup: ethers.Contract,
    batchSize: number,
    attemptIndex: number,
): Promise<{ ok: boolean; gasUsed?: bigint }> {
    const attemptTag = `${RUN_ID_BASE}-n${batchSize}-try${attemptIndex}`;
    const events = buildEvents(batchSize, attemptTag);

    console.log(
        `\n>>> Try batchSize=${batchSize}, attempt=${attemptIndex}, tag=${attemptTag}`,
    );

    try {
        const t0 = Date.now();
        const tx = await cidRollup.submitCidBatch(events);
        const t1 = Date.now();

        console.log(`   tx hash: ${tx.hash}`);
        console.log(`   time to send (ms): ${t1 - t0}`);

        const receipt = await tx.wait();
        const t2 = Date.now();

        const gasUsed = receipt?.gasUsed ?? 0n;

        console.log(
            `   ✅ SUCCESS: block=${receipt?.blockNumber?.toString()}, gasUsed=${gasUsed.toString()}, total ms=${t2 - t0}`,
        );

        return { ok: true, gasUsed };
    } catch (err: any) {
        const short =
            err?.shortMessage ??
            err?.reason ??
            err?.error?.message ??
            err?.message ??
            String(err);

        console.log(
            `   ❌ FAIL for batchSize=${batchSize}, reason: ${short}`,
        );
        return { ok: false };
    }
}

// 按你的要求：
// - 先尝试 size
// - 如果失败，再尝试 size+1 做 double-check
// 返回：ok 表示“这一侧可以认为是成功”，usedSize 为成功时的 size（可能是 size+1）
async function testWithDoubleCheck(
    cidRollup: ethers.Contract,
    batchSize: number,
    attemptCounter: { value: number },
    maxBatch: number,
): Promise<{ ok: boolean; usedSize?: number; gasUsed?: bigint }> {
    attemptCounter.value++;
    const first = await tryOnce(
        cidRollup,
        batchSize,
        attemptCounter.value,
    );

    if (first.ok) {
        return { ok: true, usedSize: batchSize, gasUsed: first.gasUsed };
    }

    // 如果已经到上界，就没必要 size+1 了
    if (batchSize >= maxBatch) {
        return { ok: false };
    }

    // double-check: size+1
    const secondSize = batchSize + 1;
    attemptCounter.value++;
    const second = await tryOnce(
        cidRollup,
        secondSize,
        attemptCounter.value,
    );

    if (second.ok) {
        console.log(
            `   ⚠️  size=${batchSize} failed but size=${secondSize} succeeded, treating this region as OK (likely transient issue).`,
        );
        return {
            ok: true,
            usedSize: secondSize,
            gasUsed: second.gasUsed,
        };
    }

    return { ok: false };
}

// -----------------------------------------------------------------------------
// Main (binary search core)
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
    console.log("GLOBAL_MIN_BATCH:", GLOBAL_MIN_BATCH);
    console.log("GLOBAL_MAX_BATCH:", GLOBAL_MAX_BATCH);
    console.log("INITIAL_BATCH:", INITIAL_BATCH);
    console.log("RUN_ID_BASE:", RUN_ID_BASE);
    console.log("TRIAL_DELAY_MS:", TRIAL_DELAY_MS);
    console.log("");

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const sender = await wallet.getAddress();

    console.log("Sender address:", sender);
    console.log("");

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

    // 保证 sender 是 ACTIVE actor
    await ensureRegisteredActor(actorRegistry, wallet);
    console.log("");

    const attempts = { value: 0 };

    // ---------- 初始点：严格从 800 开始 ----------
    let low = 0; // 最大 confirmed size
    let high = GLOBAL_MAX_BATCH;
    let bestSize = 0;
    let bestGas: bigint | undefined;

    // clamp 初始 size 在 [GLOBAL_MIN_BATCH, GLOBAL_MAX_BATCH]
    const initial = Math.min(
        Math.max(INITIAL_BATCH, GLOBAL_MIN_BATCH),
        GLOBAL_MAX_BATCH,
    );

    console.log(
        `=== Initial probe at batchSize=${initial} (with +1 double-check if needed) ===`,
    );

    const initRes = await testWithDoubleCheck(
        cidRollup,
        initial,
        attempts,
        GLOBAL_MAX_BATCH,
    );

    // 试完初始点后，等一会儿
    await sleep(TRIAL_DELAY_MS);

    if (initRes.ok && initRes.usedSize !== undefined) {
        low = initRes.usedSize;
        bestSize = initRes.usedSize;
        bestGas = initRes.gasUsed;
        console.log(
            `Initial region OK around ~${initial} (effective size=${initRes.usedSize}).`,
        );
    } else {
        // 初始点附近都失败了，把 high 收缩到 initial-1，然后从 [GLOBAL_MIN_BATCH, high] 做二分
        high = initial - 1;
        if (high < GLOBAL_MIN_BATCH) {
            console.log(
                `\n❌ Initial batchSize=${initial} and ${initial + 1} both failed, and high<GLOBAL_MIN_BATCH.`,
            );
            console.log(
                "   Check gas / RPC / contracts; no safe batch size found in configured range.",
            );
            return;
        }
        console.log(
            `Initial region around ~${initial} failed; new search range = [${GLOBAL_MIN_BATCH}, ${high}]`,
        );
    }

    // 如果初始就确定 low==GLOBAL_MAX_BATCH，那已经是最大了
    if (low >= GLOBAL_MAX_BATCH) {
        console.log(
            `\nMax confirmed batchSize is at least GLOBAL_MAX_BATCH=${GLOBAL_MAX_BATCH}, bestSize=${bestSize}`,
        );
        return;
    }

    if (low === 0) {
        // 初始失败，现在的有效区间是 [GLOBAL_MIN_BATCH, high]，还没任何成功点
        low = GLOBAL_MIN_BATCH - 1;
    }

    console.log(
        `\n=== Binary search phase (strict) on [${Math.max(
            low + 1,
            GLOBAL_MIN_BATCH,
        )}, ${high}] ===`,
    );

    // 标准二分：始终维持 "所有 <= low 的 size 被认为是 OK；所有 > high 的 size 被认为是 FAIL"
    while (true) {
        const searchLow = Math.max(low + 1, GLOBAL_MIN_BATCH);
        if (searchLow > high) break; // 没有新的 mid 可以测了

        const mid = Math.floor((searchLow + high) / 2);
        console.log(`\n--- Binary search step: low=${low}, high=${high}, mid=${mid} ---`);

        const res = await testWithDoubleCheck(
            cidRollup,
            mid,
            attempts,
            GLOBAL_MAX_BATCH,
        );

        // 每轮试完 mid (+ mid+1) 后都 sleep 一次，避免 RPC 被打爆
        await sleep(TRIAL_DELAY_MS);

        if (res.ok && res.usedSize !== undefined) {
            // mid 这一侧被认为是 OK
            low = res.usedSize;
            if (res.usedSize > bestSize) {
                bestSize = res.usedSize;
                bestGas = res.gasUsed;
            }
            console.log(
                `   ✅ mid region OK, new low=${low}, bestSize=${bestSize}`,
            );
        } else {
            // mid 这一侧失败：严格 binary search => high = mid - 1
            high = mid - 1;
            console.log(`   ❌ mid region FAIL, new high=${high}`);
        }
    }

    console.log("\n=== Final CID batch size limit (binary search + double-check) ===");
    console.log(`Best confirmed batchSize: ${bestSize}`);
    console.log(
        `Gas used at best size:  ${bestGas?.toString() ?? "unknown"}`,
    );
    console.log(
        `Search window was:      [${GLOBAL_MIN_BATCH}, ${GLOBAL_MAX_BATCH}]`,
    );
}

main().catch((err) => {
    console.error("Fatal error in benchmark-cid-batch-limit-binary:", err);
    process.exit(1);
});
