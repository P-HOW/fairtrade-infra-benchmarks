// scripts/gen-test-wallet.ts
import { Wallet } from "ethers";

async function main() {
    const wallet = Wallet.createRandom();

    console.log("=== New test wallet generated ===\n");
    console.log("Address:");
    console.log(`  ${wallet.address}\n`);

    console.log("Private key (keep this secret, even for testnets):");
    console.log(`  ${wallet.privateKey}\n`);

    console.log("Add this line to your .env file:\n");
    console.log(`OP_SEPOLIA_PRIVATE_KEY=${wallet.privateKey}\n`);

    console.log("Then fund the address with OP Sepolia ETH from a faucet.");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
