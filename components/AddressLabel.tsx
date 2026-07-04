"use client";

import { useEffect, useState } from "react";
import { truncate } from "@/lib/stellar";
import { useAddressBook } from "@/hooks/useAddressBook";

interface AddressLabelProps {
  address: string;
  fullAddress?: boolean;
  compact?: boolean;
  editable?: boolean;
  className?: string;
  primaryClassName?: string;
  secondaryClassName?: string;
}

export default function AddressLabel({
  address,
  fullAddress = false,
  compact = false,
  editable = false,
  className = "",
  primaryClassName = "",
  secondaryClassName = "",
}: AddressLabelProps) {
  const { getLabel, setLabel, removeLabel } = useAddressBook();
  const label = getLabel(address);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? "");

  useEffect(() => {
    setDraft(label ?? "");
  }, [label]);

  const shortAddress = truncate(address, compact ? 4 : 6, compact ? 3 : 4);
  const visibleAddress = fullAddress ? address : shortAddress;

  const handleSave = () => {
    setLabel(address, draft);
    setEditing(false);
  };

  const handleRemove = () => {
    removeLabel(address);
    setDraft("");
    setEditing(false);
  };

  return (
    <div className={`flex flex-col gap-1 ${className}`.trim()}>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={
            primaryClassName ||
            (label
              ? "text-sm font-semibold text-zinc-100"
              : "text-sm font-mono text-zinc-300 break-all")
          }
          title={address}
        >
          {label ?? visibleAddress}
        </span>

        {editable && (
          <button
            type="button"
            onClick={() => setEditing((current) => !current)}
            className="text-[11px] text-violet-300 hover:text-violet-200 transition-colors"
          >
            {editing ? "Cancel" : label ? "Edit label" : "Add label"}
          </button>
        )}
      </div>

      {label && (
        <span
          className={
            secondaryClassName ||
            "text-xs font-mono text-zinc-500 break-all"
          }
          title={address}
        >
          {visibleAddress}
        </span>
      )}

      {editing && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="e.g. Team wallet"
            className="min-w-[12rem] flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-violet-500/50"
          />
          <button
            type="button"
            onClick={handleSave}
            disabled={!draft.trim()}
            className="rounded-lg bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-200 transition-colors hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
          {label && (
            <button
              type="button"
              onClick={handleRemove}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-white"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
