"use client";

import { useCallback, useEffect, useState } from "react";

const ADDRESS_BOOK_KEY = "vestflow-address-book";
const ADDRESS_BOOK_EVENT = "vestflow-address-book-updated";

type AddressBook = Record<string, string>;

function sanitizeAddressBook(value: unknown): AddressBook {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([address, label]) =>
        typeof address === "string" &&
        typeof label === "string" &&
        label.trim().length > 0
    )
  );
}

function readAddressBook(): AddressBook {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(ADDRESS_BOOK_KEY);
    if (!stored) {
      return {};
    }

    return sanitizeAddressBook(JSON.parse(stored));
  } catch {
    return {};
  }
}

function writeAddressBook(addressBook: AddressBook): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(ADDRESS_BOOK_KEY, JSON.stringify(addressBook));
  window.dispatchEvent(new Event(ADDRESS_BOOK_EVENT));
}

export function useAddressBook() {
  const [addressBook, setAddressBook] = useState<AddressBook>({});

  useEffect(() => {
    const sync = () => {
      setAddressBook(readAddressBook());
    };

    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(ADDRESS_BOOK_EVENT, sync);

    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(ADDRESS_BOOK_EVENT, sync);
    };
  }, []);

  const getLabel = useCallback(
    (address: string): string | null => {
      const label = addressBook[address];
      return label?.trim() ? label.trim() : null;
    },
    [addressBook]
  );

  const setLabel = useCallback((address: string, label: string) => {
    const trimmed = label.trim();

    setAddressBook((current) => {
      const next = { ...current };

      if (trimmed) {
        next[address] = trimmed;
      } else {
        delete next[address];
      }

      writeAddressBook(next);
      return next;
    });
  }, []);

  const removeLabel = useCallback((address: string) => {
    setAddressBook((current) => {
      if (!(address in current)) {
        return current;
      }

      const next = { ...current };
      delete next[address];
      writeAddressBook(next);
      return next;
    });
  }, []);

  return {
    addressBook,
    getLabel,
    setLabel,
    removeLabel,
  };
}
