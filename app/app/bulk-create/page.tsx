"use client";
import { useMemo, useRef, useState } from "react";
import Navbar from "@/components/Navbar";
import BulkCreateTable, { DisplayRow, SubmitStatus } from "@/components/BulkCreateTable";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/WalletContext";
import { createSchedule, getWalletXlmBalance, parseContractError, stroopsToXlm } from "@/lib/stellar";
import {
  BULK_CREATE_CSV_TEMPLATE,
  MAX_BULK_CREATE_ROWS,
  ValidatedRow,
  splitByAvailableBalance,
  validateCsv,
} from "@/lib/csv-validation";
import { downloadCSV } from "@/lib/csvExport";

export default function BulkCreatePage() {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setResults({});
    setProgress({ done: 0, total: 0 });
    setAvailableStroops(null);
    setUnfundableIds(new Set());

    const text = await file.text();
    const parsed = validateCsv(text);
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
    setProgress({ done: 0, total: 0 });
    setAvailableStroops(null);
    setUnfundableIds(new Set());
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const fundableRows = useMemo(
    () => validRows.filter((r) => !unfundableIds.has(r.rowIndex)),
    [validRows, unfundableIds]
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

  const runRows = async (rows: ValidatedRow[]) => {
    if (!publicKey || rows.length === 0) return;
    setRunning(true);
    setProgress({ done: 0, total: rows.length });

    const toastId = addToast({
      status: "pending",
      title: `Creating ${rows.length} schedule${rows.length !== 1 ? "s" : ""}…`,
      message: "Approve each transaction in Freighter as it's requested.",
    });

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
        setProgress({ done: i + 1, total: rows.length });
      }
    }

    setRunning(false);
    updateToast(toastId, {
      status: failed === 0 ? "success" : succeeded === 0 ? "error" : "success",
      title: "Bulk create finished",
      message:
        failed === 0
          ? `All ${succeeded} schedules created successfully.`
          : `${succeeded} created, ${failed} failed. See the table for details.`,
    });
  };

  const handleSubmitAll = () => runRows(fundableRows);
  const handleRetryFailed = () => {
    const failedRows = fundableRows.filter((r) => results[r.rowIndex]?.status === "error");
    runRows(failedRows);
  };

  const hasFailures = Object.values(results).some((r) => r.status === "error");
  const hasCompletedRun = progress.total > 0 && progress.done === progress.total && !running;
  const canSubmit = !!publicKey && !running && fundableRows.length > 0 && !checkingBalance;

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

              {running && (
                <p className="text-sm text-zinc-400">
                  Creating schedule {progress.done + 1} of {progress.total}…
                </p>
              )}

              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={handleSubmitAll}
                  disabled={!canSubmit}
                  className="btn-primary rounded-xl py-3 px-5 font-semibold text-white disabled:opacity-60"
                >
                  {running
                    ? "Creating…"
                    : `Create ${fundableRows.length} Schedule${fundableRows.length !== 1 ? "s" : ""}`}
                </button>
                {hasCompletedRun && hasFailures && (
                  <button
                    onClick={handleRetryFailed}
                    disabled={running}
                    className="rounded-xl py-3 px-5 border border-white/10 text-zinc-300 hover:border-white/30 transition-colors text-sm disabled:opacity-60"
                  >
                    Retry Failed Rows
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
