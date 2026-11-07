const STORAGE_KEY = "t3code:snap-shot-setup-resume:v1";

export function readSnapShotSetupResume(): { wasEnabled: boolean } | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === "enabled" || value === "disabled") return { wasEnabled: value === "enabled" };
  } catch {}
  return null;
}

export function saveSnapShotSetupResume(wasEnabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, wasEnabled ? "enabled" : "disabled");
  } catch {}
}

export function clearSnapShotSetupResume(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
