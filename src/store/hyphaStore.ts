import { create } from 'zustand';
import { hyphaWebsocketClient } from 'hypha-rpc';
import { logger } from '../utils/logger';
// import { hRPC } from 'hypha';
import { Resource } from '../types/resource';
import { HYPHA_SERVER_URL } from '../config/hypha';

// Dedup keys for connect(): a second caller with the same server and token
// gets the in-flight promise (or the live server) instead of tearing the
// socket down and rebuilding it underneath the first caller.
let pendingConnectPromise: Promise<any> | null = null;
let activeConnectKey: string | null = null;

// Guards for attemptReconnect(): one shared in-flight promise so concurrent
// callers don't each fire their own reconnect, plus a cooldown timestamp so a
// burst of failures doesn't hammer the server.
let reconnectPromise: Promise<boolean> | null = null;
let lastReconnectAt = 0;
const RECONNECT_MAX_ATTEMPTS = 2;      // "once or twice" before logging out
const RECONNECT_RETRY_DELAY_MS = 1500; // brief backoff between the two attempts
const RECONNECT_COOLDOWN_MS = 8000;    // ignore repeat triggers within this window

// Read the cached login token, honouring its stored expiry. Mirrors
// LoginButton.getSavedToken so a reconnect uses the same credential the
// initial auto-login used.
const getSavedToken = (): string | null => {
  const token = localStorage.getItem('token');
  if (token) {
    const expiry = localStorage.getItem('tokenExpiry');
    if (expiry && new Date(expiry) > new Date()) return token;
  }
  return null;
};

/**
 * Coarse websocket-connection health for the account-menu indicator.
 *   connected    - live socket, RPC calls work
 *   reconnecting - socket dropped, a proactive reconnect is in flight
 *   disconnected - no live socket and no reconnect running (or session ended)
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

// Detach our on_disconnected handler from a server we are about to tear down
// on purpose (a reconnect's stale cleanup, or a logout). hypha-rpc fires
// _handle_disconnected even on a clean close(1000), so without this a
// deliberate disconnect would read as a dropped connection and kick off a
// spurious reconnect. Best effort: internals may shift across hypha-rpc
// versions, so a failure here is logged and ignored.
const detachDisconnectHandler = (server: any): void => {
  try {
    server?.rpc?._connection?.on_disconnected?.(null);
  } catch (error) {
    logger.warn('hyphaStore', 'Could not detach Hypha disconnect handler', error);
  }
};


// Add a type for connection config
interface ConnectionConfig {
  server_url: string;
  token?: string;
  method_timeout?: number;
}

interface LoginConfig {
  server_url: string;
  login_callback?: (context: any) => void;
}

export interface HyphaState {
  client: typeof hyphaWebsocketClient | null;
  server: any;
  /**
   * The bearer token used for the active connection. We mirror it here so HTTP
   * service calls (src/utils/hyphaHttp.ts) can authenticate without re-deriving
   * it from the websocket client.
   */
  hyphaToken: string | null;
  setServer: (server: any) => void;
  user: any;
  setUser: (user: any) => void;
  isInitialized: boolean;
  setIsInitialized: (isInitialized: boolean) => void;
  resources: Resource[];
  setResources: (resources: Resource[]) => void;
  resourceType: string | null;
  setResourceType: (type: string | null) => void;
  fetchResources: (page: number, searchQuery?: string) => Promise<void>;
  resourceTypes: string[];
  setResourceTypes: (types: string[]) => void;
  page: number;
  itemsPerPage: number;
  totalItems: number;
  setTotalItems: (total: number) => void;
  artifactManager: any;
  isConnected: boolean;
  /** True while a connect() is in flight, so the disconnect hook can stand down. */
  isConnecting: boolean;
  /** Websocket health, surfaced as the dot in the account menu. */
  connectionStatus: ConnectionStatus;
  setConnectionStatus: (status: ConnectionStatus) => void;
  connect: (config: ConnectionConfig, opts?: { suppressBanner?: boolean }) => Promise<any>;
  /** User-initiated recovery: one cached-token connect, no cooldown. */
  reconnect: () => Promise<void>;
  /** Automatic recovery after a dropped socket. Deduped and cooldown-limited. */
  attemptReconnect: () => Promise<boolean>;
  isLoggingIn: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  isLoggedIn: boolean;
  setLoggedIn: (status: boolean) => void;
  logout: () => Promise<void>;
  selectedResource: Resource | null;
  setSelectedResource: (resource: Resource | null) => void;
  fetchResource: (id: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;

  // Hypha-reachability signal. Any caller that observes a fetch / websocket
  // failure flips the flag via `markHyphaUnreachable`; the global
  // <HyphaStatusBanner /> at the layout root polls for recovery and calls
  // `markHyphaReachable` when the backend is back. Per-section components
  // (Models, Runs, Training, ...) defer their own error UI to the banner.
  isHyphaUnreachable: boolean;
  hyphaUnreachableSince: number | null;
  hyphaUnreachableMessage: string | null;
  markHyphaUnreachable: (errorMessage?: string | null) => void;
  markHyphaReachable: () => void;
}

export const useHyphaStore = create<HyphaState>((set, get) => ({
  client: hyphaWebsocketClient,
  server: null,
  user: null,
  isInitialized: false,
  resources: [],
  resourceType: 'model',
  resourceTypes: [],
  page: 0,
  itemsPerPage: 12,
  totalItems: 0,
  artifactManager: null,
  hyphaToken: null,
  isConnected: false,
  isConnecting: false,
  connectionStatus: 'disconnected',
  isLoggingIn: false,
  isAuthenticated: false,
  isLoggedIn: false,
  selectedResource: null,
  isLoading: false,
  error: null,
  isHyphaUnreachable: false,
  hyphaUnreachableSince: null,
  hyphaUnreachableMessage: null,
  markHyphaUnreachable: (errorMessage?: string | null) => set(state =>
    state.isHyphaUnreachable
      ? (errorMessage && errorMessage !== state.hyphaUnreachableMessage
          ? { hyphaUnreachableMessage: errorMessage }
          : state)
      : {
          isHyphaUnreachable: true,
          hyphaUnreachableSince: Date.now(),
          hyphaUnreachableMessage: errorMessage ?? null,
        }
  ),
  markHyphaReachable: () => set(state =>
    state.isHyphaUnreachable
      ? { isHyphaUnreachable: false, hyphaUnreachableSince: null, hyphaUnreachableMessage: null }
      : state
  ),
  setServer: (server) => set({ server }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setUser: (user) => set({ user }),
  setIsInitialized: (isInitialized) => set({ isInitialized }),
  setResources: (resources) => set({ resources }),
  setResourceType: (type) => {
    set({ resourceType: type });
    // Automatically fetch resources when type changes
    get().fetchResources(get().page);
  },
  setResourceTypes: (types) => {
    set((state) => ({
      resourceTypes: types,
      page: 0  // Reset page when filter changes
    }));
  },
  setTotalItems: (total) => set({ totalItems: total }),
  setLoggedIn: (status: boolean) => set({ isLoggedIn: status }),
  logout: async () => {
    logger.info('hyphaStore', 'Logging out, clearing connection and user state');
    const currentServer = get().server;
    if (currentServer && typeof currentServer.disconnect === 'function') {
      // Detach first so this deliberate teardown doesn't trip the
      // on_disconnected handler into a spurious reconnect.
      detachDisconnectHandler(currentServer);
      try {
        await currentServer.disconnect();
      } catch (error) {
        logger.warn('hyphaStore', 'Failed to disconnect from Hypha during logout', error);
      }
    }

    pendingConnectPromise = null;
    activeConnectKey = null;
    set({
      client: hyphaWebsocketClient,
      server: null,
      user: null,
      artifactManager: null,
      hyphaToken: null,
      isConnected: false,
      isConnecting: false,
      connectionStatus: 'disconnected',
      isAuthenticated: false,
      isLoggedIn: false,
      isInitialized: false,
    });
  },
  reconnect: async () => {
    const savedToken = getSavedToken();
    // Without a valid cached credential we cannot restore the authenticated
    // session. Connecting anonymously would succeed and leave the user
    // "connected but logged out" with a dead Login button, recoverable only by
    // a page refresh. Present a clean logged-out state instead.
    if (!savedToken) {
      logger.info('hyphaStore', 'Reconnect requested with no valid cached token, logging out');
      set({ connectionStatus: 'disconnected' });
      await get().logout();
      return;
    }
    logger.info('hyphaStore', 'Reconnecting to Hypha on request');
    set({ connectionStatus: 'reconnecting' });
    // Reset the dedup keys so connect() rebuilds the socket even though the
    // config looks identical to the last successful run.
    activeConnectKey = null;
    pendingConnectPromise = null;
    // suppressBanner: a live-session reconnect drives the account-menu dot,
    // not the "services unreachable" banner.
    await get().connect({
      server_url: HYPHA_SERVER_URL,
      token: savedToken,
      method_timeout: 300,
    }, { suppressBanner: true });
  },
  attemptReconnect: async (): Promise<boolean> => {
    // Dedup concurrent callers onto one in-flight reconnect.
    if (reconnectPromise) return reconnectPromise;
    // Rate limit: after a recent attempt, report the current connection state
    // instead of firing again, so a burst of failing RPC calls doesn't trigger
    // a storm of reconnects.
    if (Date.now() - lastReconnectAt < RECONNECT_COOLDOWN_MS) {
      return get().isConnected;
    }

    reconnectPromise = (async () => {
      set({ connectionStatus: 'reconnecting' });
      try {
        for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
          const savedToken = getSavedToken();
          // No valid cached token means nothing to reconnect with. Fall
          // through to the logout below so the UI reads "not logged in".
          if (!savedToken) break;
          try {
            activeConnectKey = null;
            pendingConnectPromise = null;
            await get().connect({
              server_url: HYPHA_SERVER_URL,
              token: savedToken,
              method_timeout: 300,
            }, { suppressBanner: true });
            logger.info('hyphaStore', 'Reconnected to Hypha', { attempt });
            return true;
          } catch (error) {
            logger.warn('hyphaStore', 'Hypha reconnect attempt failed', { attempt }, error);
            if (attempt < RECONNECT_MAX_ATTEMPTS) {
              await new Promise(resolve => setTimeout(resolve, RECONNECT_RETRY_DELAY_MS));
            }
          }
        }
        // Reconnection failed, or there was no valid token. Log out and drop
        // the stale token so the app presents a clean not-logged-in state
        // rather than a stuck error.
        logger.error('hyphaStore', 'Giving up on reconnect, logging out');
        set({ connectionStatus: 'disconnected' });
        localStorage.removeItem('token');
        localStorage.removeItem('tokenExpiry');
        await get().logout();
        return false;
      } finally {
        lastReconnectAt = Date.now();
        reconnectPromise = null;
      }
    })();
    return reconnectPromise;
  },
  setSelectedResource: (resource) => set({ selectedResource: resource }),
  connect: async (config: ConnectionConfig, opts?: { suppressBanner?: boolean }) => {
    const connectKey = `${config.server_url}|${config.token || ''}`;
    const currentState = get();

    // Same server and same credential on a live socket: hand back what we
    // already have rather than rebuilding it under the existing callers.
    if (currentState.server && currentState.isConnected && activeConnectKey === connectKey) {
      return currentState.server;
    }

    if (pendingConnectPromise) {
      return pendingConnectPromise;
    }

    set({ isConnecting: true, error: null });

    pendingConnectPromise = (async () => {
      try {
        const latestState = get();
        if (latestState.server && typeof latestState.server.disconnect === 'function') {
          // Detach first so this deliberate teardown doesn't trip the
          // on_disconnected handler into a spurious reconnect.
          detachDisconnectHandler(latestState.server);
          try {
            await latestState.server.disconnect();
          } catch (disconnectError) {
            logger.warn('hyphaStore', 'Failed to disconnect stale Hypha connection', disconnectError);
          }
        }

        const client = hyphaWebsocketClient;
        logger.info('hyphaStore', 'Connecting to Hypha', {
          server_url: config.server_url,
          // Whether a token was supplied, never the token itself.
          authenticated: !!config.token,
        });
        const server = await client.connectToServer(config);

        if (!server) {
          throw new Error('Failed to connect to server');
        }

        const artifactManager = await server.getService('public/artifact-manager');

        const isAuthenticated = !!config.token;
        logger.info('hyphaStore', 'Connected to Hypha', {
          workspace: server.config?.workspace,
          client_id: server.config?.client_id,
          user_id: server.config?.user?.id,
          authenticated: isAuthenticated,
        });

        activeConnectKey = connectKey;
        set({
          client,
          server,
          artifactManager,
          hyphaToken: config.token ?? null,
          isConnected: true,
          isConnecting: false,
          connectionStatus: 'connected',
          isAuthenticated,
          isLoggedIn: isAuthenticated,
          user: server.config.user,
          isInitialized: true
        });
        // A successful websocket connect is the strongest signal that Hypha
        // is back; clear any stale unreachable flag a fetch or earlier
        // connection attempt may have set.
        get().markHyphaReachable();

        // Watch for this socket dropping. hypha-rpc auto-reconnects on an
        // unexpected close, but gives up silently in a backgrounded tab once
        // its throttled token refresh has let the reconnection token expire,
        // and it fires _handle_disconnected on a clean close too. Either way
        // we want the dot to go amber and a reconnect to start.
        try {
          const conn = (server as any)?.rpc?._connection;
          if (conn && typeof conn.on_disconnected === 'function') {
            conn.on_disconnected(() => {
              // Ignore drops from a server we have already replaced, or while
              // a connect is mid-flight, since that flow owns the state.
              if (get().server !== server || get().isConnecting) return;
              if (getSavedToken()) {
                logger.warn('hyphaStore', 'Hypha websocket dropped, reconnecting');
                set({ isConnected: false, connectionStatus: 'reconnecting' });
                void get().attemptReconnect();
              } else {
                logger.warn('hyphaStore', 'Hypha websocket dropped with no cached token');
                set({ isConnected: false, connectionStatus: 'disconnected' });
              }
            });
          }
        } catch (hookError) {
          logger.warn('hyphaStore', 'Could not attach Hypha disconnect handler', hookError);
        }

        return server;
      } catch (error) {
        logger.error('hyphaStore', 'Failed to connect to Hypha', error);
        activeConnectKey = null;
        set({
          client: null,
          server: null,
          artifactManager: null,
          hyphaToken: null,
          isConnected: false,
          isConnecting: false,
          isAuthenticated: false,
          isLoggedIn: false,
          user: null,
          isInitialized: false,
          error: error instanceof Error ? error.message : 'Connection failed'
        });
        // A live-session reconnect (suppressBanner) drives the account-menu
        // dot only, and its terminal state is owned by attemptReconnect. A
        // cold connect failure looks the same to the user as a REST outage,
        // so it still raises the global banner on pages that don't otherwise
        // call a hard-coded Hypha endpoint.
        if (!opts?.suppressBanner) {
          set({ connectionStatus: 'disconnected' });
          get().markHyphaUnreachable(
            error instanceof Error ? error.message : 'Failed to connect to Hypha'
          );
        }
        throw error;
      } finally {
        pendingConnectPromise = null;
      }
    })();

    return pendingConnectPromise;
  },
  fetchResources: async (page: number, searchQuery?: string) => {
    try {
      logger.debug('hyphaStore', 'Fetching resources', { page, searchQuery });
      let offset = (page - 1) * get().itemsPerPage;
      if(offset < 0) {
        offset = 0;
      }
      
      // Construct the base URL
      let url = `${HYPHA_SERVER_URL}/chiron-platform/artifacts/collection/children?pagination=true&offset=${offset}&limit=${get().itemsPerPage}`;
      
      // Add type filter if resourceType is specified
      if (get().resourceType) {
        const filters = JSON.stringify({ type: get().resourceType });
        url += `&filters=${encodeURIComponent(filters)}`;
      }
      
      // Add search keywords if there's a search query
      if (searchQuery) {
        const keywords = searchQuery.split(',').map(k => k.trim()).join(',');
        url += `&keywords=${encodeURIComponent(keywords)}`;
      }
      
      const response = await fetch(url);
      const data = await response.json();
      
      set({ 
        resources: data.items || [],
        totalItems: data.total || 0
      });
    } catch (error) {
      logger.error('hyphaStore', 'Error fetching resources', error);
      set({ 
        resources: [],
        totalItems: 0
      });
    }
  },
  fetchResource: async (id: string) => {
    try {
      set({ isLoading: true, error: null });
      
      // Handle both formats: workspace/name or just name
      const [workspace, artifactName] = id.includes('/') 
        ? id.split('/')
        : ['chiron-platform', id];
      const url = `${HYPHA_SERVER_URL}/${workspace}/artifacts/${artifactName}`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch resource: ${response.statusText}`);
      }
      
      const data = await response.json();
      logger.debug('hyphaStore', 'Fetched resource', { id, type: data?.type });
      set({ selectedResource: data, isLoading: false });
    } catch (error) {
      logger.error('hyphaStore', 'Error fetching resource', { id }, error);
      set({ 
        isLoading: false, 
        error: error instanceof Error ? error.message : 'An unknown error occurred',
        selectedResource: null 
      });
    }
  },
  login: async (username: string, password: string) => {
    const state = get();
    
    if (state.isLoggingIn || state.isAuthenticated) {
      return;
    }

    set({ isLoggingIn: true });
    logger.info('hyphaStore', 'Starting interactive login');

    try {
      const client = hyphaWebsocketClient;

      // First step: Get the token through login
      const loginConfig: LoginConfig = {
        server_url: HYPHA_SERVER_URL,
      };

      const token = await client.login(loginConfig);
      logger.info('hyphaStore', 'Login token received', { received: !!token });
      if (!token) {
        throw new Error('Login failed - no token received');
      }

      // Use the new connect function with the token
      await get().connect({
        server_url: HYPHA_SERVER_URL,
        token: token,
        method_timeout: 600,
      });

      logger.info('hyphaStore', 'Login complete');

      // Set both isAuthenticated and isLoggedIn to true after successful login
      set({ 
        isAuthenticated: true,
        isLoggedIn: true 
      });

    } catch (error) {
      logger.error('hyphaStore', 'Login failed', error);
      set({ 
        isAuthenticated: false,
        isConnected: false,
        isLoggedIn: false,
        user: null 
      });
      throw error;
    } finally {
      set({ isLoggingIn: false });
    }
  }
})); 