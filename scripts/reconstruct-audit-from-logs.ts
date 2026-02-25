// scripts/reconstruct-audit-from-logs.ts
//
// Reconstruct an auditable batch timeline from on-chain logs.
//
// Integrated workflow (WebStorm Run friendly):
// - Auto-emits a coffee supply-chain demo run (optional, default ON) if no local txs exist.
// - Stores tx hashes + metadata into a local JSON "database" (audit_local_db.json).
// - Reconstructs timeline primarily by fetching tx receipts (eth_getTransactionReceipt).
// - Avoids scanning massive block ranges; eth_getLogs is fallback-only (tiny range), default OFF.
// - NEW: Simulates "audit query" latency (receipt-based reconstruction) and prints p50/p95 table.
//
// Usage (recommended):
//   npx tsx scripts/reconstruct-audit-from-logs.ts
//   npx tsx scripts/reconstruct-audit-from-logs.ts --productId "coffee-batch-001"
//
// Optional flags:
//   --productId <string|0xbytes32>
//
//   --emitDemo <0|1>         default 1
//   --forceEmit <0|1>        default 0
//   --refreshReceipts <0|1>  default 1   (reserved; receipts are fetched each run)
//
//   --db <path>              default repo-root/audit_local_db.json
//   --out <path>             default repo-root/audit_reconstruction_<prefix>.json
//
// Fallback-only (avoid unless needed):
//   --fallbackGetLogs <0|1>  default 0
//   --chunk <n>              default 10
//   --sleepMs <n>            default 120
//   --progressEvery <n>      default 200
//
// Query latency simulation (NEW):
//   --simQuery <0|1>         default 1
//   --simWarmup <n>          default 3
//   --simRuns <n>            default 30
//   --simConcurrency <n>     default 8
//   --simReportOut <path>    default repo-root/audit_query_latency_<prefix>.json
//
// Env (.env) READ ONLY:
//   OP_SEPOLIA_RPC_URL=...
//   OP_SEPOLIA_PRIVATE_KEY=...          (required if emitDemo=1)
//   AUDIT_PRODUCT_ID=coffee-batch-001   (optional)
//
// Optional RPC lists (READ ONLY):
//   OP_SEPOLIA_PUBLIC_RPCS_JSON=[...]
//   OP_SEPOLIA_PRIVATE_RPCS_JSON=[...]
//
// Optional contract address overrides (READ ONLY):
//   ACTOR_REGISTRY_ADDRESS=0x...
//   CID_ROLLUP_ADDRESS=0x...
//   DOCUMENT_REGISTRY_ADDRESS=0x...
//   PROCESS_MANAGER_ADDRESS=0x...

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { request } from "undici";

// -------------------- Force-load .env from repo root (READ ONLY) --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// -------------------- Minimal CLI parsing --------------------
type Args = {
    productId: string;

    emitDemo?: number;
    forceEmit?: number;
    refreshReceipts?: number;

    db?: string;
    out?: string;

    fallbackGetLogs?: number;
    chunk?: number;
    sleepMs?: number;
    progressEvery?: number;

    // NEW: query latency simulation
    simQuery?: number;
    simWarmup?: number;
    simRuns?: number;
    simConcurrency?: number;
    simReportOut?: string;
};

function parseArgs(argv: string[]): Args {
    const out: Partial<Args> = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const v = argv[i + 1];

        if (a === "--productId" && v) { out.productId = v; i++; continue; }

        if (a === "--emitDemo" && v) { out.emitDemo = Number(v); i++; continue; }
        if (a === "--forceEmit" && v) { out.forceEmit = Number(v); i++; continue; }
        if (a === "--refreshReceipts" && v) { out.refreshReceipts = Number(v); i++; continue; }

        if (a === "--db" && v) { out.db = v; i++; continue; }
        if (a === "--out" && v) { out.out = v; i++; continue; }

        if (a === "--fallbackGetLogs" && v) { out.fallbackGetLogs = Number(v); i++; continue; }
        if (a === "--chunk" && v) { out.chunk = Number(v); i++; continue; }
        if (a === "--sleepMs" && v) { out.sleepMs = Number(v); i++; continue; }
        if (a === "--progressEvery" && v) { out.progressEvery = Number(v); i++; continue; }

        // NEW: sim flags
        if (a === "--simQuery" && v) { out.simQuery = Number(v); i++; continue; }
        if (a === "--simWarmup" && v) { out.simWarmup = Number(v); i++; continue; }
        if (a === "--simRuns" && v) { out.simRuns = Number(v); i++; continue; }
        if (a === "--simConcurrency" && v) { out.simConcurrency = Number(v); i++; continue; }
        if (a === "--simReportOut" && v) { out.simReportOut = v; i++; continue; }
    }

    if (!out.productId) {
        const envDefault = (process.env.AUDIT_PRODUCT_ID || "").trim();
        out.productId = envDefault || "coffee-batch-001";
    }

    return out as Args;
}

function mustEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var: ${name}`);
    return v.trim();
}

function toHexQty(n: number | bigint): string {
    const b = typeof n === "bigint" ? n : BigInt(n);
    if (b < 0n) throw new Error("toHexQty: negative");
    return "0x" + b.toString(16);
}
function hexToBigInt(h: string): bigint { return BigInt(h); }

// -------------------- JSON helpers (BigInt safe) --------------------
function jsonReplacer(_k: string, v: any) {
    return typeof v === "bigint" ? v.toString() : v;
}
function writeJsonFile(filePath: string, obj: any) {
    fs.writeFileSync(filePath, JSON.stringify(obj, jsonReplacer, 2));
}

// -------------------- timing helpers --------------------
function nowNs(): bigint { return process.hrtime.bigint(); }
function nsToMs(ns: bigint): number { return Number(ns) / 1e6; }

function percentile(values: number[], p: number): number {
    if (values.length === 0) return NaN;
    const s = [...values].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
    return s[idx];
}

function summarize(values: number[]) {
    const n = values.length;
    const mean = n ? values.reduce((a, b) => a + b, 0) / n : NaN;
    return {
        n,
        min: n ? Math.min(...values) : NaN,
        max: n ? Math.max(...values) : NaN,
        mean,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
    };
}

function printTable(title: string, rows: Array<{ k: string; v: string }>) {
    const kW = Math.max(...rows.map(r => r.k.length), 10);
    console.log(`\n${title}`);
    console.log("-".repeat(Math.max(40, kW + 20)));
    for (const r of rows) {
        console.log(`${r.k.padEnd(kW)}  ${r.v}`);
    }
}

// -------------------- hashing --------------------
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

async function normalizeProductId(input: string): Promise<string> {
    const t = input.trim();
    if (t.startsWith("0x") && t.length === 66) return t.toLowerCase();
    return (await keccakUtf8ToBytes32(t)).toLowerCase();
}

function normalizeHexAddress(addr: string): string {
    if (!addr) throw new Error("Empty address");
    const a = addr.trim();
    if (!a.startsWith("0x") || a.length !== 42) throw new Error(`Bad address: ${addr}`);
    return a;
}

async function topic0(sig: string): Promise<string> {
    return (await keccakUtf8ToBytes32(sig)).toLowerCase();
}

// -------------------- RPC --------------------
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
    try { parsed = JSON.parse(text); }
    catch { throw new Error(`RPC non-JSON response: ${text.slice(0, 600)}`); }
    if (parsed.error) {
        throw new Error(`RPC error (${method}): ${JSON.stringify(parsed.error).slice(0, 600)}`);
    }
    return parsed.result;
}

type TxReceipt = {
    transactionHash: string;
    blockNumber: string; // hex qty
    logs: Array<{
        address: string;
        topics: string[];
        data: string;
        blockNumber: string;
        transactionHash: string;
        logIndex: string;
    }>;
};

async function getTxReceipt(rpcUrl: string, txHash: string): Promise<TxReceipt | null> {
    const r = await rpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
    return r ?? null;
}

async function getBlockTimestamp(rpcUrl: string, blockNumber: bigint): Promise<number> {
    const blk = await rpc(rpcUrl, "eth_getBlockByNumber", [toHexQty(blockNumber), false]);
    return Number(hexToBigInt(blk.timestamp));
}

// -------------------- Log decoding (NO ABI) --------------------
function decodeBytes32(wordHex: string): string {
    if (!wordHex?.startsWith("0x") || wordHex.length !== 66) return wordHex;
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
    contract: "CidRollup";
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
}
    | {
    kind: "DocumentAnchored";
    contract: "DocumentRegistry";
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
}
    | {
    kind: "ProcessCreated";
    contract: "ProcessManager";
    blockNumber: bigint;
    logIndex: bigint;
    txHash: string;
    timestamp?: number;
    productId: string;
    orgIdHash: string;
}
    | {
    kind: "ProcessStatusChanged";
    contract: "ProcessManager";
    blockNumber: bigint;
    logIndex: bigint;
    txHash: string;
    timestamp?: number;
    productId: string;
    orgIdHash: string;
    previousStatus: number;
    newStatus: number;
    actor: string;
};

function decodeLogsToEvents(params: {
    logs: TxReceipt["logs"];
    productId: string;
    tCidAnchored: string;
    tDocAnchored: string;
    tProcessCreated: string;
    tProcessStatusChanged: string;
}): AuditEvent[] {
    const { logs, productId, tCidAnchored, tDocAnchored, tProcessCreated, tProcessStatusChanged } = params;

    const events: AuditEvent[] = [];

    for (const l of logs) {
        const t0 = (l.topics?.[0] || "").toLowerCase();
        const topicProduct = (l.topics?.[1] || "").toLowerCase();

        if (topicProduct !== productId.toLowerCase()) continue;

        if (t0 === tCidAnchored.toLowerCase()) {
            const stepId = decodeBytes32(l.topics[2]);
            const orgIdHash = decodeBytes32(l.topics[3]);
            const words = splitWords(l.data);
            const cidHash = decodeBytes32(words[0] || "0x");
            const stepType = Number(decodeUint(words[1] || "0x0"));
            const actor = decodeAddressFromWord(words[2] || "0x" + "0".repeat(64));

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
            continue;
        }

        if (t0 === tDocAnchored.toLowerCase()) {
            const stepId = decodeBytes32(l.topics[2]);
            const orgIdHash = decodeBytes32(l.topics[3]);
            const words = splitWords(l.data);
            const cidHash = decodeBytes32(words[0] || "0x");
            const docType = Number(decodeUint(words[1] || "0x0"));
            const actor = decodeAddressFromWord(words[2] || "0x" + "0".repeat(64));

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
            continue;
        }

        if (t0 === tProcessCreated.toLowerCase()) {
            const orgIdHash = decodeBytes32(l.topics[2]);
            events.push({
                kind: "ProcessCreated",
                contract: "ProcessManager",
                blockNumber: hexToBigInt(l.blockNumber),
                logIndex: hexToBigInt(l.logIndex),
                txHash: l.transactionHash,
                productId,
                orgIdHash,
            });
            continue;
        }

        if (t0 === tProcessStatusChanged.toLowerCase()) {
            const orgIdHash = decodeBytes32(l.topics[2]);
            const words = splitWords(l.data);
            const previousStatus = Number(decodeUint(words[0] || "0x0"));
            const newStatus = Number(decodeUint(words[1] || "0x0"));
            const actor = decodeAddressFromWord(words[2] || "0x" + "0".repeat(64));

            events.push({
                kind: "ProcessStatusChanged",
                contract: "ProcessManager",
                blockNumber: hexToBigInt(l.blockNumber),
                logIndex: hexToBigInt(l.logIndex),
                txHash: l.transactionHash,
                productId,
                orgIdHash,
                previousStatus,
                newStatus,
                actor,
            });
            continue;
        }
    }

    return events;
}

// -------------------- Local DB (single JSON file, 0 deps) --------------------
type LocalDbTx = {
    txHash: string;
    purpose: string;
    createdAt: string;
};

type LocalDbProduct = {
    productIdInput: string;
    productId: string; // bytes32
    createdAt: string;
    contractAddresses: {
        ActorRegistry: string;
        CidRollup: string;
        DocumentRegistry: string;
        ProcessManager: string;
    };
    txs: LocalDbTx[];
    observed: { minBlock?: number; maxBlock?: number };
};

type LocalDb = {
    version: number;
    generatedAt: string;
    products: Record<string, LocalDbProduct>;
};

function loadDb(dbPath: string): LocalDb {
    if (!fs.existsSync(dbPath)) {
        return { version: 1, generatedAt: new Date().toISOString(), products: {} };
    }
    try {
        const raw = fs.readFileSync(dbPath, "utf8");
        const j = JSON.parse(raw);
        if (!j || typeof j !== "object") throw new Error("bad db json");
        if (!j.products) j.products = {};
        return j as LocalDb;
    } catch {
        return { version: 1, generatedAt: new Date().toISOString(), products: {} };
    }
}

function saveDb(dbPath: string, db: LocalDb) {
    db.generatedAt = new Date().toISOString();
    writeJsonFile(dbPath, db);
}

function upsertProduct(db: LocalDb, p: LocalDbProduct) {
    db.products[p.productId] = p;
}

function addTx(p: LocalDbProduct, txHash: string, purpose: string) {
    const h = txHash.toLowerCase();
    if (!p.txs.find((t) => t.txHash.toLowerCase() === h)) {
        p.txs.push({ txHash, purpose, createdAt: new Date().toISOString() });
    }
}

// -------------------- Emit demo supply-chain ON-CHAIN (integrated) --------------------
async function emitCoffeeSupplyChainIfNeeded(params: {
    primaryRpc: string;
    productIdInput: string;
    productId: string;
    dbPath: string;
    db: LocalDb;
    emitDemo: boolean;
    forceEmit: boolean;
    contractAddresses: {
        ActorRegistry: string;
        CidRollup: string;
        DocumentRegistry: string;
        ProcessManager: string;
    };
}): Promise<void> {
    const { primaryRpc, productIdInput, productId, dbPath, db, emitDemo, forceEmit, contractAddresses } = params;

    const existing = db.products[productId];
    const alreadyHasTxs = !!existing && existing.txs && existing.txs.length > 0;

    if (!emitDemo) return;
    if (alreadyHasTxs && !forceEmit) {
        console.log(`[emitDemo] DB already has ${existing!.txs.length} tx(s) for productId; skipping emit.`);
        return;
    }

    let ethersAny: any;
    try { ethersAny = await import("ethers"); }
    catch { throw new Error("emitDemo requires ethers installed."); }
    const ethers = ethersAny.ethers ? ethersAny.ethers : ethersAny;

    const pk = process.env.OP_SEPOLIA_PRIVATE_KEY ? process.env.OP_SEPOLIA_PRIVATE_KEY.trim() : "";
    if (!pk) {
        throw new Error("emitDemo=1 but OP_SEPOLIA_PRIVATE_KEY is missing. Set it in .env or run with --emitDemo 0.");
    }

    const provider = new ethers.JsonRpcProvider(primaryRpc);
    const wallet = new ethers.Wallet(pk, provider);

    console.log(`\n[emitDemo] Emitting coffee supply-chain events as wallet=${wallet.address}`);

    const actorRegistryAbi = [
        "function owner() view returns (address)",
        "function isActiveActor(address) view returns (bool)",
        "function registerActor(bytes32 orgIdHash, address wallet, uint8 role, bytes32 metadataHash)",
    ];
    const cidRollupAbi = [
        "function submitCidBatch(tuple(bytes32 productId, bytes32 stepId, bytes32 cidHash, uint8 stepType)[] events)",
    ];
    const docRegistryAbi = [
        "function anchorDocument(bytes32 productId, bytes32 stepId, bytes32 cidHash, uint8 docType)",
    ];
    const processManagerAbi = [
        "function createProcess(bytes32 productId)",
        "function advanceStatus(bytes32 productId, uint8 newStatus)",
    ];

    const actorRegistry = new ethers.Contract(contractAddresses.ActorRegistry, actorRegistryAbi, wallet);
    const cidRollup = new ethers.Contract(contractAddresses.CidRollup, cidRollupAbi, wallet);
    const docRegistry = new ethers.Contract(contractAddresses.DocumentRegistry, docRegistryAbi, wallet);
    const processManager = new ethers.Contract(contractAddresses.ProcessManager, processManagerAbi, wallet);

    const isActive = await actorRegistry.isActiveActor(wallet.address);
    if (!isActive) {
        const owner = (await actorRegistry.owner()) as string;
        if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
            throw new Error(
                [
                    "[emitDemo] Wallet is NOT registered AND is not ActorRegistry.owner(), so it can't self-register.",
                    `ActorRegistry.owner() = ${owner}`,
                    `Your wallet           = ${wallet.address}`,
                    "",
                    "Fix options:",
                    "  1) Use the ActorRegistry owner key as OP_SEPOLIA_PRIVATE_KEY, run once to register this wallet.",
                    "  2) Or register this wallet from the owner elsewhere, then rerun.",
                ].join("\n")
            );
        }

        const orgIdHash = ethers.id(`org:${wallet.address}`).toLowerCase();
        const metadataHash = ethers.id(`meta:${wallet.address}`).toLowerCase();
        const roleProducer = 1;

        console.log("[emitDemo] Registering actor (Producer)...");
        const tx = await actorRegistry.registerActor(orgIdHash, wallet.address, roleProducer, metadataHash);
        console.log(`[emitDemo] registerActor tx=${tx.hash}`);
        await tx.wait();
    }

    console.log("[emitDemo] createProcess (skip if exists)...");
    try {
        const tx = await processManager.createProcess(productId);
        console.log(`[emitDemo] createProcess tx=${tx.hash}`);
        await tx.wait();
    } catch (e: any) {
        console.log(`[emitDemo] createProcess skipped: ${String(e?.message ?? e).slice(0, 140)}`);
    }

    const runNonce = Date.now();
    const stepTypes = [1, 2, 3, 4, 5, 6];
    const stepNames: Record<number, string> = {
        1: "Produced", 2: "Processed", 3: "Shipped", 4: "Received", 5: "AtRetail", 6: "Sold",
    };
    const mkStepId = (name: string) => ethers.id(`step:${productId}:${name}:${runNonce}`).toLowerCase();
    const mkCidHash = (name: string) => ethers.id(`cid:${productId}:${name}:${runNonce}`).toLowerCase();

    const cidEvents = stepTypes.map((st) => ({
        productId,
        stepId: mkStepId(stepNames[st]),
        cidHash: mkCidHash(stepNames[st]),
        stepType: st,
    }));

    console.log("[emitDemo] submitCidBatch (6 steps)...");
    const txBatch = await cidRollup.submitCidBatch(cidEvents);
    console.log(`[emitDemo] submitCidBatch tx=${txBatch.hash}`);
    const rcBatch = await txBatch.wait();

    console.log("[emitDemo] anchorDocument (6 docs)...");
    const docTxs: string[] = [];
    for (const ev of cidEvents) {
        const docType = ev.stepType;
        const docCidHash = mkCidHash(`DOC:${stepNames[ev.stepType]}`);
        const tx = await docRegistry.anchorDocument(ev.productId, ev.stepId, docCidHash, docType);
        docTxs.push(tx.hash);
        console.log(`[emitDemo] anchorDocument(${stepNames[ev.stepType]}) tx=${tx.hash}`);
        await tx.wait();
    }

    console.log("[emitDemo] advanceStatus Created->InTransit->AtRetail->Sold...");
    const statusTxs: string[] = [];
    for (const s of [2, 3, 4]) {
        const tx = await processManager.advanceStatus(productId, s);
        statusTxs.push(tx.hash);
        console.log(`[emitDemo] advanceStatus(${s}) tx=${tx.hash}`);
        await tx.wait();
    }

    const p: LocalDbProduct =
        existing || ({
            productIdInput,
            productId,
            createdAt: new Date().toISOString(),
            contractAddresses,
            txs: [],
            observed: {},
        } as LocalDbProduct);

    addTx(p, txBatch.hash, "CidRollup.submitCidBatch (Produced..Sold)");
    for (const h of docTxs) addTx(p, h, "DocumentRegistry.anchorDocument");
    for (const h of statusTxs) addTx(p, h, "ProcessManager.advanceStatus");

    const bn = Number(hexToBigInt(rcBatch.blockNumber));
    p.observed.minBlock = p.observed.minBlock !== undefined ? Math.min(p.observed.minBlock, bn) : bn;
    p.observed.maxBlock = p.observed.maxBlock !== undefined ? Math.max(p.observed.maxBlock, bn) : bn;

    upsertProduct(db, p);
    saveDb(dbPath, db);

    console.log(`[emitDemo] ✅ emitted + stored txs to DB: ${dbPath}\n`);
}

// -------------------- concurrency helper --------------------
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, idx: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;

    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    }

    const workers = Array.from({ length: Math.max(1, Math.floor(limit)) }, () => worker());
    await Promise.all(workers);
    return out;
}

// -------------------- query simulation core --------------------
type QueryRun = {
    total_ms: number;
    phase_ms: {
        receipts_ms: number;
        decode_ms: number;
        sort_ms: number;
        timestamps_ms: number;
        output_ms: number;
    };
    txCount: number;
    eventCount: number;
    uniqueBlocks: number;
};

function sortEvents(events: AuditEvent[]) {
    events.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
        if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
        return 0;
    });
}

async function runAuditQueryOnce(params: {
    primaryRpc: string;
    productId: string;
    txs: LocalDbTx[];
    tCidAnchored: string;
    tDocAnchored: string;
    tProcessCreated: string;
    tProcessStatusChanged: string;
    concurrency: number;
    // caches (optional)
    receiptCache?: Map<string, TxReceipt | null>;
    tsCache?: Map<string, number>;
}): Promise<QueryRun> {
    const {
        primaryRpc, productId, txs, tCidAnchored, tDocAnchored, tProcessCreated, tProcessStatusChanged,
        concurrency, receiptCache, tsCache
    } = params;

    const tStart = nowNs();

    // 1) receipts
    const tR0 = nowNs();
    const receipts = await mapLimit(txs, concurrency, async (t) => {
        const k = t.txHash.toLowerCase();
        if (receiptCache && receiptCache.has(k)) return receiptCache.get(k)!;
        const rc = await getTxReceipt(primaryRpc, t.txHash);
        if (receiptCache) receiptCache.set(k, rc);
        return rc;
    });
    const receiptsMs = nsToMs(nowNs() - tR0);

    // 2) decode
    const tD0 = nowNs();
    const events: AuditEvent[] = [];
    for (const rc of receipts) {
        if (!rc) continue;
        events.push(...decodeLogsToEvents({
            logs: rc.logs,
            productId,
            tCidAnchored,
            tDocAnchored,
            tProcessCreated,
            tProcessStatusChanged,
        }));
    }
    const decodeMs = nsToMs(nowNs() - tD0);

    // 3) sort
    const tS0 = nowNs();
    sortEvents(events);
    const sortMs = nsToMs(nowNs() - tS0);

    // 4) timestamps
    const tT0 = nowNs();
    const localTsCache = tsCache ?? new Map<string, number>();
    const blocks = new Set<string>();
    for (const e of events) blocks.add(e.blockNumber.toString());

    const blockList = Array.from(blocks);
    await mapLimit(blockList, concurrency, async (b) => {
        if (localTsCache.has(b)) return;
        const ts = await getBlockTimestamp(primaryRpc, BigInt(b));
        localTsCache.set(b, ts);
    });

    for (const e of events) e.timestamp = localTsCache.get(e.blockNumber.toString());
    const timestampsMs = nsToMs(nowNs() - tT0);

    // 5) output (simulate payload formatting cost; avoid disk writes during simulation)
    const tO0 = nowNs();
    // tiny “format” step to avoid “doing nothing”
    const _preview = events.slice(0, 3).map(e => `${e.kind}:${e.txHash.slice(0, 10)}`).join("|");
    void _preview;
    const outputMs = nsToMs(nowNs() - tO0);

    const totalMs = nsToMs(nowNs() - tStart);

    return {
        total_ms: totalMs,
        phase_ms: {
            receipts_ms: receiptsMs,
            decode_ms: decodeMs,
            sort_ms: sortMs,
            timestamps_ms: timestampsMs,
            output_ms: outputMs,
        },
        txCount: txs.length,
        eventCount: events.length,
        uniqueBlocks: blockList.length,
    };
}

async function simulateAuditQueryLatency(params: {
    primaryRpc: string;
    productId: string;
    txs: LocalDbTx[];
    tCidAnchored: string;
    tDocAnchored: string;
    tProcessCreated: string;
    tProcessStatusChanged: string;
    warmup: number;
    runs: number;
    concurrency: number;
    reportOutPath: string;
}): Promise<void> {
    const {
        primaryRpc, productId, txs, tCidAnchored, tDocAnchored, tProcessCreated, tProcessStatusChanged,
        warmup, runs, concurrency, reportOutPath
    } = params;

    if (!txs.length) {
        console.log("\n[simQuery] No txs in DB; skipping query latency simulation.");
        return;
    }

    console.log(`\n[simQuery] Running audit query latency simulation...`);
    console.log(`[simQuery] warmup=${warmup} runs=${runs} concurrency=${concurrency}`);
    console.log(`[simQuery] mode A: COLD (no caches)`);
    console.log(`[simQuery] mode B: HOT  (receipt+timestamp caches)`);

    async function doMode(mode: "cold" | "hot") {
        const totals: number[] = [];
        const receipts: number[] = [];
        const decode: number[] = [];
        const sort: number[] = [];
        const ts: number[] = [];

        const receiptCache = mode === "hot" ? new Map<string, TxReceipt | null>() : undefined;
        const tsCache = mode === "hot" ? new Map<string, number>() : undefined;

        // warmup
        for (let i = 0; i < warmup; i++) {
            await runAuditQueryOnce({
                primaryRpc, productId, txs,
                tCidAnchored, tDocAnchored, tProcessCreated, tProcessStatusChanged,
                concurrency,
                receiptCache, tsCache
            });
        }

        // measured runs
        const runDetails: QueryRun[] = [];
        for (let i = 0; i < runs; i++) {
            const r = await runAuditQueryOnce({
                primaryRpc, productId, txs,
                tCidAnchored, tDocAnchored, tProcessCreated, tProcessStatusChanged,
                concurrency,
                receiptCache, tsCache
            });
            runDetails.push(r);
            totals.push(r.total_ms);
            receipts.push(r.phase_ms.receipts_ms);
            decode.push(r.phase_ms.decode_ms);
            sort.push(r.phase_ms.sort_ms);
            ts.push(r.phase_ms.timestamps_ms);
        }

        return {
            mode,
            runDetails,
            totals: summarize(totals),
            phases: {
                receipts: summarize(receipts),
                decode: summarize(decode),
                sort: summarize(sort),
                timestamps: summarize(ts),
            },
            payload: {
                txCount: runDetails[0]?.txCount ?? txs.length,
                eventCount: runDetails[0]?.eventCount ?? NaN,
                uniqueBlocks: runDetails[0]?.uniqueBlocks ?? NaN,
            }
        };
    }

    const cold = await doMode("cold");
    const hot = await doMode("hot");

    // print terminal tables
    printTable("[simQuery] Summary (COLD)", [
        { k: "runs", v: `${cold.totals.n}` },
        { k: "tx / events / blocks", v: `${cold.payload.txCount} / ${cold.payload.eventCount} / ${cold.payload.uniqueBlocks}` },
        { k: "total_ms p50", v: `${cold.totals.p50.toFixed(2)}` },
        { k: "total_ms p95", v: `${cold.totals.p95.toFixed(2)}` },
        { k: "total_ms mean", v: `${cold.totals.mean.toFixed(2)}` },
        { k: "total_ms max", v: `${cold.totals.max.toFixed(2)}` },
    ]);

    printTable("[simQuery] Phase means (COLD)", [
        { k: "receipts_ms mean", v: `${cold.phases.receipts.mean.toFixed(2)}` },
        { k: "decode_ms mean", v: `${cold.phases.decode.mean.toFixed(2)}` },
        { k: "sort_ms mean", v: `${cold.phases.sort.mean.toFixed(2)}` },
        { k: "timestamps_ms mean", v: `${cold.phases.timestamps.mean.toFixed(2)}` },
    ]);

    printTable("[simQuery] Summary (HOT)", [
        { k: "runs", v: `${hot.totals.n}` },
        { k: "tx / events / blocks", v: `${hot.payload.txCount} / ${hot.payload.eventCount} / ${hot.payload.uniqueBlocks}` },
        { k: "total_ms p50", v: `${hot.totals.p50.toFixed(2)}` },
        { k: "total_ms p95", v: `${hot.totals.p95.toFixed(2)}` },
        { k: "total_ms mean", v: `${hot.totals.mean.toFixed(2)}` },
        { k: "total_ms max", v: `${hot.totals.max.toFixed(2)}` },
    ]);

    printTable("[simQuery] Phase means (HOT)", [
        { k: "receipts_ms mean", v: `${hot.phases.receipts.mean.toFixed(2)}` },
        { k: "decode_ms mean", v: `${hot.phases.decode.mean.toFixed(2)}` },
        { k: "sort_ms mean", v: `${hot.phases.sort.mean.toFixed(2)}` },
        { k: "timestamps_ms mean", v: `${hot.phases.timestamps.mean.toFixed(2)}` },
    ]);

    const report = {
        generatedAt: new Date().toISOString(),
        productId,
        txCount: txs.length,
        warmup,
        runs,
        concurrency,
        cold: {
            totals: cold.totals,
            phases: cold.phases,
            payload: cold.payload,
        },
        hot: {
            totals: hot.totals,
            phases: hot.phases,
            payload: hot.payload,
        },
        note: "Latency is measured for receipt-based reconstruction (DB tx list -> eth_getTransactionReceipt -> decode -> eth_getBlockByNumber timestamps).",
    };

    writeJsonFile(reportOutPath, report);
    console.log(`\n[simQuery] Wrote latency report: ${reportOutPath}\n`);
}

// -------------------- Main (existing behavior + sim) --------------------
async function main() {
    const args = parseArgs(process.argv);

    const primaryRpc = mustEnv("OP_SEPOLIA_RPC_URL");
    const productIdInput = args.productId;
    const productId = await normalizeProductId(productIdInput);

    const ACTOR_REGISTRY_ADDRESS = normalizeHexAddress(
        (process.env.ACTOR_REGISTRY_ADDRESS || "0xFb451B3Bfb497C54719d0DB354a502a9D9cE38C1").trim()
    );
    const CID_ROLLUP_ADDRESS = normalizeHexAddress(
        (process.env.CID_ROLLUP_ADDRESS || "0xC6d171F707bA43BdF490362a357D975B76976264").trim()
    );
    const DOCUMENT_REGISTRY_ADDRESS = normalizeHexAddress(
        (process.env.DOCUMENT_REGISTRY_ADDRESS || "0xBEb8140eeaf2f23916dA88F8F0886827a0f5145c").trim()
    );
    const PROCESS_MANAGER_ADDRESS = normalizeHexAddress(
        (process.env.PROCESS_MANAGER_ADDRESS || "0xeD7AA6c4B1fA3FFCEC378dcFEAc0406540F5078c").trim()
    );

    const dbPath = args.db ? path.resolve(args.db) : path.resolve(__dirname, "..", "audit_local_db.json");

    const emitDemo = (args.emitDemo ?? 1) === 1;
    const forceEmit = (args.forceEmit ?? 0) === 1;
    const refreshReceipts = (args.refreshReceipts ?? 1) === 1; // reserved

    const fallbackGetLogs = (args.fallbackGetLogs ?? 0) === 1;
    const chunk = args.chunk ?? 10;
    const sleepMs = args.sleepMs ?? 120;
    const progressEvery = args.progressEvery ?? 200;

    const simQuery = (args.simQuery ?? 1) === 1;
    const simWarmup = args.simWarmup ?? 3;
    const simRuns = args.simRuns ?? 30;
    const simConcurrency = args.simConcurrency ?? 8;

    const tCidAnchored = await topic0("CidAnchored(bytes32,bytes32,bytes32,uint8,bytes32,address)");
    const tDocAnchored = await topic0("DocumentAnchored(bytes32,bytes32,bytes32,uint8,bytes32,address)");
    const tProcessCreated = await topic0("ProcessCreated(bytes32,bytes32)");
    const tProcessStatusChanged = await topic0("ProcessStatusChanged(bytes32,uint8,uint8,bytes32,address)");

    console.log(`Loaded .env from: ${path.resolve(__dirname, "..", ".env")}`);
    console.log(`RPC (primary): ${primaryRpc}`);
    console.log(`productId input: ${productIdInput}`);
    console.log(`productId (bytes32): ${productId}`);
    console.log(`DB: ${dbPath}`);
    console.log(`emitDemo=${emitDemo ? "ON" : "OFF"} forceEmit=${forceEmit ? "ON" : "OFF"} refreshReceipts=${refreshReceipts ? "ON" : "OFF"}`);
    console.log(`fallbackGetLogs=${fallbackGetLogs ? "ON" : "OFF"} chunk=${chunk} sleepMs=${sleepMs}`);
    console.log(`simQuery=${simQuery ? "ON" : "OFF"} simWarmup=${simWarmup} simRuns=${simRuns} simConcurrency=${simConcurrency}`);
    console.log(`ActorRegistry: ${ACTOR_REGISTRY_ADDRESS}`);
    console.log(`CidRollup: ${CID_ROLLUP_ADDRESS}`);
    console.log(`DocumentRegistry: ${DOCUMENT_REGISTRY_ADDRESS}`);
    console.log(`ProcessManager: ${PROCESS_MANAGER_ADDRESS}\n`);

    const db = loadDb(dbPath);

    await emitCoffeeSupplyChainIfNeeded({
        primaryRpc,
        productIdInput,
        productId,
        dbPath,
        db,
        emitDemo,
        forceEmit,
        contractAddresses: {
            ActorRegistry: ACTOR_REGISTRY_ADDRESS,
            CidRollup: CID_ROLLUP_ADDRESS,
            DocumentRegistry: DOCUMENT_REGISTRY_ADDRESS,
            ProcessManager: PROCESS_MANAGER_ADDRESS,
        },
    });

    const db2 = loadDb(dbPath);
    const prod = db2.products[productId];

    // ---- reconstruct once (existing behavior) ----
    const events: AuditEvent[] = [];
    const seenTx = new Set<string>();

    if (prod?.txs?.length) {
        console.log(`\nReconstructing from ${prod.txs.length} tx receipt(s) (NO block scanning)...`);

        for (const t of prod.txs) {
            const txh = t.txHash.toLowerCase();
            if (seenTx.has(txh)) continue;
            seenTx.add(txh);

            const rc = await getTxReceipt(primaryRpc, t.txHash);
            if (!rc) {
                console.log(`Receipt not found yet for tx=${t.txHash} (pending?)`);
                continue;
            }

            const bn = Number(hexToBigInt(rc.blockNumber));
            prod.observed.minBlock = prod.observed.minBlock !== undefined ? Math.min(prod.observed.minBlock, bn) : bn;
            prod.observed.maxBlock = prod.observed.maxBlock !== undefined ? Math.max(prod.observed.maxBlock, bn) : bn;

            const decoded = decodeLogsToEvents({
                logs: rc.logs,
                productId,
                tCidAnchored,
                tDocAnchored,
                tProcessCreated,
                tProcessStatusChanged,
            });
            events.push(...decoded);

            console.log(`- tx=${t.txHash.slice(0, 10)}... purpose="${t.purpose}" logsDecoded=${decoded.length} block=${bn}`);
        }

        db2.products[productId] = prod;
        saveDb(dbPath, db2);
    } else {
        console.log(`No local DB txs for productId=${productId}.`);
        console.log(`If you want auto-emit, ensure emitDemo=1 and OP_SEPOLIA_PRIVATE_KEY is present.`);
    }

    // sort
    sortEvents(events);

    // timestamps
    console.log(`\nTimestamping ${events.length} event(s) (primary RPC only)...`);
    const tsCache = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const key = e.blockNumber.toString();
        if (!tsCache.has(key)) {
            const ts = await getBlockTimestamp(primaryRpc, e.blockNumber);
            tsCache.set(key, ts);
        }
        e.timestamp = tsCache.get(key);
        if (i > 0 && i % 50 === 0) console.log(`Timestamp progress: ${i}/${events.length}`);
    }

    // completeness
    const requiredStepsArr = [1, 2, 3, 4, 5, 6];
    const seenSteps = new Set<number>();
    for (const e of events) if (e.kind === "CidAnchored") seenSteps.add(e.stepType);
    const missing = requiredStepsArr.filter((s) => !seenSteps.has(s));
    const completeness = missing.length === 0 ? 1 : 0;

    const summary = {
        generatedAt: new Date().toISOString(),
        productIdInput,
        productId,
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
        localDb: prod ? { dbPath, txCount: prod.txs.length, observed: prod.observed } : { dbPath, txCount: 0 },
    };

    console.log(`\nFound ${events.length} total event(s) for productId.`);
    console.log(`Completeness (Produced..Sold present in CidAnchored stepType set): ${completeness}\n`);

    for (const e of events) {
        const iso = e.timestamp ? new Date(e.timestamp * 1000).toISOString() : "unknown-time";
        if (e.kind === "CidAnchored") {
            console.log(
                `${iso}  [CidAnchored] stepType=${e.stepType}(${StepTypeName[e.stepType] || "?"}) stepId=${e.stepId.slice(0, 10)}... actor=${e.actor} cidHash=${e.cidHash.slice(0, 10)}... tx=${e.txHash.slice(0, 10)}...`
            );
        } else if (e.kind === "DocumentAnchored") {
            console.log(
                `${iso}  [DocumentAnchored] docType=${e.docType} stepId=${e.stepId.slice(0, 10)}... actor=${e.actor} cidHash=${e.cidHash.slice(0, 10)}... tx=${e.txHash.slice(0, 10)}...`
            );
        } else if (e.kind === "ProcessCreated") {
            console.log(`${iso}  [ProcessCreated] orgIdHash=${e.orgIdHash.slice(0, 10)}... tx=${e.txHash.slice(0, 10)}...`);
        } else if (e.kind === "ProcessStatusChanged") {
            console.log(
                `${iso}  [ProcessStatusChanged] ${ProcessStatusName[e.previousStatus] || e.previousStatus} -> ${ProcessStatusName[e.newStatus] || e.newStatus} actor=${e.actor} tx=${e.txHash.slice(0, 10)}...`
            );
        }
    }

    const outPath = args.out || path.resolve(__dirname, "..", `audit_reconstruction_${productId.slice(2, 10)}.json`);
    writeJsonFile(outPath, { summary, events });
    console.log(`\nWrote ${outPath}`);
    console.log(`Local DB: ${dbPath}`);

    // ---- NEW: simulate query latency and print performance table ----
    if (simQuery && prod?.txs?.length) {
        const reportOutPath =
            args.simReportOut
                ? path.resolve(args.simReportOut)
                : path.resolve(__dirname, "..", `audit_query_latency_${productId.slice(2, 10)}.json`);

        await simulateAuditQueryLatency({
            primaryRpc,
            productId,
            txs: prod.txs,
            tCidAnchored,
            tDocAnchored,
            tProcessCreated,
            tProcessStatusChanged,
            warmup: simWarmup,
            runs: simRuns,
            concurrency: simConcurrency,
            reportOutPath,
        });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});