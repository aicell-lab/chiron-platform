import React, { useEffect, useRef } from 'react';

declare global {
  interface Window { L: any; }
}

export type MapWorkerRole = 'orchestrator' | 'trainer' | 'both' | 'connected' | 'available';

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
  orchestrator: '#2563eb',
  trainer: '#f97316',
  both: '#7c3aed',
  connected: '#22c55e',
  available: '#9ca3af',
};

const ROLE_LABELS: Record<MapWorkerRole, string> = {
  orchestrator: 'Orchestrator Host',
  trainer: 'Trainer Host',
  both: 'Orch + Trainer',
  connected: 'Connected',
  available: 'Available',
};

function makeIcon(L: any, color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 26 38">
    <path d="M13 0C5.82 0 0 5.82 0 13c0 8.9 11.65 22.9 12.16 23.49a1.03 1.03 0 001.68 0C14.35 35.9 26 21.9 26 13 26 5.82 20.18 0 13 0z" fill="${color}" stroke="white" stroke-width="1.5"/>
    <circle cx="13" cy="13" r="5.5" fill="white" opacity="0.92"/>
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
      const icon = makeIcon(L, color);
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

export const MapLegend: React.FC = () => (
  <div className="flex flex-wrap gap-x-3 gap-y-1">
    {(Object.keys(ROLE_COLORS) as MapWorkerRole[]).map(role => (
      <div key={role} className="flex items-center gap-1 text-xs text-gray-600">
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: ROLE_COLORS[role] }} />
        {ROLE_LABELS[role]}
      </div>
    ))}
  </div>
);

export default FederatedWorldMap;
