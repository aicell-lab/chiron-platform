import React, { useEffect, useRef } from 'react';

// Declare Leaflet on window
declare global {
  interface Window {
    L: any;
  }
}

interface WorkerMapProps {
  country: string;
  region: string;
  continent: string;
  latitude?: number;
  longitude?: number;
}

const WorkerMap: React.FC<WorkerMapProps> = ({ country, region, continent, latitude, longitude }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markerRef = useRef<any>(null);

  // Initialize and update map
  useEffect(() => {
    if (!mapRef.current || !window.L) return;

    const L = window.L;

    // Initialize map if not already done
    if (!mapInstanceRef.current) {
      mapInstanceRef.current = L.map(mapRef.current).setView([0, 0], 2);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(mapInstanceRef.current);
    }

    const map = mapInstanceRef.current;

    // Fix map size invalidation (useful when inside modals/tabs)
    setTimeout(() => {
      map.invalidateSize();
    }, 100);

    // Update view and marker
    if (latitude !== undefined && longitude !== undefined) {
      const lat = latitude;
      const lng = longitude;

      // Update marker
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng]);
        markerRef.current.bindPopup(`<b>${region}</b><br>${country}, ${continent}`);
        markerRef.current.openPopup(); 
      } else {
        // Quick start Guide implementation: const marker = L.marker(...).addTo(map);
        markerRef.current = L.marker([lat, lng]).addTo(map);
        
        markerRef.current.bindPopup(`<b>${region}</b><br>${country}, ${continent}`).openPopup();
      }
      
      // Zoom in a little and center (Zoom level 3 for world view)
      map.setView([lat, lng], 3);
    } else {
      // Default view if no coordinates
      map.setView([20, 0], 2);
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
    }
  }, [latitude, longitude, country, region, continent]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        // Also clear marker ref since it's associated with the destroyed map
        markerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="w-full h-64 bg-gray-100 rounded-lg overflow-hidden border border-gray-200 relative">
      <div ref={mapRef} className="w-full h-full" style={{ minHeight: '250px' }} />
    </div>
  );
};

export default WorkerMap;
