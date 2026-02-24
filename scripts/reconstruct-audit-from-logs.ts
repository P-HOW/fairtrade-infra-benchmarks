// scripts/reconstruct-audit-from-logs.ts
//
// Reconstruct an auditable batch timeline from on-chain logs.
// - Queries logs from: CidRollup, DocumentRegistry, ProcessManager
// - Filters by indexed productId
// - Sorts by (blockNumber, logIndex)
// - Decodes key fields from event data (no ABI dependency required)
// - Writes a machine-readable JSON report
//
// FIXES:
// - If you run with no args, this script now defaults productId.
// - Providers like Alchemy Free tier limit eth_getLogs ranges; script chunks, logs progress, and can early-stop.
//
// Usage (recommended):
//   npx tsx scripts/reconstruct-audit-from-logs.ts --productId "coffee-batch-001"
//   npx tsx scripts/reconstruct-audit-from-logs.ts --productId 0x<32-byte-hex> --lookback 50000
//
// Usage (no args):
//   npx tsx scripts/reconstruct-audit-from-logs.ts
//   -> uses env AUDIT_PRODUCT_ID if present else "coffee-batch-001"
//
// Optional flags:
//   --lookback <n>         default 200000
//   --fromBlock <n>        overrides lookback
//   --toBlock <n>          default latest
//   --chunk <n>            default 10 (safe for Alchemy Free)
//   --sleepMs <n>          default 120
//   --progressEvery <n>    default 200
//   --earlyStop <0|1>      default 1
//   --maxRequests <n>      default 250000 (safety)
//
// Env (.env):
//   OP_SEPOLIA_RPC_URL=...
//   OP_SEPOLIA_PUBLIC_RPCS_JSON=[...]
//   # Optional overrides (otherwise defaults to README deployment addresses):
//   CID_ROLLUP_ADDRESS=0x...
//   DOCUMENT_REGISTRY_ADDRESS=0x...
//   PROCESS_MANAGER_ADDRESS=0x...

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { request } from "undici";

// -------------------- Force-load .env from repo root --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// -------------------- Minimal CLI parsing --------------------
type Args = {
    productId: string;
    fromBlock?: number;
    toBlock?: number;
    lookback?: number;
    out?: string;

    chunk?: number;
    sleepMs?: number;
    progressEvery?: number;
    earlyStop?: number;
    maxRequests?: number;
};

function parseArgs(argv: string[]): Args {
    const out: Partial<Args> = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const v = argv[i + 1];

        if (a === "--productId" && v) { out.productId = v; i++; continue; }
        if (a === "--fromBlock" && v) { out.fromBlock = Number(v); i++; continue; }
        if (a === "--toBlock" && v) { out.toBlock = Number(v); i++; continue; }
        if (a === "--lookback" && v) { out.lookback = Number(v); i++; continue; }
        if (a === "--out" && v) { out.out = v; i++; continue; }

        if (a === "--chunk" && v) { out.chunk = Number(v); i++; continue; }
        if (a === "--sleepMs" && v) { out.sleepMs = Number(v); i++; continue; }
        if (a === "--progressEvery" && v) { out.progressEvery = Number(v); i++; continue; }
        if (a === "--earlyStop" && v) { out.earlyStop = Number(v); i++; continue; }
        if (a === "--maxRequests" && v) { out.maxRequests = Number(v); i++; continue; }
    }

    // --- BYPASS: default productId if not provided ---
    if (!out.productId) {
        const envDefault = (process.env.AUDIT_PRODUCT_ID || "").trim();
        out.productId = envDefault || "coffee-batch-001";
    }

    return out as Args;
}

function mustEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var: ${name}`);
    return v;
}

function toHexQty(n: number | bigint): string {
    const b = typeof n === "bigint" ? n : BigInt(n);
    if (b < 0n) throw new Error("toHexQty: negative");
    return "0x" + b.toString(16);
}

function hexToBigInt(h: string): bigint {
    return BigInt(h);
}

function pad32(hexNo0x: string): string {
    return hexNo0x.padStart(64, "0");
}

async function keccakUtf8ToBytes32(s: string): Promise<string> {
    try {
        const mod: any = await import("ethers");
        if (typeof mod.id === "function") return mod.id(s);
        if (mod.ethers && typeof mod.ethers.id === "function") return mod.ethers.id(s);
    } catch {}
    try {
        const mod: any = await import("viem");
        return mod.keccak256(mod.toBytes(s));
    } catch {}
    throw new Error("Need ethers or viem installed to hash strings to bytes32 (keccak256).");
}

async function topic0(sig: string): Promise<string> {
    return keccakUtf8ToBytes32(sig);
}

function normalizeHexAddress(addr: string): string {
    if (!addr) throw new Error("Empty address");
    const a = addr.trim();
    if (!a.startsWith("0x") || a.length !== 42) throw new Error(`Bad address: ${addr}`);
    return a;
}

async function normalizeProductId(input: string): Promise<string> {
    const t = input.trim();
    if (t.startsWith("0x") && t.length === 66) return t.toLowerCase();
    return (await keccakUtf8ToBytes32(t)).toLowerCase();
}

type RpcLog = {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    logIndex: string;
};

async function rpc(url: string, method: string, params: any[]): Promise<any> {
    const res = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`RPC HTTP ${res.statusCode}: ${text.slice(0, 600)}`);
    }
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`RPC non-JSON response: ${text.slice(0, 600)}`);
    }
    if (parsed.error) {
        throw new Error(`RPC error (${method}): ${JSON.stringify(parsed.error).slice(0, 600)}`);
    }
    return parsed.result;
}

async function getLatestBlockNumber(rpcUrl: string): Promise<number> {
    const h = await rpc(rpcUrl, "eth_blockNumber", []);
    return Number(hexToBigInt(h));
}

async function getBlockTimestamp(rpcUrl: string, blockNumber: bigint): Promise<number> {
    const blk = await rpc(rpcUrl, "eth_getBlockByNumber", [toHexQty(blockNumber), false]);
    return Number(hexToBigInt(blk.timestamp));
}

function decodeBytes32(wordHex: string): string {
    if (!wordHex.startsWith("0x") || wordHex.length !== 66) return wordHex;
    return wordHex.toLowerCase();
}

function decodeUint(wordHex: string): bigint {
    const h = wordHex.startsWith("0x") ? wordHex : "0x" + wordHex;
    return BigInt(h);
}

function splitWords(dataHex: string): string[] {
    const h = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
    const words: string[] = [];
    for (let i = 0; i < h.length; i += 64) {
        const chunk = h.slice(i, i + 64);
        if (chunk.length === 64) words.push("0x" + chunk);
    }
    return words;
}

function decodeAddressFromWord(wordHex: string): string {
    const h = wordHex.startsWith("0x") ? wordHex.slice(2) : wordHex;
    return "0x" + h.slice(24);
}

const StepTypeName: Record<number, string> = {
    0: "Unknown",
    1: "Produced",
    2: "Processed",
    3: "Shipped",
    4: "Received",
    5: "AtRetail",
    6: "Sold",
};

const ProcessStatusName: Record<number, string> = {
    0: "Unknown",
    1: "Created",
    2: "InTransit",
    3: "AtRetail",
    4: "Sold",
    5: "Certified",
    6: "Suspended",
    7: "Revoked",
};

type AuditEvent =
    | {
    kind: "CidAnchored";
    blockNumber: bigint;
    logIndex: bigint;
    txHash: string;
    timestamp?: number;
    productId: string;
    stepId: string;
    orgIdHash: string;
    cidHash: string;
    stepType: number;
    actor: string;
    contract: string;
}
    | {
    kind: "DocumentAnchored";
    blockNumber: bigint;
    logIndex: bigint;
    txHash: string;
    timestamp?: number;
    productId: string;
    stepId: string;
    orgIdHash: string;
    cidHash: string;
    docType: number;
    actor: string;
    contract: string;
}
    | {
    kind: "ProcessCreated";
    blockNumber: bigint;
    logIndex: bigint;
    txHash: string;
    timestamp?: number;
    productId: string;
    orgIdHash: string;
    contract: string;
}
    | {
    kind: "ProcessStatusChanged";
    blockNumber: bigint;
    logIndex: bigint;
    txHash: string;
    timestamp?: number;
    productId: string;
    orgIdHash: string;
    previousStatus: number;
    newStatus: number;
    actor: string;
    contract: string;
};

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

function parseJsonArrayEnv(name: string): string[] {
    const raw = process.env[name];
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.map(String).filter(Boolean);
    } catch {
        return [];
    }
}

function getLogsRpcCandidates(): string[] {
    const out: string[] = [];
    const primary = (process.env.OP_SEPOLIA_RPC_URL || "").trim();
    if (primary) out.push(primary);
    for (const u of parseJsonArrayEnv("OP_SEPOLIA_PUBLIC_RPCS_JSON")) out.push(u.trim());
    return Array.from(new Set(out.filter(Boolean)));
}

function looksLikeRangeLimitError(msg: string): boolean {
    const m = msg.toLowerCase();
    return (
        m.includes("block range") ||
        m.includes("eth_getlogs requests with up to") ||
        m.includes("too many") ||
        m.includes("exceed") ||
        m.includes("limit") ||
        m.includes("max") ||
        m.includes("request size") ||
        m.includes("429")
    );
}

async function ethGetLogsChunkedWithProgress(params: {
    label: string;
    rpcCandidates: string[];
    filterBase: any;
    fromBlock: number;
    toBlock: number;
    chunkSize: number;
    chunkSleepMs: number;
    progressEvery: number;
    maxRequests: number;
    earlyStopCheck?: (accumulatedLogs: RpcLog[]) => boolean;
}): Promise<RpcLog[]> {
    const {
        label,
        rpcCandidates,
        filterBase,
        fromBlock,
        toBlock,
        chunkSize: chunkSizeInput,
        chunkSleepMs,
        progressEvery,
        maxRequests,
        earlyStopCheck,
    } = params;

    if (rpcCandidates.length === 0) throw new Error("No RPC candidates available for logs.");

    const all: RpcLog[] = [];
    const totalBlocks = toBlock - fromBlock + 1;

    let chunkSize = Math.max(1, Math.floor(chunkSizeInput));
    let start = fromBlock;

    let reqCount = 0;
    let chunkCount = 0;
    const t0 = Date.now();

    const totalChunksEst = Math.ceil(totalBlocks / chunkSize);

    const logProgress = (force = false) => {
        if (!force && chunkCount % progressEvery !== 0) return;
        const doneBlocks = start - fromBlock;
        const pct = Math.min(100, Math.max(0, (doneBlocks / totalBlocks) * 100));
        const elapsedS = (Date.now() - t0) / 1000;
        const chunksDone = chunkCount;
        const chunksLeft = Math.max(0, totalChunksEst - chunksDone);
        const rate = chunksDone > 0 ? elapsedS / chunksDone : NaN;
        const etaS = Number.isFinite(rate) ? rate * chunksLeft : NaN;

        console.log(
            `[${label}] progress: ${pct.toFixed(2)}% ` +
            `(chunks ${chunksDone}/${totalChunksEst}, logs=${all.length}, chunkSize=${chunkSize}, req=${reqCount})` +
            (Number.isFinite(etaS) ? ` ETA~${Math.round(etaS)}s` : "")
        );
    };

    console.log(
        `[${label}] starting chunked scan: blocks=${totalBlocks}, initialChunk=${chunkSize}, candidates=${rpcCandidates.length}`
    );

    while (start <= toBlock) {
        if (reqCount >= maxRequests) {
            console.log(`[${label}] STOP: reached maxRequests=${maxRequests}. Returning partial logs=${all.length}.`);
            break;
        }

        const end = Math.min(toBlock, start + chunkSize - 1);
        const filter = { ...filterBase, fromBlock: toHexQty(start), toBlock: toHexQty(end) };

        let lastErr: any = null;
        let success = false;

        for (const rpcUrl of rpcCandidates) {
            try {
                reqCount++;
                const res = (await rpc(rpcUrl, "eth_getLogs", [filter])) as RpcLog[];
                all.push(...res);
                lastErr = null;
                success = true;
                break;
            } catch (e: any) {
                lastErr = e;
            }
        }

        if (!success) {
            const msg = String(lastErr?.message ?? lastErr);

            if (chunkSize > 1 && looksLikeRangeLimitError(msg)) {
                const newChunk = Math.max(1, Math.floor(chunkSize / 2));
                console.log(
                    `[${label}] range-limited/throttled. Reducing chunkSize ${chunkSize} -> ${newChunk} and retrying [${start}, ${end}]`
                );
                chunkSize = newChunk;
                continue;
            }

            throw new Error(`[${label}] eth_getLogs failed for [${start},${end}] on all RPCs. Last error: ${msg}`);
        }

        start = end + 1;
        chunkCount++;

        logProgress(false);

        if (earlyStopCheck && earlyStopCheck(all)) {
            console.log(`[${label}] EARLY STOP triggered. Returning logs=${all.length}.`);
            break;
        }

        if (chunkSleepMs > 0) await sleep(chunkSleepMs);
    }

    logProgress(true);
    return all;
}

async function main() {
    const args = parseArgs(process.argv);

    const primaryRpc = mustEnv("OP_SEPOLIA_RPC_URL").trim();
    const rpcCandidates = getLogsRpcCandidates();

    const productIdInput = args.productId;
    const productId = await normalizeProductId(productIdInput);

    const CID_ROLLUP_ADDRESS = normalizeHexAddress(
        (process.env.CID_ROLLUP_ADDRESS || "0xC6d171F707bA43BdF490362a357D975B76976264").trim()
    );
    const DOCUMENT_REGISTRY_ADDRESS = normalizeHexAddress(
        (process.env.DOCUMENT_REGISTRY_ADDRESS || "0xBEb8140eeaf2f23916dA88F8F0886827a0f5145c").trim()
    );
    const PROCESS_MANAGER_ADDRESS = normalizeHexAddress(
        (process.env.PROCESS_MANAGER_ADDRESS || "0xeD7AA6c4B1fA3FFCEC378dcFEAc0406540F5078c").trim()
    );

    const latest = await getLatestBlockNumber(primaryRpc);
    const lookback = args.lookback ?? 200_000;

    const fromBlock = args.fromBlock !== undefined ? args.fromBlock : Math.max(0, latest - lookback);
    const toBlock = args.toBlock !== undefined ? args.toBlock : latest;

    const chunk = args.chunk ?? 10;
    const sleepMs = args.sleepMs ?? 120;
    const progressEvery = args.progressEvery ?? 200;
    const earlyStop = (args.earlyStop ?? 1) === 1;
    const maxRequests = args.maxRequests ?? 250_000;

    // Event topic0 signatures
    const tCidAnchored = await topic0("CidAnchored(bytes32,bytes32,bytes32,uint8,bytes32,address)");
    const tDocAnchored = await topic0("DocumentAnchored(bytes32,bytes32,bytes32,uint8,bytes32,address)");
    const tProcessCreated = await topic0("ProcessCreated(bytes32,bytes32)");
    const tProcessStatusChanged = await topic0("ProcessStatusChanged(bytes32,uint8,uint8,bytes32,address)");

    console.log(`Loaded .env from: ${path.resolve(__dirname, "..", ".env")}`);
    console.log(`RPC (primary): ${primaryRpc}`);
    console.log(`RPC candidates for logs: ${rpcCandidates.length}`);
    console.log(`productId input: ${productIdInput}`);
    console.log(`productId (bytes32): ${productId}`);
    console.log(`fromBlock: ${fromBlock}  toBlock: ${toBlock}`);
    console.log(`chunk=${chunk} sleepMs=${sleepMs} progressEvery=${progressEvery} earlyStop=${earlyStop ? "ON" : "OFF"} maxRequests=${maxRequests}`);
    console.log(`CidRollup: ${CID_ROLLUP_ADDRESS}`);
    console.log(`DocumentRegistry: ${DOCUMENT_REGISTRY_ADDRESS}`);
    console.log(`ProcessManager: ${PROCESS_MANAGER_ADDRESS}\n`);

    const requiredStepTypes = new Set([1, 2, 3, 4, 5, 6]);

    const cidEarlyStop = (logs: RpcLog[]) => {
        if (!earlyStop) return false;
        const seen = new Set<number>();
        for (const l of logs) {
            const words = splitWords(l.data);
            const stepType = Number(decodeUint(words[1] || "0x0"));
            if (requiredStepTypes.has(stepType)) seen.add(stepType);
            if (seen.size === requiredStepTypes.size) return true;
        }
        return false;
    };

    const procEarlyStop = (logs: RpcLog[]) => earlyStop && logs.length > 0;

    const [cidLogs, docLogs, procLogs] = await Promise.all([
        ethGetLogsChunkedWithProgress({
            label: "CidRollup",
            rpcCandidates,
            filterBase: { address: CID_ROLLUP_ADDRESS, topics: [tCidAnchored, productId] },
            fromBlock,
            toBlock,
            chunkSize: chunk,
            chunkSleepMs: sleepMs,
            progressEvery,
            maxRequests,
            earlyStopCheck: cidEarlyStop,
        }),
        ethGetLogsChunkedWithProgress({
            label: "DocumentRegistry",
            rpcCandidates,
            filterBase: { address: DOCUMENT_REGISTRY_ADDRESS, topics: [tDocAnchored, productId] },
            fromBlock,
            toBlock,
            chunkSize: chunk,
            chunkSleepMs: sleepMs,
            progressEvery,
            maxRequests,
        }),
        ethGetLogsChunkedWithProgress({
            label: "ProcessManager",
            rpcCandidates,
            filterBase: { address: PROCESS_MANAGER_ADDRESS, topics: [[tProcessCreated, tProcessStatusChanged], productId] },
            fromBlock,
            toBlock,
            chunkSize: chunk,
            chunkSleepMs: sleepMs,
            progressEvery,
            maxRequests,
            earlyStopCheck: procEarlyStop,
        }),
    ]);

    const events: AuditEvent[] = [];

    for (const l of cidLogs) {
        const stepId = decodeBytes32(l.topics[2]);
        const orgIdHash = decodeBytes32(l.topics[3]);
        const words = splitWords(l.data);
        const cidHash = decodeBytes32(words[0] || "0x");
        const stepType = Number(decodeUint(words[1] || "0x0"));
        const actor = decodeAddressFromWord(words[2] || "0x" + pad32("0"));

        events.push({
            kind: "CidAnchored",
            contract: "CidRollup",
            blockNumber: hexToBigInt(l.blockNumber),
            logIndex: hexToBigInt(l.logIndex),
            txHash: l.transactionHash,
            productId,
            stepId,
            orgIdHash,
            cidHash,
            stepType,
            actor,
        });
    }

    for (const l of docLogs) {
        const stepId = decodeBytes32(l.topics[2]);
        const orgIdHash = decodeBytes32(l.topics[3]);
        const words = splitWords(l.data);
        const cidHash = decodeBytes32(words[0] || "0x");
        const docType = Number(decodeUint(words[1] || "0x0"));
        const actor = decodeAddressFromWord(words[2] || "0x" + pad32("0"));

        events.push({
            kind: "DocumentAnchored",
            contract: "DocumentRegistry",
            blockNumber: hexToBigInt(l.blockNumber),
            logIndex: hexToBigInt(l.logIndex),
            txHash: l.transactionHash,
            productId,
            stepId,
            orgIdHash,
            cidHash,
            docType,
            actor,
        });
    }

    for (const l of procLogs) {
        const bn = hexToBigInt(l.blockNumber);
        const li = hexToBigInt(l.logIndex);

        if (l.topics[0].toLowerCase() === tProcessCreated.toLowerCase()) {
            const orgIdHash = decodeBytes32(l.topics[2]);
            events.push({
                kind: "ProcessCreated",
                contract: "ProcessManager",
                blockNumber: bn,
                logIndex: li,
                txHash: l.transactionHash,
                productId,
                orgIdHash,
            });
            continue;
        }

        if (l.topics[0].toLowerCase() === tProcessStatusChanged.toLowerCase()) {
            const orgIdHash = decodeBytes32(l.topics[2]);
            const words = splitWords(l.data);
            const previousStatus = Number(decodeUint(words[0] || "0x0"));
            const newStatus = Number(decodeUint(words[1] || "0x0"));
            const actor = decodeAddressFromWord(words[2] || "0x" + pad32("0"));

            events.push({
                kind: "ProcessStatusChanged",
                contract: "ProcessManager",
                blockNumber: bn,
                logIndex: li,
                txHash: l.transactionHash,
                productId,
                orgIdHash,
                previousStatus,
                newStatus,
                actor,
            });
        }
    }

    events.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
        if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
        return 0;
    });

    console.log(`\nTimestamping ${events.length} events (eth_getBlockByNumber on primary RPC)...`);
    const tsCache = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const key = e.blockNumber.toString();
        if (!tsCache.has(key)) {
            const ts = await getBlockTimestamp(primaryRpc, e.blockNumber);
            tsCache.set(key, ts);
        }
        e.timestamp = tsCache.get(key);

        if (i % 50 === 0 && i > 0) console.log(`Timestamp progress: ${i}/${events.length}`);
    }

    const requiredStepsArr = [1, 2, 3, 4, 5, 6];
    const seenSteps = new Set<number>();
    for (const e of events) if (e.kind === "CidAnchored") seenSteps.add(e.stepType);
    const missing = requiredStepsArr.filter((s) => !seenSteps.has(s));
    const completeness = missing.length === 0 ? 1 : 0;

    const summary = {
        generatedAt: new Date().toISOString(),
        productIdInput,
        productId,
        fromBlock,
        toBlock,
        counts: {
            totalEvents: events.length,
            cidAnchors: events.filter((e) => e.kind === "CidAnchored").length,
            documentAnchors: events.filter((e) => e.kind === "DocumentAnchored").length,
            processEvents: events.filter((e) => e.kind === "ProcessCreated" || e.kind === "ProcessStatusChanged").length,
        },
        completeness: {
            requiredStepTypes: requiredStepsArr.map((x) => ({ stepType: x, name: StepTypeName[x] })),
            seenStepTypes: Array.from(seenSteps).sort((a, b) => a - b).map((x) => ({ stepType: x, name: StepTypeName[x] })),
            missingStepTypes: missing.map((x) => ({ stepType: x, name: StepTypeName[x] })),
            completeness01: completeness,
        },
    };

    console.log(`\nFound ${events.length} total events for productId.`);
    console.log(`Completeness (Produced..Sold present in CidAnchored stepType set): ${completeness}\n`);

    for (const e of events) {
        const iso = e.timestamp ? new Date(e.timestamp * 1000).toISOString() : "unknown-time";
        if (e.kind === "CidAnchored") {
            console.log(
                `${iso}  [CidAnchored] stepType=${e.stepType}(${StepTypeName[e.stepType] || "?"})` +
                ` stepId=${e.stepId.slice(0, 10)}... actor=${e.actor} cidHash=${e.cidHash.slice(0, 10)}... tx=${e.txHash.slice(0, 10)}...`
            );
        } else if (e.kind === "DocumentAnchored") {
            console.log(
                `${iso}  [DocumentAnchored] docType=${e.docType} stepId=${e.stepId.slice(0, 10)}...` +
                ` actor=${e.actor} cidHash=${e.cidHash.slice(0, 10)}... tx=${e.txHash.slice(0, 10)}...`
            );
        } else if (e.kind === "ProcessCreated") {
            console.log(`${iso}  [ProcessCreated] orgIdHash=${e.orgIdHash.slice(0, 10)}... tx=${e.txHash.slice(0, 10)}...`);
        } else if (e.kind === "ProcessStatusChanged") {
            console.log(
                `${iso}  [ProcessStatusChanged] ${ProcessStatusName[e.previousStatus] || e.previousStatus} -> ${ProcessStatusName[e.newStatus] || e.newStatus}` +
                ` actor=${e.actor} tx=${e.txHash.slice(0, 10)}...`
            );
        }
    }

    const outPath =
        args.out || path.resolve(__dirname, "..", `audit_reconstruction_${productId.slice(2, 10)}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ summary, events }, null, 2));
    console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});