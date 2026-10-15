import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// AC57: in the last 15 s before a step boundary (from next-block time) the UI warns that a
// transaction confirming later runs at the next step, or fails at END. The notices are advisory.
const mocks = vi.hoisted(() => ({ snapshot: null }));
vi.mock("./auction.js", async (importOriginal) => ({ ...await importOriginal(),
  DEPLOYMENT: { address: "0x0000000000000000000000000000000000000001", chainId: 31337, abi: [] },
  readContract: () => ({}),
  readProvider: { getNetwork: async () => ({ chainId: 31337n }) },
  loadSnapshot: async () => mocks.snapshot,
}));
const { default: App } = await import("./App.jsx");
const { boundaryNotice } = await import("./auction.js");
const ACCOUNT = "0x0000000000000000000000000000000000000002";
const WAD = 10n ** 18n;
const END = 1200;
const NOW_MS = 1_700_000_000_000; // Date.now is fixed, so next-block time does not drift during a test.
const originalEthereum = window.ethereum;
const originalResizeObserver = globalThis.ResizeObserver;

const bid = (id, effectiveStep) => ({ id, bidder: ACCOUNT, ethAmount: WAD, maxPrice: WAD, placedStep: 0,
  effectiveStep, cancelled: false, claimed: false });
// Latest block and next-block time t in displayed step `cur`; price(k) = 3 − 0.1k.
const snapshot = (cur, t, overrides = {}) => ({
  fetchedAt: NOW_MS / 1000, chainNow: t, nextBlockTime: t, awaitingBlock: false,
  state: 1, startTime: 0, endTime: END, stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur,
  ended: false, soldOut: false, soldOutStep: 0, owner: "0x000000000000000000000000000000000000dEaD",
  finalizedAt: 0, claimDeadline: 0, proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
  maxBidsPerAddress: 100,
  clearing: { step: 0, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 0n, earlyDen: 1n, joinNum: 0n, joinDen: 1n },
  prices: Array.from({ length: 20 }, (_, k) => 3n * WAD - BigInt(k) * WAD / 10n),
  demand: Array(20).fill(0n), joins: Array(20).fill(0n), myBids: [bid("1", cur + 1), bid("2", cur + 2)], feed: [],
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = {
    request: vi.fn(async ({ method }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      if (method === "eth_chainId") return "0x7a69";
      throw new Error(`Unexpected wallet request: ${method}`);
    }),
    on: vi.fn(), removeListener: vi.fn(),
  };
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
  await waitFor(() => expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false));
  return within(screen.getByRole("heading", { name: "My bids" }).closest("section"));
}
const rowOf = (bids, id) => bids.getAllByRole("row").find((row) => row.cells[0].textContent === id);
const DROP = /^Price drops to/;
const LIVE_SOON = /^Becomes live at step/;
const ENDS = /^The auction ends in/;

describe("AC57: step-boundary notices from next-block time", () => {
  it("AC57: 15 s before step k+1 the bid form shows the price-drop notice with price(k+1) and step k+1", async () => {
    await connected(snapshot(5, 345));
    expect(screen.getByText("Price drops to 2.4 ETH / token in 15s. If your transaction confirms after that, it runs at step 6.")).toBeTruthy();
    expect(screen.queryByText(ENDS)).toBeNull();
  });

  it("AC57: 15 s before step k+1 My bids shows the becomes-live notice beside Cancel only for effectiveStep = k+1", async () => {
    const bids = await connected(snapshot(5, 345));
    const joining = rowOf(bids, "1");
    expect(within(joining).getByText("Becomes live at step 6 in 15s; it can't be cancelled after that.")).toBeTruthy();
    expect(within(joining).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(rowOf(bids, "2")).queryByText(LIVE_SOON)).toBeNull();
  });

  it("AC57: Bid and Cancel stay enabled while the notices show", async () => {
    const bids = await connected(snapshot(5, 345));
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false);
    for (const button of bids.getAllByRole("button", { name: "Cancel" })) expect(button.disabled).toBe(false);
  });

  it("AC57 (control): 16 s before step k+1 neither notice shows", async () => {
    const bids = await connected(snapshot(5, 344));
    expect(screen.queryByText(DROP)).toBeNull();
    expect(bids.queryByText(LIVE_SOON)).toBeNull();
    expect(bids.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);
  });

  it("AC57: in the last step, 15 s before END the bid form shows the ends-soon notice and Bid stays enabled", async () => {
    await connected(snapshot(19, END - 15, { myBids: [bid("1", 3)] }));
    expect(screen.getByText("The auction ends in 15s. A bid that confirms after that will fail.")).toBeTruthy();
    expect(screen.queryByText(DROP)).toBeNull();
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false);
  });

  it("AC57 (control): in the last step, 16 s before END no ends-soon notice shows", async () => {
    await connected(snapshot(19, END - 16, { myBids: [bid("1", 3)] }));
    expect(screen.queryByText(ENDS)).toBeNull();
  });

  it("AC57: the notice uses the displayed step from next-block time, not the latest block's step", async () => {
    // Latest block in step 5; next-block time 405 is in step 6, 15 s before step 7.
    const bids = await connected(snapshot(5, 405, { chainNow: 300, myBids: [bid("1", 7)] }));
    expect(screen.getByText("Price drops to 2.3 ETH / token in 15s. If your transaction confirms after that, it runs at step 7.")).toBeTruthy();
    expect(within(rowOf(bids, "1")).getByText("Becomes live at step 7 in 15s; it can't be cancelled after that.")).toBeTruthy();
  });
});

describe("AC57: boundaryNotice", () => {
  const active = { state: 1, ended: false, soldOut: false, cur: 5, startTime: 0, stepSeconds: 60, stepCount: 20,
    prices: Array.from({ length: 20 }, (_, k) => BigInt(30 - k)) };
  it("AC57: shows from 15 s down to 1 s before the boundary, counting whole seconds up", () => {
    expect(boundaryNotice(active, 345)).toEqual({ ends: false, seconds: 15, nextStep: 6, nextPrice: 24n });
    expect(boundaryNotice(active, 359)).toMatchObject({ seconds: 1 });
    expect(boundaryNotice(active, 345.5)).toMatchObject({ seconds: 15 });
    expect(boundaryNotice(active, 344)).toBeNull(); // 16 s
    expect(boundaryNotice(active, 344.5)).toBeNull(); // 15.5 s shows as 16 s
    expect(boundaryNotice(active, 360)).toBeNull(); // at the boundary the displayed step has moved on
  });
  it("AC57: in the last step the boundary is END", () => {
    expect(boundaryNotice({ ...active, cur: 19 }, END - 15)).toEqual({ ends: true, seconds: 15 });
  });
  it("AC57: shows nothing unless active, unended and unsold", () => {
    for (const change of [{ state: 0 }, { state: 2 }, { ended: true }, { soldOut: true }]) {
      expect(boundaryNotice({ ...active, ...change }, 345)).toBeNull();
    }
  });
});
