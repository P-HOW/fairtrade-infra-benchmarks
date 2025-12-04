// scripts/deploy-op-sepolia.ts

import "dotenv/config";
import { ethers } from "ethers";
import counterArtifact from "../artifacts/contracts/Counter.sol/Counter.json"

async function main() {
    const rpcUrl = process.env.OP_SEPOLIA_RPC_URL;
    const privateKey = process.env.OP_SEPOLIA_PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
        throw new Error(
            "Missing OP_SEPOLIA_RPC_URL or OP_SEPOLIA_PRIVATE_KEY in .env"
        );
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log("Deployer address:", await wallet.getAddress());

    const artifact: any = counterArtifact;

    const factory = new ethers.ContractFactory(
        artifact.abi,
        artifact.bytecode,
        wallet
    );

    console.log("Deploying Counter to Optimism Sepolia...");
    const contract = await factory.deploy();
    await contract.waitForDeployment();

    console.log("✅ Counter deployed at:", await contract.getAddress());
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
