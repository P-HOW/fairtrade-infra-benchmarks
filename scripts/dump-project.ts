// scripts/dump-project.ts
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_FILE = path.join(PROJECT_ROOT, "project_snapshot.txt");

// Folders we care about
const FOLDERS = ["contracts", "scripts", "src", "test"];

// File extensions to include
const ALLOWED_EXTENSIONS = [".sol", ".ts", ".js"];

async function collectFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            // Recurse into subfolders
            const nested = await collectFiles(fullPath);
            files.push(...nested);
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            const isAllowed = ALLOWED_EXTENSIONS.includes(ext);
            const isDeclaration = entry.name.endsWith(".d.ts");

            if (isAllowed && !isDeclaration) {
                files.push(fullPath);
            }
        }
    }

    return files;
}

async function buildSnapshot() {
    const chunks: string[] = [];

    chunks.push("# FairTrade Infra Benchmarks – Project Snapshot");
    chunks.push(`# Generated at: ${new Date().toISOString()}`);
    chunks.push("");
    chunks.push("Included folders: " + FOLDERS.join(", "));
    chunks.push("Included extensions: " + ALLOWED_EXTENSIONS.join(", "));
    chunks.push("");
    chunks.push("============================================================");
    chunks.push("");

    for (const folder of FOLDERS) {
        const folderPath = path.join(PROJECT_ROOT, folder);

        try {
            const stat = await fs.stat(folderPath);
            if (!stat.isDirectory()) continue;
        } catch {
            // Folder doesn't exist; skip
            continue;
        }

        const files = await collectFiles(folderPath);

        for (const filePath of files) {
            const relPath = path.relative(PROJECT_ROOT, filePath);
            const content = await fs.readFile(filePath, "utf8");

            chunks.push(`>>> BEGIN FILE: ${relPath}`);
            chunks.push("----------------------------------------------------------------");
            chunks.push(content.trimEnd());
            chunks.push("");
            chunks.push(`<<< END FILE: ${relPath}`);
            chunks.push("");
            chunks.push("============================================================");
            chunks.push("");
        }
    }

    await fs.writeFile(OUTPUT_FILE, chunks.join("\n"), "utf8");
    console.log(`Snapshot written to ${OUTPUT_FILE}`);
}

async function main() {
    await buildSnapshot();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
