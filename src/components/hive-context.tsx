"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

interface Hive {
  id: string;
  slug: string;
  name: string;
  type: string;
}

interface HiveContextValue {
  hives: Hive[];
  selected: Hive | null;
  selectHive: (id: string) => void;
  refreshHives?: (preferredHiveId?: string) => Promise<void>;
  loading: boolean;
  hasProvider?: boolean;
}

const HiveContext = createContext<HiveContextValue>({
  hives: [],
  selected: null,
  selectHive: () => {},
  refreshHives: async () => {},
  loading: false,
  hasProvider: false,
});

export function useHiveContext() {
  return useContext(HiveContext);
}

export function HiveProvider({ children }: { children: ReactNode }) {
  const [hives, setHives] = useState<Hive[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const refreshHives = useCallback(async (preferredHiveId?: string) => {
    setLoading(true);
    try {
      const response = await fetch("/api/hives");
      const body = await response.json();
      const list = body.data || [];
      setHives(list);
      const stored = preferredHiveId ?? localStorage.getItem("selectedHiveId");
      const match = list.find((b: Hive) => b.id === stored);
      if (match) {
        setSelectedId(match.id);
        localStorage.setItem("selectedHiveId", match.id);
      } else if (list.length > 0) {
        setSelectedId(list[0].id);
        localStorage.setItem("selectedHiveId", list[0].id);
      } else {
        setSelectedId("");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHives();
  }, [refreshHives]);

  const selectHive = (id: string) => {
    setSelectedId(id);
    localStorage.setItem("selectedHiveId", id);
  };

  const selected = hives.find((b) => b.id === selectedId) || null;

  return (
    <HiveContext.Provider value={{ hives, selected, selectHive, refreshHives, loading, hasProvider: true }}>
      {children}
    </HiveContext.Provider>
  );
}
