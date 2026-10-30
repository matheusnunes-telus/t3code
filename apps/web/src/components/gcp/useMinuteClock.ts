import { useEffect, useState } from "react";

/** The wall clock, ticking each minute, for relative ages. */
export function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/react-effect-budget -- relative ages tick with the wall clock, which nothing in React announces.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
