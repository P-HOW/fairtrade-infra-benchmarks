// scripts/sim-filebase-evidence.ts

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { request } from "undici";
import { fileURLToPath } from "url";

// --- Force-load .env from repo root (../.env relative to scripts/) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// Runtime import; TS types may warn, runtime is fine.
import { of as ipfsOnlyHashOf } from "ipfs-only-hash";

type Trial = {
    idx: number;
    sizeBytes: number;
    cid?: string;
    expectedCid?: string;
    uploadMs?: number;
    fetchMs?: number;
    fetchOk?: boolean;
    cidMatch?: boolean;
    error?: string;
    authUsed?: string;
};

function mustEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var: ${name}`);
    return v;
}

function getEndpoint(): { endpoint: string; usedKey: string } {
    const a = process.env.FILEBASE_IPFS_RPC_ENDPOINT?.trim();
    if (a) return { endpoint: a, usedKey: "FILEBASE_IPFS_RPC_ENDPOINT" };

    const b = process.env.FILEBASE_IPFS_RPC_ENDPOINT?.trim();
    if (b) return { endpoint: b, usedKey: "FILEBASE_IPFS_RPC_ENDPOINT" };

    throw new Error("Missing env var: FILEBASE_IPFS_RPC_ENDPOINT");
}

function getAuthHeaderCandidates(): string[] {
    const t = (process.env.FILEBASE_IPFS_RPC_AUTH_TYPE || "").toLowerCase().trim();
    if (!t) return [];

    if (t === "bearer") {
        const token = mustEnv("FILEBASE_IPFS_RPC_TOKEN").trim();
        return [`Bearer ${token}`];
    }

    if (t === "basic") {
        const key = mustEnv("FILEBASE_S3_KEY").trim();
        const secret = mustEnv("FILEBASE_S3_SECRET").trim();
        const b64 = Buffer.from(`${key}:${secret}`).toString("base64");
        return [`Basic ${b64}`];
    }

    if (t === "token") {
        const token = mustEnv("FILEBASE_IPFS_RPC_TOKEN").trim();
        return [`Bearer ${token}`, `Basic ${token}`];
    }

    throw new Error(`Unsupported FILEBASE_IPFS_RPC_AUTH_TYPE="${t}" (use bearer|basic|token)`);
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return NaN;
    const s = [...values].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
    return s[idx];
}

function buildMultipartBody(fileBytes: Buffer) {
    const boundary = `----ftboundary${randomBytes(8).toString("hex")}`;
    const head =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="evidence.bin"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(head, "utf8"), fileBytes, Buffer.from(tail, "utf8")]);
    return { boundary, body };
}

async function ipfsAdd(endpoint: string, authHeader: string | undefined, bytes: Buffer) {
    const { boundary, body } = buildMultipartBody(bytes);
    const url = new URL("/api/v0/add", endpoint);

    // Match Filebase/go-ipfs defaults more closely
    url.searchParams.set("pin", "true");
    url.searchParams.set("cid-version", "1");
    url.searchParams.set("raw-leaves", "true"); // IMPORTANT

    const t0 = Date.now();
    const res = await request(url.toString(), {
        method: "POST",
        headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
    });
    const uploadMs = Date.now() - t0;

    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`IPFS add failed ${res.statusCode}: ${text.slice(0, 600)}`);
    }

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];

    let parsed: any;
    try {
        parsed = JSON.parse(last);
    } catch {
        throw new Error(`IPFS add returned non-JSON: ${last.slice(0, 300)}`);
    }

    const cid = parsed.Hash as string | undefined;
    if (!cid) throw new Error(`IPFS add response missing Hash: ${last.slice(0, 300)}`);

    return { cid, uploadMs };
}

async function ipfsCat(endpoint: string, authHeader: string | undefined, cid: string) {
    const url = new URL("/api/v0/cat", endpoint);
    url.searchParams.set("arg", cid);

    const t0 = Date.now();
    const res = await request(url.toString(), {
        method: "POST",
        headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
        },
    });
    const fetchMs = Date.now() - t0;

    if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text();
        throw new Error(`IPFS cat failed ${res.statusCode}: ${text.slice(0, 600)}`);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
    return { bytes: Buffer.concat(chunks), fetchMs };
}

async function run() {
    const { endpoint, usedKey } = getEndpoint();
    const authCandidates = getAuthHeaderCandidates();
    const repeats = Number(process.env.EVIDENCE_REPEATS ?? "10");
    const failFast = (process.env.FAIL_FAST ?? "0") === "1";

    const outPath = path.resolve(__dirname, "..", "evidence_results.json");

    const sizes = [
        10 * 1024,        // 10KB
        100 * 1024,       // 100KB
        1 * 1024 * 1024,  // 1MB
        5 * 1024 * 1024,  // 5MB
    ];

    console.log(`Loaded .env from: ${path.resolve(__dirname, "..", ".env")}`);
    console.log(`Using endpoint from ${usedKey}: ${endpoint}`);
    console.log(`Auth mode: ${process.env.FILEBASE_IPFS_RPC_AUTH_TYPE || "(none)"}`);
    console.log(`Auth candidates: ${authCandidates.length} (will try in order)`);
    console.log(`Repeats per size: ${repeats}`);
    console.log(`Total trials: ${sizes.length * repeats}`);
    console.log(`FAIL_FAST: ${failFast ? "ON" : "OFF"}\n`);

    const trials: Trial[] = [];
    let idx = 0;

    for (const sizeBytes of sizes) {
        for (let r = 0; r < repeats; r++) {
            const t: Trial = { idx: idx++, sizeBytes };
            try {
                const payload = randomBytes(sizeBytes);

                // IMPORTANT: match Filebase add settings (rawLeaves + CIDv1)
                t.expectedCid = await ipfsOnlyHashOf(payload, { cidVersion: 1, rawLeaves: true });

                let lastErr: any = null;
                let cid: string | undefined;
                let uploadMs: number | undefined;
                let authUsed: string | undefined;

                const candidatesToTry = authCandidates.length ? authCandidates : [undefined as any];

                for (const auth of candidatesToTry) {
                    try {
                        const res = await ipfsAdd(endpoint, auth, payload);
                        cid = res.cid;
                        uploadMs = res.uploadMs;
                        authUsed = auth;
                        lastErr = null;
                        break;
                    } catch (e: any) {
                        lastErr = e;
                    }
                }

                if (!cid) throw lastErr ?? new Error("IPFS add failed for all auth candidates");

                t.cid = cid;
                t.uploadMs = uploadMs;
                t.authUsed = authUsed;

                const { bytes: fetched, fetchMs } = await ipfsCat(endpoint, authUsed, cid);
                t.fetchOk = true;
                t.fetchMs = fetchMs;

                // Recompute expected CID from fetched bytes using same settings
                const fetchedCid = await ipfsOnlyHashOf(fetched, { cidVersion: 1, rawLeaves: true });
                t.cidMatch = fetchedCid === cid;

                if (!t.cidMatch) {
                    t.error = `CID mismatch: fetched->${fetchedCid} but anchored ${cid}`;
                }
            } catch (e: any) {
                t.fetchOk = false;
                t.cidMatch = false;
                t.error = String(e?.message ?? e);

                console.error(`ERROR [${t.idx}] size=${(t.sizeBytes / 1024).toFixed(0)}KB: ${t.error}`);

                if (failFast) {
                    trials.push(t);
                    fs.writeFileSync(outPath, JSON.stringify({ trials }, null, 2));
                    console.error(`FAIL_FAST: wrote partial results to ${outPath}`);
                    process.exit(1);
                }
            }

            trials.push(t);

            const shortCid = t.cid ? `${t.cid.slice(0, 8)}...${t.cid.slice(-6)}` : "FAIL";
            console.log(
                `[${t.idx}] size=${(t.sizeBytes / 1024).toFixed(0)}KB cid=${shortCid} ` +
                `up=${t.uploadMs ?? "-"}ms fetch=${t.fetchMs ?? "-"}ms ok=${t.fetchOk ? "Y" : "N"} match=${t.cidMatch ? "Y" : "N"}`
            );

            await new Promise((res) => setTimeout(res, 150));
        }
    }

    const M = trials.length;
    const uploadSuccess = trials.filter((t) => !!t.cid).length;
    const fetchSuccess = trials.filter((t) => t.fetchOk).length;
    const matchSuccess = trials.filter((t) => t.cidMatch).length;

    const uploadLat = trials.map((t) => t.uploadMs).filter((x): x is number => typeof x === "number");
    const fetchLat = trials.map((t) => t.fetchMs).filter((x): x is number => typeof x === "number");

    const failures = trials
        .filter((t) => t.error)
        .map((t) => ({ idx: t.idx, sizeBytes: t.sizeBytes, error: t.error }));

    const summary = {
        run_id: new Date().toISOString(),
        endpoint,
        objects_total: M,
        upload_success: uploadSuccess,
        fetch_success: fetchSuccess,
        cid_match_success: matchSuccess,
        retrievability_rate: fetchSuccess / M,
        cid_match_rate: matchSuccess / Math.max(1, fetchSuccess),
        upload_latency_ms: { p50: percentile(uploadLat, 50), p95: percentile(uploadLat, 95) },
        fetch_latency_ms: { p50: percentile(fetchLat, 50), p95: percentile(fetchLat, 95) },
        failure_count: failures.length,
    };

    fs.writeFileSync(outPath, JSON.stringify({ summary, trials, failures }, null, 2));
    console.log(`\nWrote ${outPath}\n`);
    console.log(summary);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});