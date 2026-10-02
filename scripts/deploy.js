const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

// Auction parameters. Prices are in ETH per whole token.
const TOKEN_NAME = "Launch Token";
const TOKEN_SYMBOL = "LNCH";
const TOKENS_FOR_SALE = ethers.parseEther("1000");
const START_PRICE = ethers.parseEther("0.01");
const RESERVE_PRICE = ethers.parseEther("0.001");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to ${network.name} as ${deployer.address}`);

  const token = await ethers.deployContract("LaunchToken", [
    TOKEN_NAME,
    TOKEN_SYMBOL,
    TOKENS_FOR_SALE,
    deployer.address,
  ]);
  await token.waitForDeployment();

  const auction = await ethers.deployContract("DutchAuction", [
    token.target,
    TOKENS_FOR_SALE,
    START_PRICE,
    RESERVE_PRICE,
    deployer.address,
  ]);
  await auction.waitForDeployment();

  // Approve now so the owner only has to press "Start auction" in the UI.
  await (await token.approve(auction.target, TOKENS_FOR_SALE)).wait();

  console.log(`LaunchToken:  ${token.target}`);
  console.log(`DutchAuction: ${auction.target}`);

  const deployment = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    token: { address: token.target, abi: (await artifacts.readArtifact("LaunchToken")).abi },
    auction: { address: auction.target, abi: (await artifacts.readArtifact("DutchAuction")).abi },
  };
  const outDir = path.join(__dirname, "..", "frontend", "src", "contracts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "deployment.json"), JSON.stringify(deployment, null, 2));
  console.log("Wrote frontend/src/contracts/deployment.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
