import React, { useEffect, useRef } from 'react';

declare global {
  interface Window { L: any; }
}

export type MapWorkerRole = 'available' | 'connected' | 'orchestrator' | 'trainer' | 'both';

export interface MapWorker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  role: MapWorkerRole;
  label?: string;
  active?: boolean; // currently doing work (fit / evaluate / aggregation / distribution)
}

export interface MapConnection {
  from: string; // MapWorker id
  to: string;   // MapWorker id
}

interface FederatedWorldMapProps {
  workers: MapWorker[];
  connections?: MapConnection[];
  className?: string;
  style?: React.CSSProperties;
}

const ROLE_COLORS: Record<MapWorkerRole, string> = {
  available:    '#9ca3af',
  connected:    '#22c55e',
  orchestrator: '#0ea5e9',
  trainer:      '#f59e0b',
  both:         '#ec4899',
};

const ROLE_LABELS: Record<MapWorkerRole, string> = {
  available:    'Available',
  connected:    'Connected',
  orchestrator: 'Orchestrator',
  trainer:      'Trainer',
  both:         'Orchestrator + Trainer',
};

export type MapLegendMode = 'setup' | 'select';

const LEGEND_ROLES: Record<MapLegendMode, MapWorkerRole[]> = {
  setup:  ['available', 'connected'],
  select: ['orchestrator', 'trainer', 'both'],
};

// Server rack — orchestrator
const ICON_ORCHESTRATOR = `
  <rect x="9.5" y="10"  width="11" height="2.5" rx="0.6" fill="white" opacity="0.95"/>
  <rect x="9.5" y="14"  width="11" height="2.5" rx="0.6" fill="white" opacity="0.95"/>
  <rect x="9.5" y="18"  width="11" height="2.5" rx="0.6" fill="white" opacity="0.95"/>`;

// Lightning bolt — trainer
const ICON_TRAINER = `
  <path d="M17.5 9L11 16h4.8L11.5 22 20 15h-5Z" fill="white" opacity="0.95"/>`;

// Diamond — both roles
const ICON_BOTH = `
  <path d="M15 9.5L17.5 15L22 15.5L17.5 16L15 21.5L12.5 16L8 15.5L12.5 15Z" fill="white" opacity="0.95"/>`;

// Inject pulse keyframes once into document head
let pulseStyleInjected = false;
function ensurePulseStyle() {
  if (pulseStyleInjected || typeof document === 'undefined') return;
  pulseStyleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes mapPinPulse {
      0%   { transform: scale(0.5); opacity: 0.8; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    .map-pin-pulse {
      animation: mapPinPulse 1.6s ease-out infinite;
    }
  `;
  document.head.appendChild(style);
}

// Compute the combined role for a group of co-located workers.
// A worker with role 'both', 'orchestrator', or 'trainer' contributes its
// capability to the group; if the group has both orchestrator-side and
// trainer-side capability (from any combination of workers) it becomes 'both'.
function dominantRole(roles: MapWorkerRole[]): MapWorkerRole {
  const hasOrch    = roles.some(r => r === 'orchestrator' || r === 'both');
  const hasTrainer = roles.some(r => r === 'trainer'      || r === 'both');
  if (hasOrch && hasTrainer) return 'both';
  if (hasOrch)               return 'orchestrator';
  if (hasTrainer)            return 'trainer';
  if (roles.some(r => r === 'connected')) return 'connected';
  return 'available';
}

// Round to 2 decimal places (~1.1 km) to group co-located workers
function locationKey(lat: number, lng: number): string {
  return `loc::${lat.toFixed(2)}::${lng.toFixed(2)}`;
}

interface WorkerGroup {
  key: string;
  lat: number;
  lng: number;
  role: MapWorkerRole;
  active: boolean;
  workers: MapWorker[];
}

function groupByLocation(workers: MapWorker[]): WorkerGroup[] {
  const map = new Map<string, WorkerGroup>();
  workers.forEach(w => {
    const key = locationKey(w.lat, w.lng);
    if (!map.has(key)) {
      map.set(key, { key, lat: w.lat, lng: w.lng, role: w.role, active: false, workers: [] });
    }
    const g = map.get(key)!;
    g.workers.push(w);
    g.role = dominantRole(g.workers.map(x => x.role));
    if (w.active) g.active = true;
  });
  return Array.from(map.values());
}

function makeIcon(L: any, color: string, role: MapWorkerRole, active: boolean, count: number) {
  const inner =
    role === 'orchestrator' ? ICON_ORCHESTRATOR :
    role === 'trainer'      ? ICON_TRAINER :
    role === 'both'         ? ICON_BOTH :
    `<circle cx="15" cy="15" r="6.5" fill="white" opacity="0.92"/>`;

  // Count badge in top-right corner of pin head (only when >1 worker)
  const badge = count > 1
    ? `<circle cx="23" cy="7" r="6" fill="white" stroke="${color}" stroke-width="1.5"/>
       <text x="23" y="10.5" text-anchor="middle" font-size="7" font-weight="700" fill="${color}" font-family="system-ui,sans-serif">${count > 9 ? '9+' : count}</text>`
    : '';

  if (active) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="47" viewBox="0 0 30 44">
      <path d="M15 0C6.72 0 0 6.72 0 15c0 10.3 13.5 26.5 14.07 27.18a1.2 1.2 0 001.86 0C16.5 41.5 30 25.3 30 15 30 6.72 23.28 0 15 0z" fill="${color}" stroke="white" stroke-width="1.5"/>
      ${inner}
      ${badge}
    </svg>`;
    const html = `<div style="position:relative;width:32px;height:47px">
      <div class="map-pin-pulse" style="position:absolute;top:2px;left:2px;width:28px;height:28px;border-radius:50%;background:${color};opacity:0.55;transform-origin:center;pointer-events:none"></div>
      ${svg}
    </div>`;
    return L.divIcon({ html, className: '', iconSize: [32, 47], iconAnchor: [16, 47], popupAnchor: [0, -50] });
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 30 44">
    <path d="M15 0C6.72 0 0 6.72 0 15c0 10.3 13.5 26.5 14.07 27.18a1.2 1.2 0 001.86 0C16.5 41.5 30 25.3 30 15 30 6.72 23.28 0 15 0z" fill="${color}" stroke="white" stroke-width="1.5"/>
    ${inner}
    ${badge}
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [26, 38], iconAnchor: [13, 38], popupAnchor: [0, -40] });
}

function makePopupHtml(group: WorkerGroup): string {
  if (group.workers.length === 1) {
    const w = group.workers[0];
    const color = ROLE_COLORS[w.role];
    return `<div style="font-size:12px;line-height:1.6">
      <b>${w.name}</b><br/>
      <span style="color:${color};font-weight:600">${ROLE_LABELS[w.role]}</span>
      ${w.label ? `<br/><span style="color:#6b7280">${w.label}</span>` : ''}
    </div>`;
  }

  const items = group.workers.map(w => {
    const color = ROLE_COLORS[w.role];
    return `<div style="margin-bottom:5px">
      <b>${w.name}</b><br/>
      <span style="color:${color};font-weight:600">${ROLE_LABELS[w.role]}</span>
      ${w.label ? `<br/><span style="color:#6b7280">${w.label}</span>` : ''}
    </div>`;
  }).join('');

  return `<div style="font-size:12px;line-height:1.6;min-width:160px">
    <b>${group.workers.length} workers</b>
    <div style="border-top:1px solid #e5e7eb;margin-top:5px;padding-top:5px">
      ${items}
    </div>
  </div>`;
}

const FederatedWorldMap: React.FC<FederatedWorldMapProps> = ({ workers, connections = [], className, style }) => {
  const mapRef      = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef  = useRef<Map<string, any>>(new Map());
  const polylinesRef = useRef<Map<string, any>>(new Map());

  // Inject pulse CSS once
  useEffect(() => { ensurePulseStyle(); }, []);

  // Render markers (one per location group)
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;

    if (!mapInstanceRef.current) {
      mapInstanceRef.current = L.map(mapRef.current, {
        zoomControl: true,
        scrollWheelZoom: false,
        attributionControl: true,
      }).setView([20, 10], 2);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        opacity: 0.75,
      }).addTo(mapInstanceRef.current);
    }

    const map = mapInstanceRef.current;
    setTimeout(() => map.invalidateSize(), 100);

    const groups = groupByLocation(workers);

    // Remove stale markers
    const currentKeys = new Set(groups.map(g => g.key));
    markersRef.current.forEach((marker, key) => {
      if (!currentKeys.has(key)) { map.removeLayer(marker); markersRef.current.delete(key); }
    });

    // Add / update markers
    groups.forEach(group => {
      const color = ROLE_COLORS[group.role];
      const icon = makeIcon(L, color, group.role, group.active, group.workers.length);
      const popupHtml = makePopupHtml(group);

      const zIndexOffset = (group.role === 'orchestrator' || group.role === 'both') ? 1000 : 0;

      if (markersRef.current.has(group.key)) {
        const m = markersRef.current.get(group.key);
        m.setLatLng([group.lat, group.lng]);
        m.setIcon(icon);
        m.setPopupContent(popupHtml);
        m.setZIndexOffset(zIndexOffset);
      } else {
        const m = L.marker([group.lat, group.lng], { icon, zIndexOffset }).addTo(map).bindPopup(popupHtml);
        markersRef.current.set(group.key, m);
      }
    });

    // Fit bounds
    if (workers.length > 1) {
      try {
        const bounds = L.latLngBounds(workers.map(w => [w.lat, w.lng]));
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7 });
      } catch { /* ignore */ }
    } else if (workers.length === 1) {
      map.setView([workers[0].lat, workers[0].lng], 4);
    } else {
      map.setView([20, 10], 2);
    }
  }, [workers]);

  // Render connection lines (uses original workers for position lookup)
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return;
    const L = window.L;
    const map = mapInstanceRef.current;

    // Build position lookup from all individual workers
    const posById: Record<string, [number, number]> = {};
    workers.forEach(w => { posById[w.id] = [w.lat, w.lng]; });

    // Keys for current connections
    const currentKeys = new Set(connections.map(c => `${c.from}::${c.to}`));

    // Remove stale polylines
    polylinesRef.current.forEach((line, key) => {
      if (!currentKeys.has(key)) { map.removeLayer(line); polylinesRef.current.delete(key); }
    });

    // Add new polylines
    connections.forEach(({ from, to }) => {
      const key = `${from}::${to}`;
      if (polylinesRef.current.has(key)) return;
      const fromPos = posById[from];
      const toPos   = posById[to];
      if (!fromPos || !toPos) return;
      const line = L.polyline([fromPos, toPos], {
        color: '#3b82f6',
        weight: 2,
        opacity: 0.65,
        dashArray: '8 6',
      }).addTo(map);
      polylinesRef.current.set(key, line);
    });
  }, [connections, workers]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markersRef.current.clear();
        polylinesRef.current.clear();
      }
    };
  }, []);

  return (
    <div className={className} style={style}>
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};

export const MapLegend: React.FC<{ mode?: MapLegendMode }> = ({ mode = 'setup' }) => (
  <div className="flex flex-wrap gap-x-3 gap-y-1">
    {LEGEND_ROLES[mode].map(role => (
      <div key={role} className="flex items-center gap-1 text-xs text-gray-600">
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: ROLE_COLORS[role] }} />
        {ROLE_LABELS[role]}
      </div>
    ))}
  </div>
);

export default FederatedWorldMap;
