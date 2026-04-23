import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import LoginButton from './LoginButton';
import { BiCube } from 'react-icons/bi';
import { TbEngine } from 'react-icons/tb';
import { RiTestTubeLine } from 'react-icons/ri';
import { TbTopologyStar } from 'react-icons/tb';

const Navbar: React.FC = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const location = useLocation();

  const isActivePath = (path: string): boolean => {
    return location.pathname.startsWith(path);
  };

  const navLinkClasses = (path: string): string => {
    const baseClasses = "flex items-center px-3 py-2";
    const activeClasses = "text-blue-600 font-medium";
    const inactiveClasses = "text-gray-700 hover:text-gray-900";
    
    return `${baseClasses} ${isActivePath(path) ? activeClasses : inactiveClasses}`;
  };

  const mobileNavLinkClasses = (path: string): string => {
    const baseClasses = "flex items-center px-3 py-2 rounded-md hover:bg-gray-50";
    const activeClasses = "text-blue-600 font-medium bg-blue-50";
    const inactiveClasses = "text-gray-700 hover:text-gray-900";
    
    return `${baseClasses} ${isActivePath(path) ? activeClasses : inactiveClasses}`;
  };

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-gray-200">
      <div className="max-w-[1400px] mx-auto px-4">
        <div className="relative flex items-center justify-between h-16">
          {/* Left: logo */}
          <div className="flex items-center">
            <Link to="/" className="flex items-center">
              <div className="flex items-center text-2xl font-bold text-blue-600">
                <BiCube className="mr-2" size={24} />
                Chiron Platform
              </div>
            </Link>
          </div>

          {/* Center: Worker · Training · Chiron Lab */}
          <div className="hidden md:flex items-center space-x-1 absolute left-1/2 -translate-x-1/2">
            <Link to="/worker" className={navLinkClasses("/worker")}>
              <span className="mr-2 inline-flex h-5 w-5 items-center justify-center">
                <TbEngine size={20} />
              </span>
              Worker
            </Link>
            <Link to="/training" className={navLinkClasses("/training")}>
              <span className="mr-2 inline-flex h-5 w-5 items-center justify-center">
                <TbTopologyStar size={20} />
              </span>
              Training
            </Link>
            <Link to="/lab" className={navLinkClasses("/lab")}>
              <span className="mr-2 inline-flex h-5 w-5 items-center justify-center">
                <RiTestTubeLine size={20} />
              </span>
              Chiron Lab
            </Link>
          </div>

          {/* Right: Login */}
          <div className="flex items-center space-x-4">
            <div className="hidden md:flex items-center">
              <LoginButton />
            </div>
            
            {/* Mobile menu button */}
            <button 
              className="md:hidden"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-label="Toggle mobile menu"
              title="Toggle mobile menu"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        <div className={`md:hidden ${isMobileMenuOpen ? 'block' : 'hidden'}`}>
          <div className="px-2 pt-2 pb-3 space-y-1">
            <Link 
              to="/worker" 
              className={mobileNavLinkClasses("/worker")}
            >
              <span className="mr-2 inline-flex h-5 w-5 items-center justify-center">
                <TbEngine size={20} />
              </span>
              Worker
            </Link>
            <Link
              to="/training"
              className={mobileNavLinkClasses("/training")}
            >
              <span className="mr-2 inline-flex h-5 w-5 items-center justify-center">
                <TbTopologyStar size={20} />
              </span>
              Training
            </Link>
            <Link 
              to="/lab" 
              className={mobileNavLinkClasses("/lab")}
            >
              <span className="mr-2 inline-flex h-5 w-5 items-center justify-center">
                <RiTestTubeLine size={20} />
              </span>
              Chiron Lab
            </Link>

            {/* Add divider */}
            <div className="border-t border-gray-200 my-2"></div>

            {/* Login button in mobile menu */}
            <div className="px-3 py-2">
              <LoginButton />
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar; 