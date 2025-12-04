// scripts/deploy-op-sepolia.ts
// Deploys the FairTrade infra suite to Optimism Sepolia and records
// contract addresses in op-sepolia-deployments.json.
//
// Usage:
//   npx hardhat run scripts/deploy-op-sepolia.ts --network opSepolia

import "dotenv/config";
import { ethers } from "ethers";
import { promises as fs } from "fs";
import path from "path";

import actorRegistryArtifact from "../artifacts/contracts/ActorRegistry.sol/ActorRegistry.json";
import documentRegistryArtifact from "../artifacts/contracts/DocumentRegistry.sol/DocumentRegistry.json";
import cidRollupArtifact from "../artifacts/contracts/CidRollup.sol/CidRollup.json";
import processManagerArtifact from "../artifacts/contracts/ProcessManager.sol/ProcessManager.json";
import paymentRouterArtifact from "../artifacts/contracts/PaymentRouter.sol/PaymentRouter.json";

type DeploymentMap = { [contractName: string]: string };

const DEPLOYMENTS_FILE = path.join(process.cwd(), "op-sepolia-deployments.json");

async function loadDeployments(): Promise<DeploymentMap> {
    try {
        const raw = await fs.readFile(DEPLOYMENTS_FILE, "utf8");
        return JSON.parse(raw) as DeploymentMap;
    } catch {
        return {};
    }
}

async function saveDeployments(deployments: DeploymentMap): Promise<void> {
    const json = JSON.stringify(deployments, null, 2);
    await fs.writeFile(DEPLOYMENTS_FILE, json, "utf8");
}

async function deployIfNeeded(
    name: string,
    artifact: any,
    wallet: ethers.Wallet,
    deployments: DeploymentMap,
    constructorArgs: unknown[] = []
): Promise<string> {
    if (deployments[name]) {
        console.log(`⏭  ${name} already deployed at ${deployments[name]}`);
        return deployments[name];
    }

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

    console.log(`🚀 Deploying ${name} ...`);
    const contract = await factory.deploy(...constructorArgs);
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    console.log(`✅ ${name} deployed at: ${address}`);

    deployments[name] = address;
    await saveDeployments(deployments);

    return address;
}

async function main() {
    const rpcUrl = process.env.OP_SEPOLIA_RPC_URL;
    const privateKey = process.env.OP_SEPOLIA_PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
        throw new Error("Missing OP_SEPOLIA_RPC_URL or OP_SEPOLIA_PRIVATE_KEY in .env");
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log("Deployer address:", await wallet.getAddress());
    console.log("RPC URL:", rpcUrl);
    console.log("");

    const deployments = await loadDeployments();

    // 1. ActorRegistry (owner = deployer)
    const actorRegistryAddress = await deployIfNeeded(
        "ActorRegistry",
        actorRegistryArtifact,
        wallet,
        deployments,
        [await wallet.getAddress()]
    );

    // 2. DocumentRegistry
    const documentRegistryAddress = await deployIfNeeded(
        "DocumentRegistry",
        documentRegistryArtifact,
        wallet,
        deployments,
        [actorRegistryAddress]
    );

    // 3. ProcessManager
    const processManagerAddress = await deployIfNeeded(
        "ProcessManager",
        processManagerArtifact,
        wallet,
        deployments,
        [actorRegistryAddress]
    );

    // 4. CidRollup
    const cidRollupAddress = await deployIfNeeded(
        "CidRollup",
        cidRollupArtifact,
        wallet,
        deployments,
        [actorRegistryAddress]
    );

    // 5. PaymentRouter
    // For now we route 100% of payments to the deployer address – in a real setup
    // this would be a treasury or a preconfigured revenue split.
    const paymentRouterAddress = await deployIfNeeded(
        "PaymentRouter",
        paymentRouterArtifact,
        wallet,
        deployments,
        [
            actorRegistryAddress,
            [await wallet.getAddress()], // recipients
            [10_000], // 100% in basis points
        ]
    );

    console.log("\n=== Deployment summary (Optimism Sepolia) ===");
    console.log("ActorRegistry:    ", actorRegistryAddress);
    console.log("DocumentRegistry: ", documentRegistryAddress);
    console.log("ProcessManager:   ", processManagerAddress);
    console.log("CidRollup:        ", cidRollupAddress);
    console.log("PaymentRouter:    ", paymentRouterAddress);
    console.log(`\nDeployment map saved to: ${DEPLOYMENTS_FILE}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
