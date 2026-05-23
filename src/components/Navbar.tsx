import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import LoginButton from './LoginButton';
import { BiCube } from 'react-icons/bi';
import { TbServer, TbTopologyStar } from 'react-icons/tb';
import { MdHistory } from 'react-icons/md';

const Navbar: React.FC = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const location = useLocation();

  const isActivePath = (path: string): boolean => {
    return location.pathname.startsWith(path);
  };

  const navLinkClasses = (path: string): string => {
    const baseClasses = "flex items-center px-4 py-2 rounded-xl transition-all duration-300";
    const activeClasses = "text-blue-700 font-semibold";
    const inactiveClasses = "text-gray-700 hover:text-blue-600";
    
    return `${baseClasses} ${isActivePath(path) ? activeClasses : inactiveClasses}`;
  };

  const mobileNavLinkClasses = (path: string): string => {
    const baseClasses = "flex items-center px-4 py-3 rounded-xl transition-all duration-300";
    const activeClasses = "text-blue-700 font-semibold";
    const inactiveClasses = "text-gray-700 hover:text-blue-600";
    
    return `${baseClasses} ${isActivePath(path) ? activeClasses : inactiveClasses}`;
  };

  return (
    <nav className="sticky top-0 z-50 bg-gradient-to-r from-blue-100/90 via-purple-100/85 to-cyan-100/90 backdrop-blur-lg border-b border-blue-200/40 shadow-xl shadow-blue-300/20 h-16">
      <div className="max-w-[1400px] mx-auto px-6 h-full">
        <div className="flex items-center justify-between h-full relative">
          {/* Left section with logo */}
          <div className="flex items-center">
            <Link to="/" className="flex items-center group">
              <div className="flex items-center text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-700 to-purple-700 group-hover:scale-105 transition-transform duration-300">
                Chiron Platform
              </div>
            </Link>
          </div>

          {/* Center section with navigation */}
          <div className="hidden lg:flex items-center space-x-2 absolute left-1/2 -translate-x-1/2">
            <Link to="/models" className={navLinkClasses("/models")}>
              <BiCube className="mr-2" size={20} />
              Models
            </Link>
            <Link to="/worker" className={navLinkClasses("/worker")}>
              <TbServer className="mr-2" size={20} />
              Worker
            </Link>
            <Link to="/training" className={navLinkClasses("/training")}>
              <TbTopologyStar className="mr-2" size={20} />
              Training
            </Link>
            <Link to="/runs" className={navLinkClasses("/runs")}>
              <MdHistory className="mr-2" size={20} />
              Runs
            </Link>
          </div>

          {/* Right section with Login */}
          <div className="flex items-center space-x-3">
            <div className="hidden lg:flex items-center space-x-3">
              <LoginButton />
            </div>
            
            {/* Mobile menu button */}
            <button 
              className="lg:hidden p-2.5 rounded-xl bg-white/80 hover:bg-white/95 transition-all duration-300 backdrop-blur-sm border border-blue-200/50 hover:border-blue-300/60 hover:shadow-lg"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-label="Toggle mobile menu"
              title="Toggle mobile menu"
            >
              <svg className="h-6 w-6 text-gray-600 hover:text-blue-600 transition-colors duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        <div className={`lg:hidden ${isMobileMenuOpen ? 'block' : 'hidden'}`}>
          <div className="px-4 pt-4 pb-6 space-y-3 bg-white/90 backdrop-blur-lg rounded-2xl mt-4 mb-4 border border-blue-200/50 shadow-2xl shadow-blue-200/30">
            <Link 
              to="/models" 
              className={mobileNavLinkClasses("/models")}
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <BiCube className="mr-3" size={20} />
              Models
            </Link>
            <Link 
              to="/worker" 
              className={mobileNavLinkClasses("/worker")}
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <TbServer className="mr-3" size={20} />
              Worker
            </Link>
            <Link
              to="/training"
              className={mobileNavLinkClasses("/training")}
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <TbTopologyStar className="mr-3" size={20} />
              Training
            </Link>
            <Link
              to="/runs"
              className={mobileNavLinkClasses("/runs")}
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <MdHistory className="mr-3" size={20} />
              Runs
            </Link>

            {/* Add divider */}
            <div className="border-t border-blue-200/50 my-4"></div>

            {/* Login button in mobile menu */}
            <div className="px-4 py-2">
              <LoginButton />
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
