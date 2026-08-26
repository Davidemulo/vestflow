"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import ScheduleCard from "@/components/ScheduleCard";
import CopyLinkButton from "@/components/CopyLinkButton";
import AddressLabel from "@/components/AddressLabel";
import SearchFilterBar from "@/components/SearchFilterBar";
import { NoSearchResultsEmptyState } from "@/components/EmptyState";
import { ScheduleListSkeleton } from "@/components/ScheduleCardSkeleton";
import {
  getGrantorScheduleIds,
  getBeneficiaryScheduleIds,
  getScheduleBatch,
  ScheduleData,
  stroopsToXlm,
  vestingProgress,
  truncate,
  NETWORK,
} from "@/lib/stellar";
import { matchesAddressOrToken } from "@/lib/tokens";
import { useAddressBook } from "@/hooks/useAddressBook";

interface ProfileViewProps {
  address: string;
}

export default function ProfileView({ address }: ProfileViewProps) {
  const { getLabel } = useAddressBook();
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | "grantor" | "beneficiary">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      try {
        const [grantorIds, beneficiaryIds] = await Promise.all([
          getGrantorScheduleIds(address).catch(() => []),
          getBeneficiaryScheduleIds(address).catch(() => []),
        ]);
        const allIds = [...new Set([...grantorIds, ...beneficiaryIds])].sort((a, b) => a - b);
        if (allIds.length > 0) {
          const list = (await getScheduleBatch(allIds, address)).filter(Boolean) as ScheduleData[];
          if (mounted) setSchedules(list);
        } else {
          if (mounted) setSchedules([]);
        }
      } catch (e) {
        console.error("Failed to load profile schedules", e);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [address]);

  const stats = useMemo(() => {
    let totalGranted = 0n;
    let totalReceiving = 0n;
    let activeCount = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const s of schedules) {
      if (s.grantor === address) totalGranted += s.total_amount;
      if (s.beneficiary === address) totalReceiving += s.total_amount;
      if (!s.revoked && vestingProgress(s, now) < 100) activeCount++;
    }

    return { totalGranted, totalReceiving, activeCount };
  }, [schedules, address]);

  const tabFiltered = useMemo(() => {
    if (activeTab === "grantor") return schedules.filter(s => s.grantor === address);
    if (activeTab === "beneficiary") return schedules.filter(s => s.beneficiary === address);
    return schedules;
  }, [schedules, activeTab, address]);

  const searchFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabFiltered;
    return tabFiltered.filter(s =>
      matchesAddressOrToken(
        q,
        [s.grantor, s.beneficiary],
        [s.token],
        [getLabel(s.grantor), getLabel(s.beneficiary)]
      )
    );
  }, [tabFiltered, query, getLabel]);

  const customLabel = getLabel(address);

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        {/* Profile Header */}
        <div className="card p-6 sm:p-8 mb-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center text-2xl font-bold text-white shadow-lg shadow-violet-500/20">
                {address.slice(0, 2)}
              </div>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-bold text-white">
                    {customLabel || truncate(address)}
                  </h1>
                  <span className="text-xs px-2.5 py-0.5 rounded-full border border-white/10 bg-white/5 text-zinc-400 font-mono">
                    {NETWORK}
                  </span>
                </div>
                <div className="mt-1">
                  <AddressLabel address={address} />
                </div>
              </div>
            </div>

            {/* Copy Profile Link Sharing Button (Issue #648) */}
            <div className="flex items-center gap-3">
              <CopyLinkButton label="Copy Profile Link" />
            </div>
          </div>

          {/* Profile Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-white/5">
            <div className="p-3 bg-white/3 rounded-xl border border-white/5">
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Total Outgoing</p>
              <p className="text-lg font-bold text-white">{stroopsToXlm(stats.totalGranted)} XLM</p>
              <p className="text-[11px] text-zinc-500">as grantor</p>
            </div>
            <div className="p-3 bg-white/3 rounded-xl border border-white/5">
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Total Inbound</p>
              <p className="text-lg font-bold text-emerald-400">{stroopsToXlm(stats.totalReceiving)} XLM</p>
              <p className="text-[11px] text-zinc-500">as beneficiary</p>
            </div>
            <div className="p-3 bg-white/3 rounded-xl border border-white/5">
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Active Streams</p>
              <p className="text-lg font-bold text-white">{stats.activeCount}</p>
              <p className="text-[11px] text-zinc-500">currently vesting</p>
            </div>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
          <div className="flex gap-2">
            {(
              [
                { id: "all", label: `All Streams (${schedules.length})` },
                { id: "grantor", label: "Outgoing" },
                { id: "beneficiary", label: "Incoming" },
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`text-xs px-3.5 py-2 rounded-lg border font-medium transition-colors ${
                  activeTab === tab.id
                    ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                    : "border-white/10 text-zinc-400 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="w-full sm:w-72">
            <SearchFilterBar
              value={query}
              onChange={setQuery}
              placeholder="Filter streams by address or token…"
            />
          </div>
        </div>

        {/* Stream List */}
        {loading ? (
          <ScheduleListSkeleton count={4} />
        ) : searchFiltered.length === 0 ? (
          query ? (
            <NoSearchResultsEmptyState
              searchQuery={query}
              onClearSearch={() => setQuery("")}
            />
          ) : (
            <div className="card p-12 text-center text-zinc-400">
              No schedules found for this account.
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {searchFiltered.map(schedule => (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
               
              />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
