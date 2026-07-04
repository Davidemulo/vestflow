"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { NETWORK, stroopsToXlm } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

interface IndexedEvent {
  id: string;
  event_type: "schedule_created" | "claimed" | "revoked" | "unknown";
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
  grantor: string | null;
  beneficiary: string | null;
  amount: string | null;
  token: string | null;
  created_amount: string | null;
  created_at: number;
}

const PAGE_SIZE = 10;

function formatEventDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

export default function TransactionHistory() {
  const { publicKey } = useWallet();
  const [events, setEvents] = useState<IndexedEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!publicKey) return;
    setLoading(true);
    setErr("");

    fetch(`/api/events?address=${publicKey}&network=${NETWORK}&limit=200`)
      .then(r => r.json())
      .then(data => {
        const filtered: IndexedEvent[] = (data.events ?? []).filter(
          (e: IndexedEvent) => e.event_type === "claimed" || e.event_type === "revoked"
        );
        filtered.sort((a, b) => b.ledger - a.ledger);
        setEvents(filtered);
      })
      .catch(() => {
        setErr("Transaction history requires the indexer service.");
      })
      .finally(() => setLoading(false));
  }, [publicKey]);

  // Reset to page 1 when events change
  useEffect(() => { setPage(1); }, [events.length]);

  if (!publicKey) {
    return (
      <div className="card p-8 text-center text-zinc-400">
        Connect your wallet to view transaction history.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card p-6 flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  if (err) {
    return (
      <div className="card p-6 text-sm text-zinc-500 text-center">{err}</div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="card p-8 text-center text-zinc-400">
        No claim or revoke transactions found for your wallet.
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const paginated = events.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-white/5">
              <th className="text-left py-3 pr-4 font-medium">Type</th>
              <th className="text-left py-3 pr-4 font-medium">Schedule</th>
              <th className="text-left py-3 pr-4 font-medium">Amount</th>
              <th className="text-left py-3 pr-4 font-medium">Date</th>
              <th className="text-left py-3 font-medium">Ledger</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(event => (
              <tr
                key={event.id}
                className="border-b border-white/5 hover:bg-white/3 transition-colors"
              >
                <td className="py-3 pr-4">
                  {event.event_type === "claimed" ? (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">
                      Claim
                    </span>
                  ) : (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-500/10 text-red-400">
                      Revoke
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4 text-zinc-300">
                  {event.schedule_id !== null ? (
                    <Link
                      href={`/schedule/${event.schedule_id}`}
                      className="hover:text-violet-400 transition-colors"
                    >
                      #{event.schedule_id}
                    </Link>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="py-3 pr-4 text-zinc-300 font-mono">
                  {event.event_type === "claimed" && event.amount !== null
                    ? `${stroopsToXlm(BigInt(event.amount))} XLM`
                    : <span className="text-zinc-600">—</span>}
                </td>
                <td className="py-3 pr-4 text-zinc-400">
                  {formatEventDate(event.ledger_closed_at)}
                </td>
                <td className="py-3">
                  <a
                    href={`https://stellar.expert/explorer/${NETWORK}/ledger/${event.ledger}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-violet-400 hover:underline font-mono text-xs"
                  >
                    {event.ledger}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <p className="text-sm text-zinc-500">
            Showing{" "}
            <span className="text-zinc-300">
              {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, events.length)}
            </span>{" "}
            of <span className="text-zinc-300">{events.length}</span> events
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
            >
              ← Previous
            </button>
            <span className="text-sm text-zinc-500">{page} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
