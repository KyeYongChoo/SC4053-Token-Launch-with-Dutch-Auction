import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, formatEther, parseEther } from "ethers";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DEPLOYMENT,
  STATE_NAMES,
  WAD,
  fmtDuration,
  fmtEth,
  fmtTime,
  fmtTokens,
  loadSnapshot,
  previewBid,
  quoteBid,
  readContract,
  readProvider,
  writeContract,
} from "./auction.js";

const POLL_MS = 2000;

export default function App() {
  // No contract without a deployment: the placeholder address is null and Contract() would throw.
  const contract = useMemo(() => (DEPLOYMENT.address ? readContract() : null), []);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [rpcChainId, setRpcChainId] = useState(null);
  const [snap, setSnap] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    if (!contract) return;
    try {
      setSnap(await loadSnapshot(contract, account || null));
      setLoadError("");
    } catch (e) {
      setLoadError(e.shortMessage ?? e.message);
    }
  }, [contract, account]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // The read-only RPC decides what the page shows. Check it is on the expected chain.
  useEffect(() => {
    readProvider
      .getNetwork()
      .then((n) => setRpcChainId(Number(n.chainId)))
      .catch(() => setRpcChainId(null));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Keep the wallet in sync with MetaMask: reload on network change, follow account changes.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const onChain = () => window.location.reload();
    const onAccounts = (accounts) => setAccount(accounts[0] ?? "");
    eth.on("chainChanged", onChain);
    eth.on("accountsChanged", onAccounts);
    return () => {
      eth.removeListener?.("chainChanged", onChain);
      eth.removeListener?.("accountsChanged", onAccounts);
    };
  }, []);

  const connect = async () => {
    if (!window.ethereum) return setNotice("Install MetaMask to place bids.");
    try {
      const provider = new BrowserProvider(window.ethereum);
      const [first] = await provider.send("eth_requestAccounts", []);
      setAccount(first);
      setChainId(Number((await provider.getNetwork()).chainId));
    } catch (e) {
      setNotice(`Could not connect the wallet: ${e.shortMessage ?? e.message}`);
    }
  };

  const switchNetwork = async () => {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + DEPLOYMENT.chainId.toString(16) }],
      });
    } catch (e) {
      setNotice(`Could not switch network: ${e.message}`);
    }
  };

  const wrongNetwork = Boolean(account) && chainId !== null && chainId !== DEPLOYMENT.chainId;
  const canAct = Boolean(account) && !wrongNetwork && !busy;

  // Check the wallet's chain at the moment of sending, not only when the account connected.
  const signed = async () => {
    const provider = new BrowserProvider(window.ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== DEPLOYMENT.chainId) {
      throw new Error(`Wallet is on chain ${network.chainId}. Switch to chain ${DEPLOYMENT.chainId} first.`);
    }
    return writeContract(await provider.getSigner());
  };

  const run = async (label, send) => {
    setBusy(label);
    setNotice("");
    try {
      const tx = await send(await signed());
      setNotice(`${label}: waiting for confirmation...`);
      await tx.wait();
      setNotice(`${label}: confirmed.`);
    } catch (e) {
      setNotice(`${label} failed: ${e.reason ?? e.shortMessage ?? e.message}`);
    } finally {
      setBusy("");
      await refresh();
    }
  };

  if (!DEPLOYMENT.address) {
    return (
      <div className="page">
        <h1>Token Launch: Dutch Auction</h1>
        <p className="card">
          No deployment found. Run <code>npm run deploy:local</code> (with <code>npm run node</code> running) and
          reload.
        </p>
      </div>
    );
  }

  const isOwner = Boolean(account) && snap && account.toLowerCase() === snap.owner.toLowerCase();
  // Local clock estimate between polls, so countdowns move every second.
  const chainNow = snap ? snap.chainNow + (Date.now() / 1000 - snap.fetchedAt) : 0;

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Token Launch: Dutch Auction</h1>
          <p className="muted">
            Contract <code>{DEPLOYMENT.address}</code>
          </p>
        </div>
        <div className="wallet">
          {account ? (
            <span className="pill">
              {account.slice(0, 6)}...{account.slice(-4)}
              {isOwner ? " (owner)" : ""}
            </span>
          ) : (
            <button className="primary" onClick={connect}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {wrongNetwork && (
        <div className="banner warn">
          Wrong network. This auction is on chain {DEPLOYMENT.chainId}. Actions are disabled.{" "}
          <button onClick={switchNetwork}>Switch network</button>
        </div>
      )}
      {rpcChainId !== null && rpcChainId !== DEPLOYMENT.chainId && (
        <div className="banner warn">
          The read-only RPC is on chain {rpcChainId}, not {DEPLOYMENT.chainId}. The figures shown may be wrong.
        </div>
      )}
      {loadError && <div className="banner warn">Could not read the chain: {loadError}</div>}
      {notice && <div className="banner">{notice}</div>}

      {!snap ? (
        <p className="card">Loading auction...</p>
      ) : (
        <>
          <StatusPanel snap={snap} chainNow={chainNow} />
          {snap.state === 1 && snap.ended && (
            // SPEC section 6: visible to everyone once the auction has ended, wallet or not.
            <section className="card">
              <h2>Finalize</h2>
              <p className="muted">The auction has ended. Anyone can finalize it to record the clearing result.</p>
              <button className="primary" onClick={() => run("Finalize", (c) => c.finalize())} disabled={!canAct}>
                Finalize
              </button>
              {!account && <p className="muted small">Connect a wallet to finalize.</p>}
            </section>
          )}
          <PriceChart snap={snap} />
          <div className="grid2">
            <BidForm snap={snap} disabled={!canAct || snap.state !== 1 || snap.ended} onBid={(amt, max) =>
              run("Bid", (c) => c.bid(parseEther(max), { value: parseEther(amt) }))
            } />
            {isOwner && <OwnerPanel snap={snap} canAct={canAct} run={run} />}
          </div>
          <MyBids
            snap={snap}
            account={account}
            canAct={canAct}
            onCancel={(id) => run("Cancel", (c) => c.cancelBid(id))}
            onClaim={() => run("Claim", (c) => c.claim())}
          />
          <BidFeed snap={snap} />
        </>
      )}
    </div>
  );
}

function StatusPanel({ snap, chainNow }) {
  const stateName = STATE_NAMES[snap.state];
  const cur = snap.cur;
  const need = snap.prices[cur] ? (snap.prices[cur] * snap.supply) / WAD : 0n;
  const coverage = need > 0n ? Number((snap.demand[cur] * 10000n) / need) / 100 : 0;
  const endsIn = snap.endTime - chainNow;
  const nextStepAt = snap.startTime + (cur + 1) * snap.stepSeconds;
  const nextIn = nextStepAt - chainNow;

  let headline = stateName;
  if (snap.state === 1 && snap.soldOut) headline = `Sold out at step ${snap.soldOutStep}`;
  else if (snap.state === 1 && snap.ended) headline = "Ended, not finalized";
  else if (snap.state === 2) headline = "Finalized";
  else if (snap.state === 3) headline = "Swept";

  return (
    <section className="card">
      <h2>{headline}</h2>
      <div className="stats">
        <Stat label="Current step" value={`${cur} of ${snap.stepCount - 1}`} />
        <Stat label="Current price" value={`${fmtEth(snap.prices[cur])} ETH / token`} />
        <Stat label="Reserve price" value={`${fmtEth(snap.reservePrice)} ETH / token`} />
        <Stat label="Total committed" value={`${fmtEth(snap.demand[snap.stepCount - 1])} ETH`} />
        <Stat label="Covered at current price" value={`${coverage.toFixed(1)}%`} />
        <Stat label="Supply" value={`${fmtTokens(snap.supply)} tokens`} />
        {snap.state === 1 && !snap.ended && (
          <>
            <Stat label="Next step in" value={fmtDuration(nextIn)} />
            <Stat label="Auction ends in" value={fmtDuration(endsIn)} />
          </>
        )}
        {snap.state >= 2 && snap.clearing.price > 0n && (
          <>
            <Stat label="Clearing price" value={`${fmtEth(snap.clearing.price)} ETH / token`} />
            <Stat label="Tokens sold" value={`${fmtTokens(snap.clearing.tokensSold)}`} />
            <Stat label="Proceeds" value={`${fmtEth(snap.clearing.proceeds)} ETH`} />
          </>
        )}
        {snap.claimDeadline > 0 && <Stat label="Claim deadline" value={fmtTime(snap.claimDeadline)} />}
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function PriceChart({ snap }) {
  const data = useMemo(() => {
    const perStep = snap.stepSeconds / 60;
    return snap.prices.map((p, k) => ({
      minute: +(k * perStep).toFixed(2),
      price: +formatEther(p),
      demandPrice: snap.demand[k] > 0n ? +formatEther((snap.demand[k] * WAD) / snap.supply) : null,
      standing: +formatEther(snap.joins[k]),
    }));
  }, [snap]);

  const nowMinute = +(snap.cur * (snap.stepSeconds / 60)).toFixed(2);
  const showClearing = snap.state >= 2 && snap.clearing.price > 0n;
  const clearingMinute = showClearing ? +(snap.clearing.step * (snap.stepSeconds / 60)).toFixed(2) : null;

  return (
    <section className="card">
      <h2>Price</h2>
      <div className="chart">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={data} margin={{ top: 10, right: 16, bottom: 10, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
            <XAxis
              dataKey="minute"
              type="number"
              domain={[0, (snap.stepCount * snap.stepSeconds) / 60]}
              tickFormatter={(m) => `${m}m`}
              stroke="var(--muted)"
            />
            <YAxis yAxisId="price" stroke="var(--muted)" tickFormatter={(v) => `${v}`} label={{ value: "ETH / token", angle: -90, position: "insideLeft" }} />
            <YAxis yAxisId="eth" orientation="right" stroke="var(--muted)" tickFormatter={(v) => `${v}`} label={{ value: "ETH at step", angle: 90, position: "insideRight" }} />
            <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(4) : v)} labelFormatter={(m) => `${m} min`} />
            <Legend />
            <Line yAxisId="price" type="stepAfter" dataKey="price" name="Price (curve)" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line yAxisId="price" type="monotone" dataKey="demandPrice" name="Demand price (ETH committed / supply)" stroke="var(--demand)" strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
            <Bar yAxisId="eth" dataKey="standing" name="ETH joining at step (standing orders)" fill="var(--bar)" opacity={0.5} isAnimationActive={false} />
            {snap.state === 1 && !snap.ended && <ReferenceLine yAxisId="price" x={nowMinute} stroke="var(--now)" strokeDasharray="4 4" label={{ value: "now", position: "top" }} />}
            {clearingMinute !== null && (
              <ReferenceDot yAxisId="price" x={clearingMinute} y={+formatEther(snap.clearing.price)} r={6} fill="var(--accent)" stroke="var(--bg)" label={{ value: "clearing", position: "top" }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="muted small">
        The solid line is the price schedule. The dashed line is the price at which committed ETH would buy the whole supply.
        Bars show standing orders that join at each step.
      </p>
    </section>
  );
}

function BidForm({ snap, disabled, onBid }) {
  const [amount, setAmount] = useState("1");
  const [maxPrice, setMaxPrice] = useState(() => formatEther(snap.prices[0]));

  let preview = null;
  let parseError = "";
  try {
    const max = parseEther(maxPrice || "0");
    preview = previewBid(snap, max);
  } catch {
    parseError = "Enter a valid max price.";
  }
  let amountOk = true;
  try {
    amountOk = parseEther(amount || "0") >= snap.minBidWei;
  } catch {
    amountOk = false;
  }

  const err = parseError || preview?.error || (!amountOk && "Amount is below the minimum bid.") || "";
  const canSubmit = !disabled && !err;

  return (
    <section className="card">
      <h2>Place a bid</h2>
      <label>
        Amount (ETH)
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Max price (ETH per token)
        <div className="row">
          <input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} inputMode="decimal" />
          <button type="button" onClick={() => setMaxPrice(formatEther(snap.prices[0]))}>
            Buy at any price
          </button>
        </div>
      </label>
      <div className="preview">
        {err ? (
          <span className="warn-text">{err}</span>
        ) : preview.live ? (
          <span>Live bid at step {preview.step} (current price). It counts immediately.</span>
        ) : (
          <span>
            Standing order: activates at step {preview.step} when the price is {fmtEth(preview.price)} ETH. It can be cancelled until then.
          </span>
        )}
      </div>
      <button className="primary" disabled={!canSubmit} onClick={() => onBid(amount, maxPrice)}>
        Bid
      </button>
      {disabled && snap.state === 1 && snap.ended && <p className="muted small">The auction has ended.</p>}
    </section>
  );
}

function MyBids({ snap, account, canAct, onCancel, onClaim }) {
  if (!account) return <section className="card"><h2>My bids</h2><p className="muted">Connect a wallet to see your bids.</p></section>;

  const finalized = snap.state >= 2 && snap.clearing.price > 0n;
  const hasClaimable = snap.myBids.some((b) => !b.cancelled && !b.claimed);
  const claimable = hasClaimable && (snap.state === 2 || (snap.state === 1 && snap.ended)) && snap.state !== 3;

  return (
    <section className="card">
      <div className="row between">
        <h2>My bids</h2>
        <div className="row">
          {claimable && (
            <button className="primary" onClick={onClaim} disabled={!canAct}>
              Claim tokens and refunds
            </button>
          )}
        </div>
      </div>
      {snap.myBids.length === 0 ? (
        <p className="muted">You have no bids in this auction.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>ETH</th>
                <th>Max price</th>
                <th>Status</th>
                <th>Tokens</th>
                <th>Refund</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snap.myBids.map((b) => {
                const q = finalized ? quoteBid(b, snap.clearing) : null;
                const cancellable = !b.cancelled && snap.state === 1 && !snap.ended && snap.cur < b.effectiveStep;
                let status;
                if (b.cancelled) status = "Cancelled";
                else if (b.claimed) status = "Claimed";
                else if (snap.state === 1 && !snap.ended && b.effectiveStep === snap.cur) status = "Live";
                else if (snap.state === 1 && !snap.ended) status = `Standing from step ${b.effectiveStep}`;
                else status = "Settled at clearing";
                return (
                  <tr key={b.id}>
                    <td>{b.id}</td>
                    <td>{fmtEth(b.ethAmount)}</td>
                    <td>{fmtEth(b.maxPrice)}</td>
                    <td>{status}</td>
                    <td>{q ? fmtTokens(q.tokens) : "-"}</td>
                    <td>{q ? fmtEth(q.refund) : "-"}</td>
                    <td>
                      {cancellable && (
                        <button onClick={() => onCancel(b.id)} disabled={!canAct}>Cancel</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!finalized && snap.myBids.length > 0 && (
        <p className="muted small">Tokens and refunds are estimated once the auction has ended.</p>
      )}
    </section>
  );
}

function OwnerPanel({ snap, canAct, run }) {
  const canStart = snap.state === 0;
  const canWithdraw = !snap.proceedsWithdrawn && (snap.state === 2 || (snap.state === 1 && snap.ended));
  const canSweep = snap.state === 2 && snap.chainNow > snap.claimDeadline;
  return (
    <section className="card">
      <h2>Owner</h2>
      <div className="col">
        <button disabled={!canAct || !canStart} onClick={() => run("Start", (c) => c.startAuction())}>
          Start auction
        </button>
        <button disabled={!canAct || !canWithdraw} onClick={() => run("Withdraw proceeds", (c) => c.withdrawProceeds())}>
          Withdraw proceeds
        </button>
        <button disabled={!canAct || !canSweep} onClick={() => run("Sweep", (c) => c.sweep())}>
          Sweep after claim deadline
        </button>
      </div>
      <p className="muted small">
        Claim deadline: {snap.claimDeadline ? fmtTime(snap.claimDeadline) : "set when the auction is finalized"}.
      </p>
    </section>
  );
}

function BidFeed({ snap }) {
  return (
    <section className="card">
      <h2>Bid feed</h2>
      {snap.feed.length === 0 ? (
        <p className="muted">No bids yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Bidder</th>
                <th>ETH</th>
                <th>Max price</th>
                <th>Placed step</th>
                <th>Effective step</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {snap.feed.slice(0, 50).map((b) => (
                <tr key={b.id}>
                  <td>{b.id}</td>
                  <td className="mono">{b.bidder.slice(0, 6)}...{b.bidder.slice(-4)}</td>
                  <td>{fmtEth(b.ethAmount)}</td>
                  <td>{fmtEth(b.maxPrice)}</td>
                  <td>{b.placedStep}</td>
                  <td>{b.effectiveStep}</td>
                  <td>{b.cancelled ? "Cancelled" : "Active"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
