import { useEffect, useState } from "react";

const KEY = "wsa.showGuessChords";
const LOCAL_EVENT = "wsa-show-guesses"; // the storage event only reaches other windows

const read = () => {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
};

/**
 * "Show detected chords (guess)": off by default. Shared by the Session band, the transport bar and the
 * projector window (same origin: the storage event carries a change to the other windows).
 */
export function useShowGuesses(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === KEY && setOn(read());
    const onLocal = () => setOn(read());
    window.addEventListener("storage", onStorage);
    window.addEventListener(LOCAL_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LOCAL_EVENT, onLocal);
    };
  }, []);
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      /* not remembered */
    }
    window.dispatchEvent(new Event(LOCAL_EVENT));
  };
  return [on, set];
}
