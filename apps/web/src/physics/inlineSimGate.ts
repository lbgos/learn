/** At most one inline transcript sim plays at a time; starting one pauses the previous. */
let active: { readonly id: string; readonly pause: () => void } | null = null;

export function claimInlineSim(id: string, pause: () => void): void {
  if (active !== null && active.id !== id) active.pause();
  active = { id, pause };
}

export function releaseInlineSim(id: string): void {
  if (active?.id === id) active = null;
}
