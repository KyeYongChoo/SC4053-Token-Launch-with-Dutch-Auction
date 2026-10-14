import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Render tests for the review findings on PR #20. Chain access is mocked, so no node is needed.
// deployment and snapshot are hoisted so each test can choose its own state.
const mocks = vi.hoisted(() => ({
  deployment: { address: null, chainId: 31337, owner: null, abi: [], deployBlock: 0, stepSeconds: 60, token: null },
  snapshot: null,
  rpcChainId: 31337n,
}));

vi.mock("./auction.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get DEPLOYMENT() {
      return mocks.deployment;
    },
    // With no address, call the real readContract so a regression that builds a contract from null throws here.
    readContract: () => (mocks.deployment.address ? {} : actual.readContract()),
    readProvider: { getNetwork: async () => ({ chainId: mocks.rpcChainId }) },
    loadSnapshot: async () => mocks.snapshot,
  };
});

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom does not provide.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: App } = await import("./App.jsx");

const WAD = 10n ** 18n;
const ENDED_SNAPSHOT = {
  fetchedAt: Date.now() / 1000,
  chainNow: 10_000,
  state: 1,
  startTime: 0,
  endTime: 1200,
  stepCount: 20,
  stepSeconds: 60,
  supply: 100n * WAD,
  cur: 19,
  ended: true,
  soldOut: false,
  soldOutStep: 0,
  owner: "0x000000000000000000000000000000000000dEaD",
  finalizedAt: 0,
  claimDeadline: 0,
  proceedsWithdrawn: false,
  reservePrice: WAD,
  minBidWei: 10n ** 16n,
  maxBidsPerAddress: 100,
  clearing: { step: 0, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 0n, earlyDen: 0n, joinNum: 0n, joinDen: 0n },
  prices: Array.from({ length: 20 }, (_, k) => (29n * WAD) / 10n - (BigInt(k) * WAD) / 10n),
  demand: Array(20).fill(0n),
  joins: Array(20).fill(0n),
  myBids: [],
  feed: [],
};

beforeEach(() => {
  mocks.deployment = { ...mocks.deployment, address: null };
  mocks.snapshot = null;
  mocks.rpcChainId = 31337n;
});

// No vitest globals, so Testing Library does not unmount between tests on its own.
afterEach(() => {
  cleanup();
  delete window.ethereum;
});

describe("App (PR #20 review)", function () {
  it("F1: with the placeholder deployment, shows 'No deployment found' instead of crashing", () => {
    render(<App />);
    expect(screen.getByText(/No deployment found/)).toBeTruthy();
  });

  it("F2: Finalize is visible to visitors without a wallet once the auction has ended", async () => {
    mocks.deployment = { ...mocks.deployment, address: "0x0000000000000000000000000000000000000001" };
    mocks.snapshot = ENDED_SNAPSHOT;
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Finalize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finalize" }).disabled).toBe(true);
    expect(screen.getByText("Connect a wallet to finalize.")).toBeTruthy();
  });

  it("F5: shows a banner when the read-only RPC is on another chain", async () => {
    mocks.deployment = { ...mocks.deployment, address: "0x0000000000000000000000000000000000000001" };
    mocks.snapshot = ENDED_SNAPSHOT;
    mocks.rpcChainId = 1n;
    render(<App />);
    expect(await screen.findByText(/read-only RPC is on chain 1/)).toBeTruthy();
  });
});

// AC48 (issue #22, risk R12): a wallet on the wrong chain gets a switch-network prompt and every
// action is disabled. window.ethereum is a fake EIP-1193 wallet whose chain the test controls.
const LIVE_SNAPSHOT = { ...ENDED_SNAPSHOT, chainNow: 300, cur: 5, ended: false };
const ACCOUNT = "0x00000000000000000000000000000000000000a1";

function fakeWallet(chainId) {
  const wallet = {
    chainId,
    calls: [],
    on() {},
    removeListener() {},
    async request({ method, params }) {
      wallet.calls.push(method);
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [ACCOUNT];
        case "eth_chainId":
          return "0x" + wallet.chainId.toString(16);
        case "wallet_switchEthereumChain":
          wallet.switchedTo = params[0].chainId;
          return null;
        default:
          throw new Error(`fake wallet: ${method} not supported`);
      }
    },
  };
  return wallet;
}

async function connectWallet(chainId, snapshot) {
  mocks.deployment = { ...mocks.deployment, address: "0x0000000000000000000000000000000000000001" };
  mocks.snapshot = snapshot;
  window.ethereum = fakeWallet(chainId);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
  await screen.findByText(/0x0000\.\.\.00a1/);
  return window.ethereum;
}

describe("AC48: wrong-network wallet", function () {
  it("AC48: a wallet on the wrong chain sees a switch-network prompt and Bid is disabled", async () => {
    const wallet = await connectWallet(1, LIVE_SNAPSHOT);
    expect(screen.getByText(/Wrong network\. This auction is on chain 31337\. Actions are disabled\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Switch network" }));
    await waitFor(() => expect(wallet.switchedTo).toBe("0x7a69"));
  });

  it("AC48: Finalize is disabled for a wallet on the wrong chain", async () => {
    await connectWallet(1, ENDED_SNAPSHOT);
    expect(screen.getByText(/Wrong network/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finalize" }).disabled).toBe(true);
  });

  it("AC48 (control): on the deployment chain there is no prompt and Bid and Finalize are enabled", async () => {
    await connectWallet(31337, LIVE_SNAPSHOT);
    expect(screen.queryByText(/Wrong network/)).toBeNull();
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false);
    cleanup();

    await connectWallet(31337, ENDED_SNAPSHOT);
    expect(screen.getByRole("button", { name: "Finalize" }).disabled).toBe(false);
  });

  it("AC48: a wallet that changes chain after connecting is stopped before it signs", async () => {
    // No chainChanged event fires, so the UI still thinks the chain is right; the send-time
    // check in signed() must catch it.
    const wallet = await connectWallet(31337, LIVE_SNAPSHOT);
    wallet.chainId = 1;
    fireEvent.click(screen.getByRole("button", { name: "Bid" }));
    expect(await screen.findByText(/Bid failed: Wallet is on chain 1\. Switch to chain 31337 first\./)).toBeTruthy();
    expect(wallet.calls).not.toContain("eth_sendTransaction");
  });

  // Every other action button depends on canAct too. Each is checked on the wrong chain, and on
  // the right chain as a control, so a button that drops disabled={!canAct} is caught.
  const standingBid = { id: 0, bidder: ACCOUNT, ethAmount: WAD, maxPrice: WAD, placedStep: 5, effectiveStep: 19, cancelled: false, claimed: false };
  const finalizedBid = { ...standingBid, effectiveStep: 0 };
  const OWNER_LIVE = { ...LIVE_SNAPSHOT, owner: ACCOUNT, myBids: [standingBid] };
  const OWNER_FINALIZED = {
    ...ENDED_SNAPSHOT,
    state: 2,
    owner: ACCOUNT,
    finalizedAt: 1300,
    claimDeadline: 2000, // chainNow is 10_000, so the sweep is open
    clearing: { step: 19, price: WAD, tokensSold: WAD, proceeds: WAD, earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n },
    myBids: [finalizedBid],
  };
  const OWNER_CREATED = { ...ENDED_SNAPSHOT, state: 0, cur: 0, ended: false, owner: ACCOUNT };
  const cases = [
    ["Cancel", OWNER_LIVE],
    ["Claim tokens and refunds", OWNER_FINALIZED],
    ["Withdraw proceeds", OWNER_FINALIZED],
    ["Sweep after claim deadline", OWNER_FINALIZED],
    ["Start auction", OWNER_CREATED],
  ];

  for (const [name, snapshot] of cases) {
    it(`AC48: "${name}" is disabled on the wrong chain and enabled on the deployment chain`, async () => {
      await connectWallet(1, snapshot);
      expect(screen.getByRole("button", { name }).disabled).toBe(true);
      cleanup();

      await connectWallet(31337, snapshot);
      expect(screen.getByRole("button", { name }).disabled).toBe(false);
    });
  }
});
