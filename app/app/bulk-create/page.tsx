"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "@/components/Navbar";
import BulkCreateTable, { DisplayRow, SubmitStatus } from "@/components/BulkCreateTable";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/WalletContext";
import {
  createSchedule,
  estimateCreateScheduleFee,
  getWalletXlmBalance,
  parseContractError,
  stroopsToXlm,
} from "@/lib/stellar";
import {
  BULK_CREATE_CSV_TEMPLATE,
  MAX_BULK_CREATE_ROWS,
  ValidatedRow,
  chunkRows,
  splitByAvailableBalance,
  validateCsv,
} from "@/lib/csv-validation";
import { useCsvValidationWorker } from "@/lib/useCsvValidationWorker";
import { downloadCSV } from "@/lib/csvExport";

export default function BulkCreatePage() {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const validateInWorker = useCsvValidationWorker();

  const [fileName, setFileName] = useState("");
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [validRows, setValidRows] = useState<ValidatedRow[]>([]);
  const [invalidRows, setInvalidRows] = useState<
    ReturnType<typeof validateCsv>["invalidRows"]
  >([]);
  const [unfundableIds, setUnfundableIds] = useState<Set<number>>(new Set());
  const [availableStroops, setAvailableStroops] = useState<bigint | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);

  const [results, setResults] = useState<Record<number, { status: SubmitStatus; message?: string }>>(
    {}
  );
  const [running, setRunning] = useState(false);
  const [activeBatchIndex, setActiveBatchIndex] = useState<number | null>(null);
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 });

  const [batchFees, setBatchFees] = useState<Record<number, bigint>>({});
  const [simulating, setSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setResults({});
    setBatchProgress({ done: 0, total: 0 });
    setActiveBatchIndex(null);
    setAvailableStroops(null);
    setUnfundableIds(new Set());
    setBatchFees({});
    setSimulationError(null);

    const text = await file.text();
    let parsed: ReturnType<typeof validateCsv>;
    try {
      parsed = await validateInWorker(text);
    } catch {
      parsed = validateCsv(text);
    }
    setValidRows(parsed.validRows);
    setInvalidRows(parsed.invalidRows);
    setHeaderError(parsed.headerError);

    if (!parsed.headerError && publicKey && parsed.validRows.length > 0) {
      setCheckingBalance(true);
      try {
        const available = await getWalletXlmBalance(publicKey);
        setAvailableStroops(available);
        const { unfundable } = splitByAvailableBalance(parsed.validRows, available);
        setUnfundableIds(new Set(unfundable.map((r) => r.rowIndex)));
      } finally {
        setCheckingBalance(false);
      }
    }
  };

  const handleReset = () => {
    setFileName("");
    setValidRows([]);
    setInvalidRows([]);
    setHeaderError(null);
    setResults({});
    setBatchProgress({ done: 0, total: 0 });
    setActiveBatchIndex(null);
    setAvailableStroops(null);
    setUnfundableIds(new Set());
    setBatchFees({});
    setSimulationError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const fundableRows = useMemo(
    () => validRows.filter((r) => !unfundableIds.has(r.rowIndex)),
    [validRows, unfundableIds]
  );

  const batches = useMemo(() => chunkRows(fundableRows), [fundableRows]);

  // Fee simulation, per batch, before the user signs anything. Soroban only
  // allows one Soroban operation per transaction, so each batch's total is
  // estimated from a single representative row's simulated fee × batch size
  // rather than simulating one combined transaction.
  useEffect(() => {
    if (!publicKey || batches.length === 0) {
      setBatchFees({});
      return;
    }
    let cancelled = false;
    setSimulating(true);
    setSimulationError(null);

    (async () => {
      for (let i = 0; i < batches.length; i++) {
        if (cancelled) return;
        const representative = batches[i][0];
        try {
          const perOpFee = await estimateCreateScheduleFee(
            publicKey,
            representative.beneficiary,
            representative.amountXlm,
            representative.token,
            representative.startTime,
            representative.durationDays,
            representative.cliffDays,
            representative.kind,
            representative.revocable
          );
          if (cancelled) return;
          setBatchFees((prev) => ({ ...prev, [i]: perOpFee * BigInt(batches[i].length) }));
        } catch (e: any) {
          if (!cancelled) setSimulationError(e?.message || "Fee simulation failed for one or more batches.");
        }
      }
      if (!cancelled) setSimulating(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [batches, publicKey]);

  const totalEstFeeStroops = useMemo(
    () => Object.values(batchFees).reduce((sum, fee) => sum + fee, 0n),
    [batchFees]
  );

  const displayRows: DisplayRow[] = useMemo(() => {
    const merged: DisplayRow[] = [
      ...validRows.map((row) => ({
        rowIndex: row.rowIndex,
        valid: row,
        invalid: null,
        fundable: !unfundableIds.has(row.rowIndex),
        status: results[row.rowIndex]?.status,
        statusMessage: results[row.rowIndex]?.message,
      })),
      ...invalidRows.map((row) => ({
        rowIndex: row.rowIndex,
        valid: null,
        invalid: row,
        fundable: false,
      })),
    ];
    return merged.sort((a, b) => a.rowIndex - b.rowIndex);
  }, [validRows, invalidRows, unfundableIds, results]);

  const runBatch = async (rows: ValidatedRow[], batchIndex: number) => {
    if (!publicKey || rows.length === 0) return { succeeded: 0, failed: 0 };
    setActiveBatchIndex(batchIndex);
    setBatchProgress({ done: 0, total: rows.length });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setResults((r) => ({ ...r, [row.rowIndex]: { status: "pending" } }));
      try {
        await createSchedule(
          publicKey,
          row.beneficiary,
          row.amountXlm,
          row.token,
          row.startTime,
          row.durationDays,
          row.cliffDays,
          row.kind,
          row.revocable
        );
        setResults((r) => ({ ...r, [row.rowIndex]: { status: "success" } }));
        succeeded++;
      } catch (e: any) {
        setResults((r) => ({
          ...r,
          [row.rowIndex]: { status: "error", message: parseContractError(e) },
        }));
        failed++;
      } finally {
        setBatchProgress((p) => ({ ...p, done: i + 1 }));
      }
    }

    return { succeeded, failed };
  };

  const handleSubmitAllBatches = async () => {
    if (!publicKey || batches.length === 0) return;
    setRunning(true);
    const toastId = addToast({
      status: "pending",
      title: `Submitting ${batches.length} batch${batches.length !== 1 ? "es" : ""} (${fundableRows.length} schedules)…`,
      message: "Approve each transaction in Freighter as it's requested. A failed batch won't stop the rest.",
    });

    let totalSucceeded = 0;
    let totalFailed = 0;
    for (let b = 0; b < batches.length; b++) {
      const { succeeded, failed } = await runBatch(batches[b], b);
      totalSucceeded += succeeded;
      totalFailed += failed;
    }

    setActiveBatchIndex(null);
    setRunning(false);
    updateToast(toastId, {
      status: totalFailed === 0 ? "success" : totalSucceeded === 0 ? "error" : "success",
      title: "Bulk create finished",
      message:
        totalFailed === 0
          ? `All ${totalSucceeded} schedules created successfully.`
          : `${totalSucceeded} created, ${totalFailed} failed. Retry individual batches below.`,
    });
  };

  const handleRetryBatch = async (batchIndex: number) => {
    const failedRows = batches[batchIndex].filter((r) => results[r.rowIndex]?.status === "error");
    if (failedRows.length === 0 || !publicKey) return;
    setRunning(true);
    await runBatch(failedRows, batchIndex);
    setActiveBatchIndex(null);
    setRunning(false);
  };

  const overallDone = useMemo(() => {
    const fundableIds = new Set(fundableRows.map((r) => r.rowIndex));
    return Object.entries(results).filter(
      ([id, r]) => fundableIds.has(Number(id)) && (r.status === "success" || r.status === "error")
    ).length;
  }, [results, fundableRows]);

  const canSubmit =
    !!publicKey && !running && !simulating && !checkingBalance && fundableRows.length > 0;

  if (!publicKey) {
    return (
      <>
        <Navbar />
        <main className="max-w-4xl mx-auto px-6 pt-28 pb-20">
          <div className="card p-8 flex flex-col items-center gap-3 text-center">
            <span className="text-4xl" aria-hidden="true">🔒</span>
            <p className="font-semibold text-zinc-200">Wallet not connected</p>
            <p className="text-zinc-400 text-sm">
              Connect your Freighter wallet to bulk-create vesting schedules.
            </p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="max-w-4xl mx-auto px-6 pt-28 pb-20 flex flex-col gap-6">
        <div>
          <h1 className="text-3xl font-bold">Bulk Create Schedules</h1>
          <p className="text-zinc-400 mt-1">
            Upload a CSV of up to {MAX_BULK_CREATE_ROWS} beneficiary schedules to create them in one pass.
          </p>
        </div>

        <div className="card p-6 flex flex-col gap-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-lg font-semibold">Upload CSV</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Columns: <code className="font-mono">beneficiary, token, amount_xlm, start_time_iso,
                duration_days, cliff_days, kind, revocable</code>. cliff_days and revocable are optional.
              </p>
            </div>
            <button
              type="button"
              onClick={() => downloadCSV(BULK_CREATE_CSV_TEMPLATE, "vestflow-bulk-create-template.csv")}
              className="text-sm text-violet-400 hover:underline shrink-0"
            >
              Download CSV template
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
            disabled={running}
            className="input file:mr-3 file:rounded-lg file:border-0 file:bg-violet-500/15 file:text-violet-200 file:px-3 file:py-1.5 file:text-sm"
          />

          {headerError && (
            <p className="text-sm text-red-400" role="alert">
              {headerError}
            </p>
          )}

          {checkingBalance && <p className="text-sm text-zinc-500">Checking wallet balance…</p>}

          {!headerError && availableStroops !== null && unfundableIds.size > 0 && (
            <p className="text-sm text-amber-400" role="alert">
              Insufficient balance: {stroopsToXlm(availableStroops)} XLM available. {unfundableIds.size} row
              {unfundableIds.size !== 1 ? "s" : ""} at the bottom cannot be funded and will be skipped.
            </p>
          )}

          {(validRows.length > 0 || invalidRows.length > 0) && !headerError && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm text-zinc-300">{fileName}</p>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={running}
                  className="text-xs text-zinc-500 hover:text-white transition-colors disabled:opacity-40"
                >
                  Clear file
                </button>
              </div>

              <BulkCreateTable rows={displayRows} />

              {batches.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="text-sm font-medium text-zinc-300">
                      Batches ({batches.length}, up to 50 schedules each)
                    </p>
                    {simulating && <p className="text-xs text-zinc-500">Simulating fees…</p>}
                  </div>
                  {simulationError && (
                    <p className="text-xs text-red-400" role="alert">
                      {simulationError}
                    </p>
                  )}
                  <ul className="flex flex-col gap-1.5">
                    {batches.map((batch, i) => {
                      const fee = batchFees[i];
                      const succeededCount = batch.filter(
                        (r) => results[r.rowIndex]?.status === "success"
                      ).length;
                      const failedCount = batch.filter(
                        (r) => results[r.rowIndex]?.status === "error"
                      ).length;
                      const isActive = activeBatchIndex === i;
                      return (
                        <li
                          key={i}
                          className="flex items-center justify-between gap-3 flex-wrap text-xs px-3 py-2 rounded-lg border border-white/8"
                        >
                          <span className="text-zinc-300">
                            Batch {i + 1}: {batch.length} schedule{batch.length !== 1 ? "s" : ""}
                            {fee !== undefined && <> · est. fee {stroopsToXlm(fee)} XLM</>}
                          </span>
                          <span className="flex items-center gap-3">
                            {isActive && (
                              <span className="text-zinc-400">
                                {batchProgress.done}/{batchProgress.total}
                              </span>
                            )}
                            {!isActive && succeededCount + failedCount > 0 && (
                              <span className={failedCount > 0 ? "text-amber-400" : "text-emerald-400"}>
                                {succeededCount} ok{failedCount > 0 ? `, ${failedCount} failed` : ""}
                              </span>
                            )}
                            {!running && failedCount > 0 && (
                              <button
                                type="button"
                                onClick={() => handleRetryBatch(i)}
                                className="text-violet-400 hover:underline"
                              >
                                Retry batch
                              </button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-sm text-zinc-300">
                    Total estimated fee: {stroopsToXlm(totalEstFeeStroops)} XLM
                  </p>
                </div>
              )}

              {running && (
                <p className="text-sm text-zinc-400">
                  Batch {(activeBatchIndex ?? 0) + 1} of {batches.length} — {overallDone}/{fundableRows.length}{" "}
                  schedules submitted…
                </p>
              )}

              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={handleSubmitAllBatches}
                  disabled={!canSubmit}
                  className="btn-primary rounded-xl py-3 px-5 font-semibold text-white disabled:opacity-60"
                >
                  {running
                    ? "Submitting…"
                    : `Submit All Batches (${fundableRows.length} Schedule${fundableRows.length !== 1 ? "s" : ""})`}
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
