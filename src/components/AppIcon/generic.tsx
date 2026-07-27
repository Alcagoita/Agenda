import React from 'react';
import Svg, { Circle, Ellipse, Line, Path, Rect } from 'react-native-svg';
import { S } from './shared';
import type { IconProps } from './shared';

// ── Bell (Header notifications) ───────────────────────────────────────────────
export function BellIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
        stroke={color} strokeWidth={1.8} {...S}
      />
      <Path
        d="M13.73 21a2 2 0 0 1-3.46 0"
        stroke={color} strokeWidth={1.8} {...S}
      />
    </Svg>
  );
}

// ── Plus (FAB add-task button) ─────────────────────────────────────────────────
export function PlusIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1="12" y1="5"  x2="12" y2="19" stroke={color} strokeWidth={2} {...S} />
      <Line x1="5"  y1="12" x2="19" y2="12" stroke={color} strokeWidth={2} {...S} />
    </Svg>
  );
}

// ── Close × (sheet dismiss) ────────────────────────────────────────────────────
export function CloseIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1="6"  y1="6"  x2="18" y2="18" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="18" y1="6"  x2="6"  y2="18" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Chevron right (list row affordance) ────────────────────────────────────────
export function ChevronRightIcon({ color, size = 24, strokeWidth = 1.6 }: IconProps & { strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth={strokeWidth} {...S} />
    </Svg>
  );
}

// ── Chevron left (screen back button) ─────────────────────────────────────────
export function ChevronLeftIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Clock (time field) ─────────────────────────────────────────────────────────
export function ClockIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="10" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M12 6v6l4 2"        stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Sun (light mode toggle) ───────────────────────────────────────────────────
export function SunIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="4" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="12" y1="2"     x2="12" y2="4"     stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="12" y1="20"    x2="12" y2="22"    stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="2"  y1="12"    x2="4"  y2="12"    stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="20" y1="12"    x2="22" y2="12"    stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="4.22"  y1="4.22"  x2="5.64"  y2="5.64"  stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="18.36" y1="18.36" x2="19.78" y2="19.78" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="4.22"  y1="19.78" x2="5.64"  y2="18.36" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="18.36" y1="5.64"  x2="19.78" y2="4.22"  stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Moon (dark mode toggle) ───────────────────────────────────────────────────
export function MoonIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
        stroke={color} strokeWidth={1.6} {...S}
      />
    </Svg>
  );
}

// ── Globe (language setting) ──────────────────────────────────────────────────
export function GlobeIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={1.6} {...S} />
      <Ellipse cx="12" cy="12" rx="4" ry="9" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="3" y1="12" x2="21" y2="12" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Grid (categories list) ────────────────────────────────────────────────────
export function GridIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3"  y="3"  width="7" height="7" rx="1" stroke={color} strokeWidth={1.6} {...S} />
      <Rect x="14" y="3"  width="7" height="7" rx="1" stroke={color} strokeWidth={1.6} {...S} />
      <Rect x="3"  y="14" width="7" height="7" rx="1" stroke={color} strokeWidth={1.6} {...S} />
      <Rect x="14" y="14" width="7" height="7" rx="1" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Users / Social hub ────────────────────────────────────────────────────────
export function UsersIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Primary person */}
      <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"
            stroke={color} strokeWidth={1.6} {...S} />
      <Circle cx="9" cy="7" r="4"
              stroke={color} strokeWidth={1.6} {...S} />
      {/* Secondary person (right, slightly offset) */}
      <Path d="M23 21v-2a4 4 0 0 0-3-3.87"
            stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M16 3.13a4 4 0 0 1 0 7.75"
            stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Share / Send ──────────────────────────────────────────────────────────────
export function ShareIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="18" cy="5"  r="3" stroke={color} strokeWidth={1.6} {...S} />
      <Circle cx="6"  cy="12" r="3" stroke={color} strokeWidth={1.6} {...S} />
      <Circle cx="18" cy="19" r="3" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="8.59" y1="13.51" x2="15.42" y2="17.49"
            stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="15.41" y1="6.51" x2="8.59" y2="10.49"
            stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Trophy / Challenge ────────────────────────────────────────────────────────
export function TrophyIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M6 9H3V4h3" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M18 9h3V4h-3" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M6 4h12v7a6 6 0 0 1-12 0V4z" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M12 17v4" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M8 21h8" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── LogOut (sign out) ─────────────────────────────────────────────────────────
export function LogOutIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
            stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M16 17l5-5-5-5"
            stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="21" y1="12" x2="9" y2="12"
            stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Settings / Gear ───────────────────────────────────────────────────────────
export function SettingsIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={1.6} {...S} />
      <Path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke={color} strokeWidth={1.6} {...S}
      />
    </Svg>
  );
}

// ── Camera ────────────────────────────────────────────────────────────────────
export function CameraIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
        stroke={color} strokeWidth={1.6} {...S}
      />
      <Circle cx="12" cy="13" r="4" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Flame / Streak ────────────────────────────────────────────────────────────
export function FlameIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
        stroke={color} strokeWidth={1.6} {...S}
      />
    </Svg>
  );
}

/** Filled flame — used in the streak chip. Fill-only, no stroke. */
export function FilledFlameIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M13.4 2.2c.4 2.6-.7 4.1-2 5.5-1.3 1.4-2.9 2.8-2.9 5.4a5.6 5.6 0 0 0 8.4 4.9c2-1.2 3.1-3.4 3.1-5.8 0-2.2-.9-3.8-1.9-5-.3 1-1 1.7-1.9 2 .4-2.4-.6-5.1-2.9-7z"
        fill={color}
      />
    </Svg>
  );
}

// ── Lock ──────────────────────────────────────────────────────────────────────
export function LockIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="11" width="18" height="11" rx="2" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M7 11V7a5 5 0 0 1 10 0v4" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Pencil / Edit ─────────────────────────────────────────────────────────────
export function PencilIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
        stroke={color} strokeWidth={1.6} {...S}
      />
      <Path
        d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
        stroke={color} strokeWidth={1.6} {...S}
      />
    </Svg>
  );
}

// ── Battery ───────────────────────────────────────────────────────────────────
export function BatteryIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="2" y="7" width="17" height="10" rx="2" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M22 11v2" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <Line x1="5.5" y1="12" x2="9.5" y2="12" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Calendar ──────────────────────────────────────────────────────────────────
export function CalendarIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="4" width="18" height="18" rx="2" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="16" y1="2" x2="16" y2="6" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="8"  y1="2" x2="8"  y2="6" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="3"  y1="10" x2="21" y2="10" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── ListCheck (import tasks) ──────────────────────────────────────────────────
export function ListCheckIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1="10" y1="6"  x2="21" y2="6"  stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="10" y1="12" x2="21" y2="12" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="10" y1="18" x2="21" y2="18" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M3 6l1.5 1.5L7 3.5"  stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M3 12l1.5 1.5L7 9.5" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M3 18l1.5 1.5L7 15.5" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Medal / Achievement ───────────────────────────────────────────────────────
export function MedalIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="14" r="7" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M7.9 4L6 7l6 2.5L18 7l-1.9-3" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Check (achievement) ───────────────────────────────────────────────────────
export function CheckIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M5 12l5 5L20 7" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// ── Pin / Location ────────────────────────────────────────────────────────────
export function PinIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2C8.69 2 6 4.69 6 8c0 4.5 6 12 6 12s6-7.5 6-12c0-3.31-2.69-6-6-6z"
        stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
      <Circle cx="12" cy="8" r="2" stroke={color} strokeWidth={1.6} />
    </Svg>
  );
}

// ── Trip: folded map + location marker (KAN-304 Trips tab) ──────────────────────
export function TripMapIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Folded map, lower-right */}
      <Path
        d="M8 10.5l5-2 4 2 5-1.8v10.6l-5 1.8-4-2-5 2z"
        stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <Path d="M13 8.5v10.6M17 10.5v10.6" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      {/* Location marker, upper-left */}
      <Path
        d="M6.5 2.2c-2 0-3.6 1.6-3.6 3.6 0 2.7 3.6 6.2 3.6 6.2s3.6-3.5 3.6-6.2c0-2-1.6-3.6-3.6-3.6z"
        stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
      <Circle cx="6.5" cy="5.8" r="1.3" stroke={color} strokeWidth={1.4} />
    </Svg>
  );
}

// ── Compass/directions (KAN-279 "Take me there") ────────────────────────────────
// A paper-plane/send glyph reads as "share" (which this app already has a
// dedicated icon for) — this is a compass needle instead, unambiguous.
export function NavigateIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Home (Settings home-address row, KAN-247) ─────────────────────────────────
export function HomeIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 11.5L12 4l8 7.5" stroke={color} strokeWidth={1.8} {...S} />
      <Path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9" stroke={color} strokeWidth={1.8} {...S} />
    </Svg>
  );
}

// ── Star ──────────────────────────────────────────────────────────────────────
export function StarIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    </Svg>
  );
}

export function FilledStarIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        fill={color}
      />
    </Svg>
  );
}

// ── Copy (clipboard) ──────────────────────────────────────────────────────────
export function CopyIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="9" y="9" width="13" height="13" rx="2" stroke={color} strokeWidth={1.6} {...S} />
      <Path
        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
        stroke={color} strokeWidth={1.6} {...S}
      />
    </Svg>
  );
}

// ── Message / Chat ────────────────────────────────────────────────────────────
export function MessageIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke={color} strokeWidth={1.6} {...S}
      />
    </Svg>
  );
}

// ── Refresh (circular arrow) ──────────────────────────────────────────────────
export function RefreshIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M1 4v6h6"
        stroke={color} strokeWidth={1.6} {...S}
      />
      <Path
        d="M3.51 15a9 9 0 1 0 .49-4"
        stroke={color} strokeWidth={1.6} {...S}
      />
    </Svg>
  );
}

// ── QR Code ───────────────────────────────────────────────────────────────────
export function QrCodeIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Finder patterns (outer squares) */}
      <Rect x="3"  y="3"  width="7" height="7" rx="1.5" stroke={color} strokeWidth={1.6} {...S} />
      <Rect x="14" y="3"  width="7" height="7" rx="1.5" stroke={color} strokeWidth={1.6} {...S} />
      <Rect x="3"  y="14" width="7" height="7" rx="1.5" stroke={color} strokeWidth={1.6} {...S} />
      {/* Finder inner dots */}
      <Rect x="5"  y="5"  width="3" height="3" rx="0.5" fill={color} />
      <Rect x="16" y="5"  width="3" height="3" rx="0.5" fill={color} />
      <Rect x="5"  y="16" width="3" height="3" rx="0.5" fill={color} />
      {/* Data area (bottom-right, simplified) */}
      <Rect x="14" y="14" width="3" height="3" rx="0.5" stroke={color} strokeWidth={1.6} {...S} />
      <Rect x="18" y="14" width="3" height="3" rx="0.5" stroke={color} strokeWidth={1.6} {...S} />
      <Rect x="18" y="18" width="3" height="3" rx="0.5" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

/** Building / store icon — used by KAN-74 Store fine tuning indicator. */
export function BuildingIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Main building outline */}
      <Path
        d="M3 21h18M5 21V5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v16"
        stroke={color} strokeWidth={1.6} {...S}
      />
      {/* Left windows */}
      <Rect x="7"  y="8"  width="3" height="3" rx="0.5" stroke={color} strokeWidth={1.4} {...S} />
      <Rect x="7"  y="13" width="3" height="3" rx="0.5" stroke={color} strokeWidth={1.4} {...S} />
      {/* Right windows */}
      <Rect x="14" y="8"  width="3" height="3" rx="0.5" stroke={color} strokeWidth={1.4} {...S} />
      <Rect x="14" y="13" width="3" height="3" rx="0.5" stroke={color} strokeWidth={1.4} {...S} />
      {/* Door */}
      <Path d="M10 21v-4h4v4" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Suitcase (Trip Planner entry point, KAN-234) ──────────────────────────────
export function SuitcaseIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="7" width="18" height="13" rx="2" stroke={color} strokeWidth={1.6} {...S} />
      <Path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="3" y1="12" x2="21" y2="12" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Shopping bag (mall card, KAN-282) ──────────────────────────────────────────
export function ShoppingBagIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 8h12l1 12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1L6 8z"
        stroke={color} strokeWidth={1.6} {...S}
      />
      <Path d="M9 8V6a3 3 0 0 1 6 0v2" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Cloud-off (ContextChip offline-with-coverage glyph, KAN-241) ──────────────
export function CloudOffIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M17.5 18H6.5a4 4 0 0 1-.9-7.9 5.5 5.5 0 0 1 10.6-2.02A4.5 4.5 0 0 1 17.5 18z"
        stroke={color} strokeWidth={1.6} {...S}
      />
      <Line x1="4" y1="4" x2="20" y2="20" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}

// ── Crosshair (Lantern "no home set" state, KAN-301) ──────────────────────────
// A locating reticle: "the app hasn't been told where to center yet." Distinct
// from PinIcon (a known place) and HomeIcon (a set home) — this is the unset,
// still-searching state.
export function CrosshairIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="7" stroke={color} strokeWidth={1.7} {...S} />
      <Line x1="12" y1="2"  x2="12" y2="5"  stroke={color} strokeWidth={1.7} {...S} />
      <Line x1="12" y1="19" x2="12" y2="22" stroke={color} strokeWidth={1.7} {...S} />
      <Line x1="2"  y1="12" x2="5"  y2="12" stroke={color} strokeWidth={1.7} {...S} />
      <Line x1="19" y1="12" x2="22" y2="12" stroke={color} strokeWidth={1.7} {...S} />
      <Circle cx="12" cy="12" r="1.4" fill={color} />
    </Svg>
  );
}

// ── Cake (birthday task glyph, KAN-248) ────────────────────────────────────────
export function CakeIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Candles */}
      <Line x1="8"  y1="3" x2="8"  y2="6" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="12" y1="2" x2="12" y2="6" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="16" y1="3" x2="16" y2="6" stroke={color} strokeWidth={1.6} {...S} />
      {/* Top layer with wavy icing */}
      <Path d="M5 10c.8-1 1.7-1 2.5 0s1.7 1 2.5 0 1.7-1 2.5 0 1.7 1 2.5 0 1.7-1 2.5 0v3H5v-3z" stroke={color} strokeWidth={1.6} {...S} />
      {/* Base */}
      <Path d="M4 13h16v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6z" stroke={color} strokeWidth={1.6} {...S} />
      <Line x1="4" y1="17" x2="20" y2="17" stroke={color} strokeWidth={1.6} {...S} />
    </Svg>
  );
}
