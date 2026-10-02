import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, parseEther } from "ethers";
import {
  DURATION,
  commitmentCap,
  deployment,
  errorMessage,
  fmt,
  phaseOf,
  priceAt,
  settlementPrice,
  shortAddress,
  tokensFor,
} from "./auction.js";

const PHASE_LABEL = {
  NOT_STARTED: "Not started",
  LIVE: "Live",
  SOLD_OUT: "Sold out",
  EXPIRED: "Time elapsed",
  FINALIZED: "Settled",
};

function useNow() {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function PriceCurve({ state, now, price }) {
  const elapsed = state.startTime ? Math.min(Math.max(now - state.startTime, 0), DURATION) : 0;
  const range = Number(state.startPrice - state.reservePrice);
  const x = 10 + (elapsed / DURATION) * 280;
  const y = 10 + (Number(state.startPrice - price) / range) * 80;
  return (
    <svg className="curve" viewBox="0 0 300 100" role="img" aria-label="Price decay curve">
      <line x1="10" y1="10" x2="290" y2="90" className="curve-line" />
      <line x1="10" y1={y} x2="290" y2={y} className="curve-level" />
      <circle cx={x} cy={Math.min(y, 10 + (elapsed / DURATION) * 80)} r="5" className="curve-dot" />
    </svg>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export default function App() {
  const now = useNow();
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [state, setState] = useState(null);
  const [bidInput, setBidInput] = useState("");
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);

  const provider = useMemo(() => (window.ethereum ? new BrowserProvider(window.ethereum, "any") : null), []);
  const wrongNetwork = deployment && chainId !== null && chainId !== deployment.chainId;

  const refresh = useCallback(async () => {
    if (!provider || !deployment) return;
    const network = await provider.getNetwork();
    setChainId(Number(network.chainId));
    if (Number(network.chainId) !== deployment.chainId) return;

    const auction = new Contract(deployment.auction.address, deployment.auction.abi, provider);
    const token = new Contract(deployment.token.address, deployment.token.abi, provider);
    const [
      symbol,
      owner,
      tokensForSale,
      startPrice,
      reservePrice,
      startTime,
      totalCommitted,
      finalized,
      clearingPrice,
      tokensSold,
      proceedsWithdrawn,
    ] = await Promise.all([
      token.symbol(),
      auction.owner(),
      auction.tokensForSale(),
      auction.startPrice(),
      auction.reservePrice(),
      auction.startTime(),
      auction.totalCommitted(),
      auction.finalized(),
      auction.clearingPrice(),
      auction.tokensSold(),
      auction.proceedsWithdrawn(),
    ]);
    const user = account
      ? await Promise.all([auction.commitments(account), auction.refunds(account), token.balanceOf(account)])
      : [0n, 0n, 0n];

    setState({
      symbol,
      owner,
      tokensForSale,
      startPrice,
      reservePrice,
      startTime: Number(startTime),
      totalCommitted,
      finalized,
      clearingPrice,
      tokensSold,
      proceedsWithdrawn,
      commitment: user[0],
      refund: user[1],
      tokenBalance: user[2],
    });
  }, [provider, account]);

  useEffect(() => {
    refresh().catch(console.error);
    const id = setInterval(() => refresh().catch(console.error), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccounts = (accounts) => setAccount(accounts[0] ?? null);
    const onChain = (id) => setChainId(Number(id));
    window.ethereum.request({ method: "eth_accounts" }).then(onAccounts).catch(console.error);
    window.ethereum.on("accountsChanged", onAccounts);
    window.ethereum.on("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAccounts);
      window.ethereum.removeListener("chainChanged", onChain);
    };
  }, []);

  const connect = async () => {
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts[0] ?? null);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  };

  const switchNetwork = async () => {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${deployment.chainId.toString(16)}` }],
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  };

  const send = async (label, call) => {
    setPending(label);
    setNotice(null);
    try {
      const signer = await provider.getSigner();
      const auction = new Contract(deployment.auction.address, deployment.auction.abi, signer);
      const tx = await call(auction);
      await tx.wait();
      setNotice({ kind: "success", text: `${label} confirmed.` });
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  if (!window.ethereum) {
    return <Shell><p className="empty">No Ethereum wallet detected. Install MetaMask to use this dApp.</p></Shell>;
  }
  if (!deployment) {
    return (
      <Shell>
        <p className="empty">
          No deployment found. Run <code>npm run deploy:local</code> in the project root, then reload.
        </p>
      </Shell>
    );
  }

  let bidWei = 0n;
  let bidValid = false;
  try {
    bidWei = parseEther(bidInput || "0");
    bidValid = bidWei > 0n;
  } catch {
    bidValid = false;
  }

  const header = (
    <div className="wallet">
      {account ? (
        <span className="pill">{shortAddress(account)}</span>
      ) : (
        <button onClick={connect}>Connect wallet</button>
      )}
    </div>
  );

  if (wrongNetwork || !state) {
    return (
      <Shell header={header}>
        {wrongNetwork ? (
          <div className="empty">
            <p>Your wallet is on the wrong network (expected chain {deployment.chainId}).</p>
            <button onClick={switchNetwork}>Switch network</button>
          </div>
        ) : (
          <p className="empty">Loading auction…</p>
        )}
      </Shell>
    );
  }

  const phase = phaseOf(state, now);
  const price = priceAt(state, now);
  const settlePrice = settlementPrice(state, now);
  const cap = commitmentCap(state, price);
  const remaining = cap > state.totalCommitted ? cap - state.totalCommitted : 0n;
  const progress = phase === "LIVE" ? Number((state.totalCommitted * 10000n) / (cap || 1n)) / 100 : 100;
  const secondsLeft = state.startTime ? Math.max(0, Math.ceil(state.startTime + DURATION - now)) : DURATION;
  const countdown = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const isOwner = account && account.toLowerCase() === state.owner.toLowerCase();
  const ended = phase !== "NOT_STARTED" && phase !== "LIVE";
  const canClaim = ended && (state.commitment > 0n || state.refund > 0n);
  const acceptedBid = bidWei < remaining ? bidWei : remaining;
  const busy = pending !== null;

  return (
    <Shell header={header}>
      <section className="card hero">
        <div className="hero-top">
          <span className={`badge badge-${phase.toLowerCase()}`}>{PHASE_LABEL[phase]}</span>
          <span className="countdown">{phase === "LIVE" ? countdown : phase === "NOT_STARTED" ? "20:00" : "00:00"}</span>
        </div>
        <div className="price">
          <span className="price-value">{fmt(ended ? settlePrice : price, 6)}</span>
          <span className="price-unit">ETH / {state.symbol}</span>
        </div>
        <p className="price-caption">
          {phase === "FINALIZED" ? "Final clearing price" : ended ? "Clearing price (awaiting settlement)" : "Current price"}
        </p>
        <PriceCurve state={state} now={now} price={ended ? settlePrice : price} />
        <div className="curve-labels">
          <span>Start {fmt(state.startPrice, 6)}</span>
          <span>Reserve {fmt(state.reservePrice, 6)}</span>
        </div>
        <div className="progress" aria-label="Demand versus supply">
          <div className="progress-bar" style={{ width: `${Math.min(progress, 100)}%` }} />
        </div>
        <div className="stats">
          <Stat label="Tokens for sale" value={`${fmt(state.tokensForSale, 2)} ${state.symbol}`} />
          <Stat label="Total committed" value={`${fmt(state.totalCommitted)} ETH`} />
          <Stat
            label={phase === "FINALIZED" ? "Tokens sold" : "Needed to sell out now"}
            value={phase === "FINALIZED" ? `${fmt(state.tokensSold, 2)} ${state.symbol}` : `${fmt(remaining)} ETH`}
            hint={phase === "FINALIZED" ? `${fmt(state.tokensForSale - state.tokensSold, 2)} burned` : null}
          />
        </div>
      </section>

      <div className="grid">
        <section className="card">
          <h2>Place a bid</h2>
          <p className="muted">
            Everyone pays the final clearing price. Bidding early locks in your ETH but never costs more per token.
          </p>
          <div className="field">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={bidInput}
              onChange={(e) => setBidInput(e.target.value)}
              disabled={phase !== "LIVE" || busy}
            />
            <span>ETH</span>
          </div>
          {bidValid && phase === "LIVE" && (
            <p className="muted">
              At least {fmt(tokensFor(acceptedBid, price), 2)} {state.symbol}
              {bidWei > remaining && ` · ${fmt(bidWei - remaining)} ETH over the cap will be refunded on claim`}
            </p>
          )}
          <button
            className="primary"
            disabled={!account || phase !== "LIVE" || !bidValid || busy}
            onClick={() => send("Bid", (auction) => auction.bid({ value: bidWei })).then(() => setBidInput(""))}
          >
            {pending === "Bid" ? "Bidding…" : account ? "Bid" : "Connect wallet to bid"}
          </button>
        </section>

        <section className="card">
          <h2>Your position</h2>
          <div className="rows">
            <div><span>Committed</span><strong>{fmt(state.commitment)} ETH</strong></div>
            <div>
              <span>{ended ? "Tokens to claim" : "Tokens at current price"}</span>
              <strong>{fmt(tokensFor(state.commitment, settlePrice), 2)} {state.symbol}</strong>
            </div>
            <div><span>Refund owed</span><strong>{fmt(state.refund)} ETH</strong></div>
            <div><span>Wallet balance</span><strong>{fmt(state.tokenBalance, 2)} {state.symbol}</strong></div>
          </div>
          <button className="primary" disabled={!canClaim || busy} onClick={() => send("Claim", (a) => a.claim())}>
            {pending === "Claim" ? "Claiming…" : "Claim tokens & refund"}
          </button>
          {(phase === "SOLD_OUT" || phase === "EXPIRED") && (
            <button disabled={!account || busy} onClick={() => send("Settlement", (a) => a.finalize())}>
              {pending === "Settlement" ? "Settling…" : "Settle auction"}
            </button>
          )}
        </section>
      </div>

      {isOwner && (
        <section className="card">
          <h2>Owner</h2>
          <div className="owner-actions">
            <button disabled={phase !== "NOT_STARTED" || busy} onClick={() => send("Start", (a) => a.start())}>
              {pending === "Start" ? "Starting…" : "Start auction"}
            </button>
            <button
              disabled={!ended || state.proceedsWithdrawn || busy}
              onClick={() => send("Withdrawal", (a) => a.withdrawProceeds())}
            >
              {state.proceedsWithdrawn
                ? "Proceeds withdrawn"
                : pending === "Withdrawal"
                  ? "Withdrawing…"
                  : `Withdraw ${fmt(state.totalCommitted)} ETH proceeds`}
            </button>
          </div>
        </section>
      )}

      {notice && <div className={`notice notice-${notice.kind}`}>{notice.text}</div>}
    </Shell>
  );
}

function Shell({ header, children }) {
  return (
    <main>
      <header>
        <h1>Dutch Auction Token Launch</h1>
        {header}
      </header>
      {children}
    </main>
  );
}
