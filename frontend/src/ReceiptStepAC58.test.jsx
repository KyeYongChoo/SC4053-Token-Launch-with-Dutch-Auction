import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Interface } from "ethers";

// AC58: a confirmed bid reports the steps from its BidPlaced event, not the preview, and the bid
// form always says that winners pay one clearing price.
const ADDRESS = "0x0000000000000000000000000000000000000001";
const ACCOUNT = "0x0000000000000000000000000000000000000002";
const IFACE = new Interface([
  "event BidPlaced(uint256 indexed bidId, address indexed bidder, uint256 ethAmount, uint256 maxPrice, uint256 placedStep, uint256 effectiveStep)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function bid(uint256 maxPrice) payable",
]);
const mocks = vi.hoisted(() => ({ snapshot: null, receipt: null, bid: vi.fn() }));
vi.mock("ethers", async (importOriginal) => ({ ...await importOriginal(), BrowserProvider: class {
  async send() { return ["0x0000000000000000000000000000000000000002"]; }
  async getNetwork() { return { chainId: 31337n }; }
  async getSigner() { return {}; }
} }));
vi.mock("./auction.js", async (importOriginal) => ({ ...await importOriginal(),
  DEPLOYMENT: { address: "0x0000000000000000000000000000000000000001", chainId: 31337, abi: [] },
  readContract: () => ({}),
  readProvider: { getNetwork: async () => ({ chainId: 31337n }) },
  loadSnapshot: async () => mocks.snapshot,
  writeContract: () => ({ target: ADDRESS, interface: IFACE, bid: mocks.bid }),
}));
const { default: App } = await import("./App.jsx");
const { bidStepsFromReceipt } = await import("./auction.js");
const WAD = 10n ** 18n;
const originalEthereum = window.ethereum;
const originalResizeObserver = globalThis.ResizeObserver;

function placedLog(placedStep, effectiveStep, address = ADDRESS) {
  const { data, topics } = IFACE.encodeEventLog("BidPlaced", [3n, ACCOUNT, WAD, WAD, placedStep, effectiveStep]);
  return { address, data, topics };
}
function transferLog() {
  const { data, topics } = IFACE.encodeEventLog("Transfer", [ACCOUNT, ADDRESS, 1n]);
  return { address: "0x00000000000000000000000000000000000000aa", data, topics };
}
// Active at step 5 at the latest block; price(k) = 3 − 0.1k.
const snapshot = (overrides = {}) => ({
  fetchedAt: Date.now() / 1000, chainNow: 300, nextBlockTime: 300, awaitingBlock: false,
  state: 1, startTime: 0, endTime: 1200, stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur: 5,
  ended: false, soldOut: false, soldOutStep: 0, owner: "0x000000000000000000000000000000000000dEaD",
  finalizedAt: 0, claimDeadline: 0, proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
  maxBidsPerAddress: 100,
  clearing: { step: 0, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 0n, earlyDen: 1n, joinNum: 0n, joinDen: 1n },
  prices: Array.from({ length: 20 }, (_, k) => 3n * WAD - BigInt(k) * WAD / 10n),
  demand: Array(20).fill(0n), joins: Array(20).fill(0n), myBids: [], feed: [], ...overrides,
});

beforeEach(() => {
  mocks.bid.mockReset();
  mocks.bid.mockImplementation(async () => ({ wait: async () => mocks.receipt }));
  vi.spyOn(globalThis, "setInterval").mockImplementation(() => 1);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = { on: () => {}, removeListener: () => {} };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.ethereum = originalEthereum;
  globalThis.ResizeObserver = originalResizeObserver;
});

async function connected(snap) {
  mocks.snapshot = snap;
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await screen.findByText(/0x0000.*0002/);
}

describe("AC58: confirmed bid steps come from the BidPlaced event", () => {
  it("AC58: shows the placed and effective step from the receipt, not the previewed step", async () => {
    // The preview says live at step 5, but the bid was mined in step 6 and joins at step 8.
    mocks.receipt = { logs: [transferLog(), placedLog(6n, 8n)] };
    await connected(snapshot());
    await waitFor(() => expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false));
    expect(screen.getByText(/Live bid at step 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bid" }));
    expect(await screen.findByText("Bid: confirmed. Placed at step 6, effective step 8.")).toBeTruthy();
    expect(mocks.bid).toHaveBeenCalledTimes(1);
  });

  it("AC58 (control): without a BidPlaced event in the receipt no steps are claimed", async () => {
    mocks.receipt = { logs: [transferLog()] };
    await connected(snapshot());
    await waitFor(() => expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Bid" }));
    expect(await screen.findByText("Bid: confirmed.")).toBeTruthy();
  });

  it("AC58: bidStepsFromReceipt reads BidPlaced only from the auction's own logs", () => {
    const c = { target: ADDRESS, interface: IFACE };
    expect(bidStepsFromReceipt(c, { logs: [transferLog(), placedLog(6n, 8n)] })).toEqual({ placedStep: 6, effectiveStep: 8 });
    expect(bidStepsFromReceipt(c, { logs: [placedLog(1n, 2n, "0x00000000000000000000000000000000000000bb")] })).toBeNull();
    expect(bidStepsFromReceipt(c, { logs: [transferLog()] })).toBeNull();
    // Addresses compare case-insensitively: a checksummed contract address matches lowercase log addresses.
    const MIXED = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const mixed = { target: MIXED, interface: IFACE };
    expect(bidStepsFromReceipt(mixed, { logs: [placedLog(2n, 4n, MIXED.toLowerCase())] })).toEqual({ placedStep: 2, effectiveStep: 4 });
    expect(bidStepsFromReceipt({ ...mixed, target: MIXED.toLowerCase() }, { logs: [placedLog(2n, 4n, MIXED)] })).toEqual({ placedStep: 2, effectiveStep: 4 });
    expect(bidStepsFromReceipt(c, null)).toBeNull();
  });
});

describe("AC58: the bid form always shows the clearing-price line", () => {
  const LINE = "All winning bids pay the same clearing price.";
  it("AC58: shows the line while Active, before a wallet is connected", async () => {
    mocks.snapshot = snapshot();
    render(<App />);
    expect(await screen.findByText(LINE)).toBeTruthy();
  });
  it("AC58: shows the line once the auction has ended", async () => {
    await connected(snapshot({ cur: 19, chainNow: 1300, nextBlockTime: 1300, ended: true }));
    expect(screen.getByText(LINE)).toBeTruthy();
  });
});
