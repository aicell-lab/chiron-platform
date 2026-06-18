import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import LoginButton from './LoginButton';
import { BiCube } from 'react-icons/bi';
import { TbServer, TbTopologyStar, TbSparkles } from 'react-icons/tb';
import { MdHistory } from 'react-icons/md';

const CHIRON_SKILL_URL = 'https://chiron.aicell.io/skills/chiron-platform/SKILL.md';
const CHIRON_AGENT_PROMPT = `Read ${CHIRON_SKILL_URL} and help me explore the Chiron platform. Ask me what I want to do first (explore published models, set up a worker, launch federated training, or add a new foundation-model trainer).`;

const AgentPopover: React.FC<{ variant?: 'desktop' | 'mobile' }> = ({ variant = 'desktop' }) => {
  const [open, setOpen] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const copy = async (text: string, kind: 'url' | 'prompt') => {
    try {
      await navigator.clipboard.writeText(text);
      if (kind === 'url') {
        setUrlCopied(true);
        setTimeout(() => setUrlCopied(false), 1500);
      } else {
        setPromptCopied(true);
        setTimeout(() => setPromptCopied(false), 1500);
      }
    } catch {
      // clipboard unavailable, ignore silently
    }
  };

  const isMobile = variant === 'mobile';

  return (
    <div ref={containerRef} className={isMobile ? 'w-full' : 'relative'}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Hand the Chiron platform to your AI agent"
        className={
          isMobile
            ? 'flex items-center w-full px-4 py-3 rounded-xl text-gray-700 hover:text-blue-600 transition-colors duration-200'
            : 'flex items-center gap-2 px-3 py-2 rounded-xl bg-white/70 hover:bg-white/95 border border-blue-200/50 hover:border-blue-300/60 backdrop-blur-sm transition-all duration-200 text-sm font-medium text-gray-700 hover:text-blue-700 shadow-sm hover:shadow-md active:scale-[0.98]'
        }
      >
        <TbSparkles size={isMobile ? 20 : 18} className={isMobile ? 'mr-3' : ''} />
        <span className={isMobile ? '' : 'hidden md:inline'}>For your AI agent</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Give Chiron to your AI agent"
          className={
            isMobile
              ? 'mt-2 bg-white border border-blue-100 rounded-2xl shadow-xl p-4 space-y-3'
              : 'absolute right-0 mt-2 w-[380px] bg-white border border-blue-100 rounded-2xl shadow-xl p-4 space-y-3 z-50'
          }
        >
          <div className="flex items-start gap-2">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-r from-blue-100 to-purple-100 flex items-center justify-center flex-shrink-0">
              <TbSparkles className="text-blue-700" size={18} />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Let an AI agent drive Chiron for you.</p>
              <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                Paste this URL into Claude Code, Cursor, Gemini CLI or any AI coding agent. The agent reads the Chiron platform skill and can then discover datasets, launch workers, configure federated training, and publish models on your behalf.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Skill URL</label>
            <div className="flex items-stretch gap-2">
              <code className="flex-1 font-mono text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-2 overflow-x-auto whitespace-nowrap text-gray-700">
                {CHIRON_SKILL_URL}
              </code>
              <button
                type="button"
                onClick={() => copy(CHIRON_SKILL_URL, 'url')}
                className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors duration-200 active:scale-[0.97] flex items-center gap-1"
              >
                {urlCopied ? (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowPrompt((v) => !v)}
            className="text-[11px] text-blue-600 hover:text-blue-800 flex items-center gap-1 transition-colors duration-200"
          >
            <svg
              className={`w-3 h-3 transition-transform duration-200 ${showPrompt ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {showPrompt ? 'Hide ready-to-paste prompt' : 'Or copy a ready prompt'}
          </button>

          {showPrompt && (
            <div>
              <div className="flex items-stretch gap-2">
                <code className="flex-1 font-mono text-[11px] bg-gray-50 border border-gray-200 rounded-lg px-2 py-2 text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {CHIRON_AGENT_PROMPT}
                </code>
              </div>
              <button
                type="button"
                onClick={() => copy(CHIRON_AGENT_PROMPT, 'prompt')}
                className="mt-2 w-full px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-medium transition-colors duration-200 active:scale-[0.97] flex items-center justify-center gap-1"
              >
                {promptCopied ? (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Prompt copied
                  </>
                ) : (
                  'Copy prompt'
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

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

          {/* Right section with AI-agent popover + Login */}
          <div className="flex items-center space-x-3">
            <div className="hidden lg:flex items-center space-x-3">
              <AgentPopover variant="desktop" />
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

            {/* AI-agent popover in mobile menu */}
            <div className="px-2">
              <AgentPopover variant="mobile" />
            </div>

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
