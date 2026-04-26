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
}

interface FederatedWorldMapProps {
  workers: MapWorker[];
  className?: string;
  style?: React.CSSProperties;
}

const ROLE_COLORS: Record<MapWorkerRole, string> = {
  available: '#9ca3af',
  connected: '#22c55e',
  orchestrator: '#0ea5e9',
  trainer: '#f59e0b',
  both: '#ec4899',
};

const ROLE_LABELS: Record<MapWorkerRole, string> = {
  available: 'Available',
  connected: 'Connected',
  orchestrator: 'Orchestrator',
  trainer: 'Trainer',
  both: 'Orchestrator + Trainer',
};

export type MapLegendMode = 'setup' | 'select';

const LEGEND_ROLES: Record<MapLegendMode, MapWorkerRole[]> = {
  setup: ['available', 'connected'],
  select: ['orchestrator', 'trainer', 'both'],
};

// Server rack: three horizontal bars — represents orchestrator as a central server
const ICON_ORCHESTRATOR = `
  <rect x="8.5" y="9"   width="9" height="2"   rx="0.5" fill="white" opacity="0.95"/>
  <rect x="8.5" y="12"  width="9" height="2"   rx="0.5" fill="white" opacity="0.95"/>
  <rect x="8.5" y="15"  width="9" height="2"   rx="0.5" fill="white" opacity="0.95"/>`;

// Lightning bolt: represents model training / gradient updates
const ICON_TRAINER = `
  <path d="M15.5 8L10 14h4.2L10.5 19 18 12.5h-4.3Z" fill="white" opacity="0.95"/>`;

// Diamond / 4-pointed star: both roles present on worker
const ICON_BOTH = `
  <path d="M13 8.5L15 12.5L19 13L15 13.5L13 17.5L11 13.5L7 13L11 12.5Z" fill="white" opacity="0.95"/>`;

function makeIcon(L: any, color: string, role: MapWorkerRole) {
  const inner =
    role === 'orchestrator' ? ICON_ORCHESTRATOR :
    role === 'trainer'      ? ICON_TRAINER :
    role === 'both'         ? ICON_BOTH :
    `<circle cx="13" cy="13" r="5.5" fill="white" opacity="0.92"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 26 38">
    <path d="M13 0C5.82 0 0 5.82 0 13c0 8.9 11.65 22.9 12.16 23.49a1.03 1.03 0 001.68 0C14.35 35.9 26 21.9 26 13 26 5.82 20.18 0 13 0z" fill="${color}" stroke="white" stroke-width="1.5"/>
    ${inner}
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [26, 38],
    iconAnchor: [13, 38],
    popupAnchor: [0, -40],
  });
}

const FederatedWorldMap: React.FC<FederatedWorldMapProps> = ({ workers, className, style }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());

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

    // Remove stale markers
    const currentIds = new Set(workers.map(w => w.id));
    markersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) {
        map.removeLayer(marker);
        markersRef.current.delete(id);
      }
    });

    // Add / update markers
    workers.forEach(worker => {
      const color = ROLE_COLORS[worker.role];
      const icon = makeIcon(L, color, worker.role);
      const popupHtml = `<div style="font-size:12px;line-height:1.5">
        <b>${worker.name}</b><br/>
        <span style="color:${color};font-weight:600">${ROLE_LABELS[worker.role]}</span>
        ${worker.label ? `<br/><span style="color:#6b7280">${worker.label}</span>` : ''}
      </div>`;

      if (markersRef.current.has(worker.id)) {
        const m = markersRef.current.get(worker.id);
        m.setLatLng([worker.lat, worker.lng]);
        m.setIcon(icon);
        m.setPopupContent(popupHtml);
      } else {
        const m = L.marker([worker.lat, worker.lng], { icon }).addTo(map).bindPopup(popupHtml);
        markersRef.current.set(worker.id, m);
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

  useEffect(() => {
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markersRef.current.clear();
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
