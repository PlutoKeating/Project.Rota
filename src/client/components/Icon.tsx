import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type IconName = "overview" | "terms" | "people" | "timetable" | "tasks" | "schedule" | "fairness" | "imports" | "settings";

const PATHS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
  terms: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M8 3v4M16 3v4M3.5 10h17" />
      <path d="M8 14h2M14 14h2M8 17.5h2" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" />
      <path d="M16 11a3 3 0 0 0 0-6" />
      <path d="M17.5 19.5c0-2.2-.8-4.1-2.1-5.4" />
    </>
  ),
  timetable: (
    <>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M9 9.5v11M15 9.5v11" />
    </>
  ),
  tasks: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  ),
  schedule: (
    <>
      <rect x="3" y="5" width="18" height="15.5" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <path d="M8 14.5h3M8 17.5h6" />
    </>
  ),
  fairness: (
    <>
      <path d="M12 3.5v17M5 6.5h14" />
      <path d="M5 6.5 2.5 13h5L5 6.5ZM19 6.5 16.5 13h5L19 6.5Z" />
      <path d="M8.5 20.5h7" />
    </>
  ),
  imports: (
    <>
      <path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx("size-5", className)}
    >
      {PATHS[name]}
    </svg>
  );
}
