"use client";
import Navbar from "@/components/Navbar";
import TransactionHistory from "@/components/TransactionHistory";

export default function HistoryPage() {
  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">Transaction History</h1>
          <p className="text-zinc-400 mt-1">Your claim and revoke events</p>
        </div>
        <TransactionHistory />
      </main>
    </>
  );
}
