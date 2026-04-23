import { useState, useEffect, useCallback, useRef } from 'react';
import { useHyphaStore } from '../store/hyphaStore';
import { UserCircleIcon } from '@heroicons/react/24/outline';
import { RiLoginBoxLine } from 'react-icons/ri';
import { useHyphaContext } from '../HyphaContext';
import { useNavigate, useLocation } from 'react-router-dom';
import { Spinner } from './Spinner';

interface LoginButtonProps {
  className?: string;
}

interface LoginConfig {
  server_url: string;
  login_callback: (context: { login_url: string }) => void;
}

const serverUrl = "https://hypha.aicell.io";
const REDIRECT_PATH_KEY = 'redirectPath';

const getSavedToken = () => {
  const token = localStorage.getItem("token");
  if (token) {
    const tokenExpiry = localStorage.getItem("tokenExpiry");
    if (tokenExpiry && new Date(tokenExpiry) > new Date()) {
      return token;
    }
  }
  return null;
};

export default function LoginButton({ className = '' }: LoginButtonProps) {
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const { client, user, connect, setUser, server, isConnected, isLoggedIn } = useHyphaStore();
  const { hyphaClient, setHyphaClient } = useHyphaContext();
  const navigate = useNavigate();
  const location = useLocation();
  const autoLoginAttemptedRef = useRef(false);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const dropdown = document.getElementById('user-dropdown');
      if (dropdown && !dropdown.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      if (hyphaClient) {
        await hyphaClient.disconnect();
        setHyphaClient(null);
      }
      localStorage.removeItem('token');
      localStorage.removeItem('tokenExpiry');
      localStorage.removeItem('user');
      sessionStorage.removeItem(REDIRECT_PATH_KEY);
      setUser(null);
      setIsDropdownOpen(false);
      navigate('/');
    } catch (error) {
      console.error('Error during logout:', error);
    }
  };

  const loginCallback = (context: { login_url: string }) => {
    window.open(context.login_url);
  };

  const login = async () => {
    const config: LoginConfig = {
      server_url: serverUrl,
      login_callback: loginCallback,
    };
    try {
      const token = await client.login(config);
      localStorage.setItem("token", token);
      localStorage.setItem("tokenExpiry", new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString());
      return token;
    } catch (error) {
      console.error('Login failed:', error);
      return null;
    }
  };

  const handleLogin = useCallback(async () => {
    if (isConnected && server) return;

    // Save current path so we can redirect back after login
    const currentPath = location.pathname !== '/' ? location.pathname + location.search + location.hash : null;
    if (currentPath) {
      sessionStorage.setItem(REDIRECT_PATH_KEY, currentPath);
    }

    setIsLoggingIn(true);
    try {
      let token = getSavedToken();
      if (!token) {
        token = await login();
        if (!token) throw new Error('Failed to obtain token');
      }
      await connect({ server_url: serverUrl, token, method_timeout: 300 });
    } catch (error) {
      console.error("Error during login:", error);
      localStorage.removeItem("token");
      localStorage.removeItem("tokenExpiry");
      sessionStorage.removeItem(REDIRECT_PATH_KEY);
    } finally {
      setIsLoggingIn(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect, isConnected, server, location.pathname, location.search, location.hash]);

  // Auto-login on mount if a valid cached token exists
  useEffect(() => {
    const autoLogin = async () => {
      if (autoLoginAttemptedRef.current) return;
      const token = getSavedToken();
      if (token && !isConnected && !isLoggedIn) {
        autoLoginAttemptedRef.current = true;
        setIsLoggingIn(true);
        try {
          await connect({ server_url: serverUrl, token, method_timeout: 300 });
        } catch (error) {
          console.error("Auto-login failed:", error);
          localStorage.removeItem("token");
          localStorage.removeItem("tokenExpiry");
          sessionStorage.removeItem(REDIRECT_PATH_KEY);
        } finally {
          setIsLoggingIn(false);
        }
      }
    };
    autoLogin();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect, isConnected, isLoggedIn]);

  // Set user and redirect after successful connection
  useEffect(() => {
    if (server && server.config.user) {
      setUser(server.config.user);
      const redirectPath = sessionStorage.getItem(REDIRECT_PATH_KEY);
      if (redirectPath) {
        sessionStorage.removeItem(REDIRECT_PATH_KEY);
        navigate(redirectPath);
      }
    }
  }, [server, setUser, navigate]);

  return (
    <div className={className}>
      {user?.email ? (
        <div className="relative">
          <button
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="text-gray-700 hover:text-gray-900 focus:outline-none"
          >
            <UserCircleIcon className="h-6 w-6" />
          </button>
          
          {/* Dropdown Menu */}
          {isDropdownOpen && (
            <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50 border border-gray-200">
              <div className="px-4 py-2 text-sm text-gray-700 border-b border-gray-200">
                {user.email}
              </div>
              <button
                onClick={handleLogout}
                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      ) : (
        <button 
          onClick={handleLogin} 
          disabled={isLoggingIn}
          className="text-gray-700 hover:text-gray-900 px-4 py-2 rounded-md hover:bg-gray-50 flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoggingIn ? (
            <>
              <Spinner className="w-4 h-4 mr-2" />
              Logging in...
            </>
          ) : (
            <>
              <RiLoginBoxLine className="mr-2" size={18} />
              Login
            </>
          )}
        </button>
      )}
    </div>
  );
} 