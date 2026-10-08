"use client";

import { useEffect, useState } from "react";

export function useResolutionDeadline(deadline: string | null | undefined) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      clearTimeout(timer); const remaining = deadline ? Date.parse(deadline) - Date.now() : 0;
      setExpired(remaining <= 0);
      if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    }
    timer = setTimeout(check, 0); document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", check); };
  }, [deadline]);
  return expired || !deadline;
}
