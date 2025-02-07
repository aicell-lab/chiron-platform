import React, { useState, useRef, useEffect } from 'react';

interface Partner {
  name: string;
  icon: string;
  link?: string;
  id: string;
  type?: 'university' | 'research_institute';
  country?: string;
}

interface ManifestResponse {
  manifest: {
    documentation?: string;
    git_repo?: string;
    config: {
      docs?: string;
      partners: Array<{
        name: string;
        icon: string;
        id: string;
      }>;
    };
  };
}

const PartnerScroll: React.FC = () => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(true);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // For now, we'll use placeholder data for academic partners
    const placeholderPartners: Partner[] = [
      {
        name: "Stanford University",
        icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Stanford_Cardinal_logo.svg/200px-Stanford_Cardinal_logo.svg.png",
        id: "stanford",
        type: "university",
        country: "USA",
        link: "https://www.stanford.edu"
      },
      {
        name: "MIT",
        icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/MIT_logo.svg/1280px-MIT_logo.svg.png",
        id: "mit",
        type: "university",
        country: "USA",
        link: "https://www.mit.edu"
      },
      {
        name: "KTH Royal Institute of Technology",
        icon: "https://intra.kth.se/img/logotype-blue-ff671d438dd60cb940a663d2fd5e0cf9.svg",
        id: "kth",
        type: "university",
        country: "Sweden",
        link: "https://www.kth.se"
      },
      {
        name: "ETH Zürich",
        icon: "https://ethz.ch/etc/designs/ethz/img/header/ethz_logo_black.svg",
        id: "eth",
        type: "university",
        country: "Switzerland",
        link: "https://ethz.ch"
      },
      {
        name: "Harvard University",
        icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Harvard_University_logo.svg/2560px-Harvard_University_logo.svg.png",
        id: "harvard",
        type: "university",
        country: "USA",
        link: "https://www.harvard.edu"
      },
      {
        name: "University of Oxford",
        icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/ff/Oxford-University-Circlet.svg/1280px-Oxford-University-Circlet.svg.png",
        id: "oxford",
        type: "university",
        country: "UK",
        link: "https://www.ox.ac.uk"
      },
      {
        name: "Karolinska Institute",
        icon: "https://staff.ki.se/sites/medarbetare/files/qbank/ki_logo_rgb-custom20221016133022.jpg",
        id: "ki",
        type: "university",
        country: "Sweden",
        link: "https://ki.se"
      }
    ];

    setPartners(placeholderPartners);
    setLoading(false);
  }, []);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollRef.current) {
      const scrollAmount = direction === 'left' ? -200 : 200;
      scrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-32">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center text-red-500 p-4">
        Error loading partners: {error}
      </div>
    );
  }

  return (
    <div className="relative max-w-[1400px] mx-auto px-4 mt-8">
      <h2 className="text-2xl font-semibold text-center mb-6">Contributing Institutions</h2>
      <p className="text-gray-600 text-center mb-8">
        Leading academic institutions contributing datasets and AI models to advance single-cell research
      </p>
      {showLeftArrow && (
        <button
          onClick={() => scroll('left')}
          className="absolute left-0 top-1/2 transform -translate-y-1/2 bg-white shadow-lg rounded-full p-2"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}
      
      <div
        ref={scrollRef}
        className="flex overflow-x-auto space-x-8 py-4 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
        onScroll={(e) => {
          const target = e.target as HTMLDivElement;
          setShowLeftArrow(target.scrollLeft > 0);
          setShowRightArrow(
            target.scrollLeft < target.scrollWidth - target.clientWidth
          );
        }}
      >
        {partners.map((partner) => (
          <a
            key={partner.id}
            href={partner.link}
            className="flex flex-col items-center space-y-4 min-w-[200px] group"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="w-32 h-32 flex items-center justify-center p-4 bg-white rounded-lg shadow-sm transition-transform group-hover:scale-105">
              <img 
                src={partner.icon} 
                alt={partner.name} 
                className="w-full h-full object-contain"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  img.src = '/fallback-icon.png';
                }}
              />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-medium text-gray-900">{partner.name}</h3>
              <p className="text-sm text-gray-500">{partner.country}</p>
            </div>
          </a>
        ))}
      </div>

      {showRightArrow && (
        <button
          onClick={() => scroll('right')}
          className="absolute right-0 top-1/2 transform -translate-y-1/2 bg-white shadow-lg rounded-full p-2"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
};

export default PartnerScroll; 