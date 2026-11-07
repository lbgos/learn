import type { SVGProps } from "react";

// Keep the existing component name for callers; the visible mark belongs to lbgos learn.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <ellipse cx="20" cy="20" rx="18" ry="7" transform="rotate(60 20 20)" />
        <ellipse cx="20" cy="20" rx="18" ry="7" transform="rotate(-60 20 20)" />
        <ellipse cx="20" cy="20" rx="18" ry="7" />
      </g>
      <circle cx="20" cy="20" r="3" fill="currentColor" />
    </svg>
  );
}
