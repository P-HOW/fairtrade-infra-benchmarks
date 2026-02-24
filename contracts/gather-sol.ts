#!/usr/bin/env node
/**
 * Gather all .sol source files under the current directory and write them into
 * a single structured JSON file with { path, code } entries.
 *
 * Usage:
 *   npx ts-node gather-sol.ts
 *   node gather-sol.js                (after tsc compile)
 *
 * Optional args:
 *   --out solidity_sources.json
 *   --no-recursive
 *   --exclude node_modules,dist,out,artifacts,cache
 */

import * as fs from "fs";
import * as path from "path";

type Entry = {
    path: string; // relative path (posix-style)
    code: string; // file contents
};

type Options = {
    outFile: string;
    recursive: boolean;
    excludeDirs: Set<string>;
    rootDir: string;
};

function parseArgs(cwd: string): Options {
    const args = process.argv.slice(2);
    let outFile = "solidity_sources.json";
    let recursive = true;
    const excludeDirs = new Set<string>([
        "node_modules",
        "dist",
        "build",
        "out",
        "artifacts",
        "cache",
        ".git",
        ".next",
    ]);

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--out" && args[i + 1]) {
            outFile = args[++i];
        } else if (a === "--no-recursive") {
            recursive = false;
        } else if (a === "--exclude" && args[i + 1]) {
            const parts = args[++i].split(",").map(s => s.trim()).filter(Boolean);
            for (const p of parts) excludeDirs.add(p);
        }
    }

    return { outFile, recursive, excludeDirs, rootDir: cwd };
}

function isExcludedDir(dirName: string, excludeDirs: Set<string>): boolean {
    return excludeDirs.has(dirName);
}

function toPosix(p: string): string {
    return p.split(path.sep).join(path.posix.sep);
}

function gatherSolFiles(dir: string, opts: Options, results: string[] = []): string[] {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
        const full = path.join(dir, item.name);

        if (item.isDirectory()) {
            if (!opts.recursive) continue;
            if (isExcludedDir(item.name, opts.excludeDirs)) continue;
            gatherSolFiles(full, opts, results);
        } else if (item.isFile()) {
            if (item.name.toLowerCase().endsWith(".sol")) {
                results.push(full);
            }
        }
    }
    return results;
}

function main() {
    const cwd = process.cwd();
    const opts = parseArgs(cwd);

    const files = gatherSolFiles(opts.rootDir, opts).sort((a, b) => a.localeCompare(b));

    const entries: Entry[] = files.map((absPath) => {
        const code = fs.readFileSync(absPath, "utf8");
        const rel = path.relative(opts.rootDir, absPath);
        return {
            path: toPosix(rel),
            code,
        };
    });

    const output = {
        generatedAt: new Date().toISOString(),
        rootDir: toPosix(path.resolve(opts.rootDir)),
        fileCount: entries.length,
        files: entries,
    };

    const outPath = path.resolve(opts.rootDir, opts.outFile);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

    console.log(`Wrote ${entries.length} Solidity files to ${toPosix(path.relative(cwd, outPath) || opts.outFile)}`);
}

main();