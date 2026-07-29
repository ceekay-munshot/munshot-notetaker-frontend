// src/hooks/useHostContext.ts
import { useEffect, useState } from "react";
import { sdk, type SessionContext } from "../lib/sdk";

const EMPTY_SESSION: SessionContext = {
  token: null, userName: null, email: null, orgId: null, orgName: null,
};

export function useHostContext() {
  const [session, setSession] = useState<SessionContext>(EMPTY_SESSION);
  const [ticker, setTicker] = useState<string | null>(null);
  const [tickerCompany, setTickerCompany] = useState<string | null>(null);
  const [tickerCountry, setTickerCountry] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      const ctx = sdk.getContext();
      if (!ctx) return;
      if (ctx.session) setSession({ ...EMPTY_SESSION, ...ctx.session });
      if (ctx.market) {
        setTicker(ctx.market.selectedTicker ?? null);
        setTickerCompany(ctx.market.selectedTickerCompany ?? null);
        setTickerCountry(ctx.market.selectedTickerCountry ?? null);
        setSelectedSymbol(ctx.market.selectedSymbol ?? null);
      }
    };

    sync();                    // apply already-cached context (host:init may
                               // have arrived before this component mounted)
    return sdk.onMessage(sync); // re-sync on every host message; returns unsub
  }, []);

  return { session, ticker, tickerCompany, tickerCountry, selectedSymbol };
}
