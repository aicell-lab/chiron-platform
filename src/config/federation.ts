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
 *  - `webrtc` — weights travel over a DTLS-encrypted data channel between the
 *    two peers. This is the platform's privacy claim. A direct path is used
 *    when the network allows one, and when it does not, Hypha's
 *    `turn-server/coturn` relays the packets from `turns:turn.hypha.aicell.io:443`
 *    over TCP, which gets through egress filters that block the classic TURN
 *    ports (UDP 3478, TCP 5349). TURN forwards ciphertext and never terminates
 *    the DTLS session, so a relayed run is no less private than a direct one:
 *    the relay cannot read a single weight. That distinction matters for the
 *    UI copy, which must not tell an operator that peer-to-peer requires a
 *    network permitting a direct connection. It does not.
 *
 * There is deliberately NO automatic fallback from `webrtc` to `websocket`.
 * Silently degrading would put weights somewhere the server can read them
 * precisely when the operator asked for them not to, so a failed handshake
 * surfaces as an error and the operator decides. This picker is that decision
 * point, and `websocket` is what it exists to reach: the escape hatch for a
 * network that blocks even the TURN relay, not the ordinary way to run.
 */
export type WeightTransport = 'websocket' | 'webrtc';

export const WEIGHT_TRANSPORTS: readonly WeightTransport[] = ['websocket', 'webrtc'] as const;

export const isWeightTransport = (value: unknown): value is WeightTransport =>
  WEIGHT_TRANSPORTS.includes(value as WeightTransport);

/** Short label and one-line rationale for each mode, rendered by the picker. */
export const WEIGHT_TRANSPORT_LABELS: Record<WeightTransport, { label: string; hint: string }> = {
  websocket: {
    label: 'WebSocket',
    hint: 'Weights pass through the Hypha server, which can read them. The fallback for a network that blocks peer-to-peer outright.',
  },
  webrtc: {
    label: 'WebRTC',
    hint: 'Weights travel encrypted between the two sites, directly where the network allows it and over a relay that cannot read them where it does not.',
  },
};

/**
 * Default for a fresh browser. `webrtc`, because keeping weights away from the
 * server is the point of the platform and the TURN relay covers the networks
 * that cannot open a direct path, so the case where peer-to-peer genuinely
 * cannot connect is now the exception rather than the rule. An operator on such
 * a network turns the switch off once and the choice is persisted. Override at
 * build time with REACT_APP_WEIGHT_TRANSPORT.
 */
const configured = process.env.REACT_APP_WEIGHT_TRANSPORT;

export const DEFAULT_WEIGHT_TRANSPORT: WeightTransport =
  isWeightTransport(configured) ? configured : 'webrtc';

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
