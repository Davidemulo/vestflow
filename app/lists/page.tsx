"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import FullyFundedBadge from "@/components/FullyFundedBadge";
import AddressLabel from "@/components/AddressLabel";
import SearchFilterBar from "@/components/SearchFilterBar";
import { NoSearchResultsEmptyState } from "@/components/EmptyState";
import { stroopsToXlm } from "@/lib/stellar";
import { getTokenSymbol } from "@/lib/tokens";
import { DripsListData } from "@/components/DripsListDetail";

export default function DripsListsPage() {
  const [lists, setLists] = useState<DripsListData[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/api/lists?limit=50")
      .then(res => res.json())
      .then(data => {
        setLists(data.lists || []);
      })
      .catch(err => {
        console.error("Failed to load drips lists", err);
      })
      .finally(() => setLoading(false));
  }, []);

  const filteredLists = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return lists;
    return lists.filter(
      l =>
        l.name.toLowerCase().includes(q) ||
        l.id.toLowerCase().includes(q) ||
        l.owner.toLowerCase().startsWith(q) ||
        l.owner.toLowerCase().includes(q) ||
        getTokenSymbol(l.token).toLowerCase().includes(q)
    );
  }, [lists, query]);

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Drips Lists</h1>
            <p className="text-zinc-400 mt-1 text-sm">
              Continuous streaming funding pools distributed equally among members.
            </p>
          </div>
          <Link
            href="/app"
            className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3.5 py-2 transition-colors"
          >
            ← Dashboard
          </Link>
        </div>

        <div className="mb-6">
          <SearchFilterBar
            value={query}
            onChange={setQuery}
            placeholder="Filter lists by name, owner address, or token…"
            resultCount={filteredLists.length}
            totalCount={lists.length}
          />
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card p-6 h-40 animate-pulse bg-white/5" />
            ))}
          </div>
        ) : filteredLists.length === 0 ? (
          query ? (
            <NoSearchResultsEmptyState
              searchQuery={query}
              onClearSearch={() => setQuery("")}
            />
          ) : (
            <div className="card p-12 text-center text-zinc-400">
              No Drips lists found.
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredLists.map(list => {
              const tokenSymbol = getTokenSymbol(list.token);
              return (
                <Link
                  key={list.id}
                  href={`/lists/${encodeURIComponent(list.id)}`}
                  className="card p-6 hover:border-violet-500/40 transition-all block group space-y-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-bold text-white group-hover:text-violet-300 transition-colors">
                        {list.name}
                      </h3>
                      <p className="text-xs text-zinc-500 font-mono mt-0.5">ID: {list.id}</p>
                    </div>
                    <FullyFundedBadge
                      fundingRate={list.total_funding_rate_per_sec}
                      targetRate={list.target_rate_per_sec}
                      tokenSymbol={tokenSymbol}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-white/5 text-xs">
                    <div>
                      <p className="text-zinc-500">Rate / sec</p>
                      <p className="font-semibold text-white font-mono mt-0.5">
                        {stroopsToXlm(BigInt(list.total_funding_rate_per_sec))} {tokenSymbol}
                      </p>
                    </div>
                    <div>
                      <p className="text-zinc-500">Members</p>
                      <p className="font-semibold text-violet-300 mt-0.5">
                        {list.member_count}
                      </p>
                    </div>
                    <div>
                      <p className="text-zinc-500">Target Rate</p>
                      <p className="font-semibold text-zinc-300 mt-0.5">
                        {list.target_rate_per_sec !== "0"
                          ? `${stroopsToXlm(BigInt(list.target_rate_per_sec))} /s`
                          : "—"}
                      </p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
