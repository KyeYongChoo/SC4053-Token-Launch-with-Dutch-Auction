const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Deploys DutchAuction, optionally starts it, and writes frontend/src/deployment.json
// (address, chain id and ABI) so the web app can read the auction without manual setup.
// Every parameter can be overridden through the environment; the defaults match the demo in test/.

const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== "" ? process.env[name] : fallback);

async function main() {
  const params = {
    name: env("TOKEN_NAME", "Launch Token"),
    symbol: env("TOKEN_SYMBOL", "LCH"),
    supply: hre.ethers.parseEther(env("TOKEN_SUPPLY", "100")), // whole tokens
    startPrice: hre.ethers.parseEther(env("START_PRICE_ETH", "2.9")), // ETH per whole token
    reservePrice: hre.ethers.parseEther(env("RESERVE_PRICE_ETH", "1.0")),
    stepSeconds: BigInt(env("STEP_SECONDS", "60")),
    minBid: hre.ethers.parseEther(env("MIN_BID_ETH", "0.01")),
  };

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  console.log(`Deploying from ${deployer.address} on chain ${network.chainId}`);

  const factory = await hre.ethers.getContractFactory("DutchAuction", deployer);
  const auction = await factory.deploy(
    params.name,
    params.symbol,
    params.supply,
    params.startPrice,
    params.reservePrice,
    params.stepSeconds,
    params.minBid
  );
  await auction.waitForDeployment();
  const address = await auction.getAddress();
  const token = await auction.token();
  console.log(`DutchAuction: ${address}`);
  console.log(`LaunchToken:  ${token}`);

  if (env("START_AUCTION", "true") === "true") {
    const tx = await auction.startAuction();
    await tx.wait();
    console.log(`Auction started at block timestamp ${await auction.startTime()}`);
  }

  const artifact = await hre.artifacts.readArtifact("DutchAuction");
  const receipt = await auction.deploymentTransaction().wait();
  const out = {
    address,
    token,
    chainId: Number(network.chainId),
    deployBlock: receipt.blockNumber,
    owner: deployer.address,
    stepSeconds: Number(params.stepSeconds),
    abi: artifact.abi,
  };
  const outPath = path.join(__dirname, "..", "frontend", "src", "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
