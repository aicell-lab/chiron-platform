/**
 * Which transport carries model weights between the orchestrator and the
 * trainers during a federated round.
 *
 * The two modes run on the SAME orchestrator and trainer apps. Nothing is
 * deployed differently: the orchestrator accepts `transport` on
 * `start_training` and dispatches only the weight-blob RPCs
 * (`start_fit`, `get_fit_status`, `start_evaluate`, `get_evaluate_status`,
 * `get_parameters`) accordingly. Control-plane calls always ride the
 * WebSocket, because they are small and need Hypha's routing.
 *
 *  - `websocket` — weights travel through the Hypha server. Needs nothing but
 *    an outbound HTTPS path, so it works from any site that can reach the
 *    platform at all. That is what makes it the safe fallback.
 *  - `webrtc` — weights travel peer to peer over a data channel and never
 *    touch the server. This is the platform's privacy claim, but it needs the
 *    two peers to complete an ICE handshake, and for peers behind restrictive
 *    NATs that means a working TURN relay. Hypha's `turn-server/coturn`
 *    hands out `turns:turn.hypha.aicell.io:443` over TCP, which gets through
 *    egress filters that block the classic TURN ports (UDP 3478, TCP 5349).
 *
 * There is deliberately NO automatic fallback from `webrtc` to `websocket`.
 * Silently degrading would send weights through the server precisely when the
 * operator asked for them not to, so a failed handshake surfaces as an error
 * and the operator decides. This picker is that decision point: when the relay
 * is down, switch to `websocket` and start the run again.
 */
export type WeightTransport = 'websocket' | 'webrtc';

export const WEIGHT_TRANSPORTS: readonly WeightTransport[] = ['websocket', 'webrtc'] as const;

export const isWeightTransport = (value: unknown): value is WeightTransport =>
  WEIGHT_TRANSPORTS.includes(value as WeightTransport);

/** Short label and one-line rationale for each mode, rendered by the picker. */
export const WEIGHT_TRANSPORT_LABELS: Record<WeightTransport, { label: string; hint: string }> = {
  websocket: {
    label: 'WebSocket',
    hint: 'Weights relay through the Hypha server. Works from any network that can reach the platform.',
  },
  webrtc: {
    label: 'WebRTC',
    hint: 'Weights go peer to peer and never reach the server. Needs an ICE handshake, which some networks block.',
  },
};

/**
 * Default for a fresh browser. `websocket`, because a run that completes
 * slightly less privately beats a run that cannot start. Override at build
 * time with REACT_APP_WEIGHT_TRANSPORT.
 */
const configured = process.env.REACT_APP_WEIGHT_TRANSPORT;

export const DEFAULT_WEIGHT_TRANSPORT: WeightTransport =
  isWeightTransport(configured) ? configured : 'websocket';

const STORAGE_KEY = 'chiron.weightTransport';

/**
 * The operator's last choice, or the build-time default.
 *
 * Persisted because the reason to change it outlives one page load: if the
 * relay is down, every run started until it comes back wants the same answer,
 * and re-picking it on each reload is exactly the step someone forgets.
 */
export const readWeightTransport = (): WeightTransport => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isWeightTransport(stored)) return stored;
  } catch {
    // Private mode, or storage disabled by policy. Not worth surfacing:
    // the default is still correct, the choice just will not stick.
  }
  return DEFAULT_WEIGHT_TRANSPORT;
};

export const storeWeightTransport = (transport: WeightTransport): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, transport);
  } catch {
    // Same as above. The in-memory choice still applies to this run.
  }
};
