import React, { useState, useRef, useEffect } from 'react';
import { FaMapMarkerAlt, FaPlus, FaMinus, FaCompress } from 'react-icons/fa';

interface WorkerMapProps {
  country: string;
  region: string;
}

// Simple lookup for coordinates (Lat, Lon)
// This is a small subset, in a real app you'd use a geocoding API or larger database
const LOCATION_LOOKUP: Record<string, [number, number]> = {
  // Cities
  'Stockholm': [59.3293, 18.0686],
  'London': [51.5074, -0.1278],
  'New York': [40.7128, -74.0060],
  'San Francisco': [37.7749, -122.4194],
  'Tokyo': [35.6762, 139.6503],
  'Singapore': [1.3521, 103.8198],
  'Sydney': [-33.8688, 151.2093],
  'Frankfurt': [50.1109, 8.6821],
  'Paris': [48.8566, 2.3522],
  'Mumbai': [19.0760, 72.8777],
  'Sao Paulo': [-23.5505, -46.6333],
  
  // AWS Regions (approximate)
  'us-east-1': [38.13, -78.45], // N. Virginia
  'us-east-2': [40.36, -82.99], // Ohio
  'us-west-1': [37.77, -122.42], // N. California
  'us-west-2': [45.52, -122.68], // Oregon
  'eu-west-1': [53.33, -6.25], // Ireland
  'eu-central-1': [50.11, 8.68], // Frankfurt
  'ap-southeast-1': [1.35, 103.82], // Singapore
  
  // Countries (Centers)
  'SE': [62.0, 15.0],
  'US': [37.09, -95.71],
  'GB': [55.37, -3.43],
  'DE': [51.16, 10.45],
  'FR': [46.22, 2.21],
  'JP': [36.20, 138.25],
  'CN': [35.86, 104.19],
  'IN': [20.59, 78.96],
  'BR': [-14.23, -51.92],
  'AU': [-25.27, 133.77],
};

const WorkerMap: React.FC<WorkerMapProps> = ({ country, region }) => {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  // Get coordinates
  const getCoords = (): [number, number] | null => {
    // Try region/city first
    if (LOCATION_LOOKUP[region]) return LOCATION_LOOKUP[region];
    
    // Try looking up by part of the region string (e.g. "Stockholm" in "Stockholm, Sweden")
    const regionKey = Object.keys(LOCATION_LOOKUP).find(k => region.includes(k));
    if (regionKey) return LOCATION_LOOKUP[regionKey];

    // Fallback to country
    if (LOCATION_LOOKUP[country]) return LOCATION_LOOKUP[country];
    
    // Default/Unknown
    return null;
  };

  const coords = getCoords();

  // Convert Lat/Lon to % positions on Equirectangular map
  // Map dimensions assumed: width covers -180 to 180, height covers 90 to -90
  const getMapPosition = (lat: number, lon: number) => {
    // Normalize lon to 0-100% (Left to Right)
    // -180 => 0%, 180 => 100%
    const x = ((lon + 180) / 360) * 100;
    
    // Normalize lat to 0-100% (Top to Bottom)
    // 90 => 0%, -90 => 100%
    const y = ((90 - lat) / 180) * 100;
    
    return { x, y };
  };

  const pinPos = coords ? getMapPosition(coords[0], coords[1]) : null;

  // Center map on location when it changes
  useEffect(() => {
    const el = mapRef.current;
    if (!el || !pinPos) return;

    const centerMap = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      
      if (w > 0 && h > 0) {
        // Calculate shift needed to center the point
        // Target Y is 65% (lower down) to leave room for the pin/label above
        const targetY = 65;
        const targetX = 50;
        
        const shiftX = ((targetX - pinPos.x) / 100) * w;
        const shiftY = ((targetY - pinPos.y) / 100) * h;
        
        setPosition({ x: shiftX, y: shiftY });
        // Set an initial zoom level to focus on the location
        setScale(2.2);
      }
    };

    // Try immediately
    centerMap();
    
    // Retry after a short delay to ensure layout is stable (e.g. inside modals)
    const timer = setTimeout(centerMap, 100);

    // Also use ResizeObserver to handle modal transitions/loading
    const observer = new ResizeObserver(() => {
       centerMap();
    });
    
    observer.observe(el);
    
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [country, region, pinPos?.x, pinPos?.y]); // Use primitive values for dependencies

  // Interaction handlers
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Stop scrolling parent
    const delta = -e.deltaY;
    const newScale = Math.min(Math.max(1, scale + delta * 0.001), 5);
    setScale(newScale);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const newX = e.clientX - dragStart.x;
      const newY = e.clientY - dragStart.y;
      
      // Limit panning based on scale (simplified)
      setPosition({ x: newX, y: newY });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleReset = () => {
    if (pinPos && mapRef.current) {
        const el = mapRef.current;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        
        if (w > 0 && h > 0) {
            const targetY = 65;
            const targetX = 50;
            const shiftX = ((targetX - pinPos.x) / 100) * w;
            const shiftY = ((targetY - pinPos.y) / 100) * h;
            setPosition({ x: shiftX, y: shiftY });
            setScale(2.2);
            return;
        }
    }
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  // Prevent default scroll behavior when hovering the map
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    
    const preventScroll = (e: WheelEvent) => {
      e.preventDefault();
    };

    element.addEventListener('wheel', preventScroll, { passive: false });
    return () => element.removeEventListener('wheel', preventScroll);
  }, []);

  return (
    <div className="relative w-full h-64 bg-blue-50 rounded-lg overflow-hidden border border-blue-100">
      {/* Controls */}
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 bg-white rounded shadow p-1">
        <button onClick={() => setScale(s => Math.min(s + 0.5, 5))} className="p-1 hover:bg-gray-100 rounded text-gray-600">
          <FaPlus size={12} />
        </button>
        <button onClick={() => setScale(s => Math.max(s - 0.5, 1))} className="p-1 hover:bg-gray-100 rounded text-gray-600">
          <FaMinus size={12} />
        </button>
        <button onClick={handleReset} className="p-1 hover:bg-gray-100 rounded text-gray-600">
          <FaCompress size={12} />
        </button>
      </div>

      {/* Map Container */}
      <div 
        ref={containerRef}
        className="w-full h-full cursor-move relative flex items-center justify-center bg-blue-50"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          touchAction: 'none'
        }}
      >
        <div 
          ref={mapRef}
          className="transition-transform duration-75 origin-center"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            // Enforce 2:1 aspect ratio for the map wrapper to match Equirectangular projection
            width: '100%',
            aspectRatio: '2/1',
            maxWidth: 'calc(100vh * 2)', // Prevent it from getting too tall
            position: 'relative'
          }}
        >
          {/* World Map Image (Equirectangular) */}
          <img 
            src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/World_map_blank_without_borders.svg/2000px-World_map_blank_without_borders.svg.png" 
            alt="World Map" 
            className="w-full h-full block"
            draggable={false}
          />
          
          {/* Pin */}
          {pinPos && (
            <div 
              className="absolute text-red-600 drop-shadow-md z-10 origin-bottom"
              style={{ 
                left: `${pinPos.x}%`, 
                top: `${pinPos.y}%`,
                transform: `translate(-50%, -100%) scale(${1/scale})`,
              }}
            >
              <FaMapMarkerAlt size={24} />
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 bg-black bg-opacity-75 text-white text-xs px-2 py-1 rounded whitespace-nowrap mt-1">
                {region}, {country}
              </div>
            </div>
          )}
          
          {!pinPos && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <p className="bg-white/80 px-2 py-1 rounded text-xs text-gray-500 shadow-sm border border-gray-200">
                  Location not found: {region}, {country}
                </p>
            </div>
          )}
        </div>
      </div>
      
      <div className="absolute bottom-2 left-2 text-[10px] text-gray-400">
        Interactive Map
      </div>
    </div>
  );
};

export default WorkerMap;
