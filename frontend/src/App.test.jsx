import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
