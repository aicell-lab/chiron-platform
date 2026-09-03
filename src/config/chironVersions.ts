/**
 * The oldest worker image and the oldest Chiron applications this build of the
 * platform will work with.
 *
 * Why this exists
 * ---------------
 * A worker is started by hand, from a compose file the user keeps, and it keeps
 * running until somebody restarts it. So at any moment the federation contains
 * workers on several image versions and several app versions, and the frontend
 * is the only place that knows what the current contract is.
 *
 * Every incompatibility shipped so far surfaced the same bad way: the UI looked
 * normal, the user started a run, and several minutes later something failed
 * for a reason that had nothing to do with what they did. Declaring a floor
 * turns that into a statement made before the run, next to the thing that is
 * out of date, naming the version to move to.
 *
 * When to raise a floor
 * ---------------------
 * When an API changed shape, or when a bug was fixed that the platform cannot
 * work around. Not for every release. Each floor carries the reason it was
 * raised, and the UI shows that reason verbatim, so a user who is told to
 * upgrade is also told why.
 *
 * What is deliberately not blocked
 * --------------------------------
 * A version this file cannot parse. `latest`, a digest pin, or a locally built
 * tag all read as "unknown", and unknown is never treated as too old. A
 * maintainer running a development image would otherwise be locked out of their
 * own worker, and the failure mode of guessing wrong here is worse than the
 * failure mode of not checking.
 */

/** A minimum version, and the reason a user is being asked to move to it. */
export interface VersionFloor {
  minimum: string;
  reason: string;
}

/**
 * Image versions the setup wizard offers, newest first. The wizard's default is
 * the first entry. All Chiron images are built and released together from one
 * version in the tabula repo, so a release adds one string here.
 */
export const CHIRON_IMAGE_VERSIONS = ['0.7.7'];

/** Version the wizard writes into a new worker's compose file. */
export const CURRENT_IMAGE_VERSION = CHIRON_IMAGE_VERSIONS[0];

export const MIN_IMAGE_VERSION: VersionFloor = {
  minimum: '0.7.7',
  reason:
    'Images before 0.7.7 ship an older hypha-rpc whose peer connection never ' +
    'completes when the two sides are in different workspaces, so the first ' +
    'weight transfer of a federated run hangs with no error.',
};

/**
 * Floors for the Chiron applications a worker hosts, keyed by artifact alias
 * (the part after the workspace in `chiron-platform/chiron-manager`).
 */
export const MIN_APP_VERSIONS: Record<string, VersionFloor> = {
  'chiron-manager': {
    minimum: '0.2.12',
    reason:
      'The manager reports which model its image can train. Without that, ' +
      'Chiron cannot tell a Tabula worker from any other and cannot stop a ' +
      'mismatched trainer from being deployed onto it.',
  },
  'chiron-orchestrator': {
    minimum: '0.3.34',
    reason:
      'Earlier orchestrators bound none of their peer-connection calls and ' +
      'reported nothing when a round failed, so a crashed run was ' +
      'indistinguishable from a finished one.',
  },
  'tabula-trainer': {
    minimum: '0.5.6',
    reason:
      'A model\'s base weights are now named by its architecture card, and ' +
      'only a trainer from 0.5.6 knows to follow that card to the weights ' +
      'themselves. An older one looks for a checkpoint file on the card and ' +
      'fails at the start of the run.',
  },
};

/** Numeric parts of a version string, or null when it is not one. */
const parseVersion = (version: string): number[] | null => {
  const cleaned = version.trim().replace(/^v/, '');
  // Drop any pre-release or build suffix: 0.7.7-rc1 compares as 0.7.7.
  const core = cleaned.split(/[-+]/)[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split('.').map(Number);
};

/**
 * Compare two version strings. Returns a negative number when `a` is older,
 * zero when they are equal, positive when `a` is newer, and null when either
 * side is not a version this can reason about.
 */
export const compareVersions = (a: string, b: string): number | null => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * True only when `version` is definitely older than the floor. An unparseable
 * or missing version is not below the floor, by design. See the module note.
 */
export const isBelowFloor = (
  version: string | undefined | null,
  floor: VersionFloor | undefined
): boolean => {
  if (!version || !floor) return false;
  const order = compareVersions(version, floor.minimum);
  return order !== null && order < 0;
};

/**
 * The tag of a container image reference, or undefined when it carries none or
 * is pinned by digest. `ghcr.io/aicell-lab/chiron-tabula:0.7.7` gives `0.7.7`.
 */
export const imageVersionFromRef = (
  imageRef: string | undefined | null
): string | undefined => {
  if (!imageRef) return undefined;
  if (imageRef.includes('@')) return undefined; // digest pin, no readable tag
  // Only the part after the last colon, and only if that colon comes after the
  // last slash, so a registry port (`host:5000/img`) is not read as a tag.
  const lastColon = imageRef.lastIndexOf(':');
  const lastSlash = imageRef.lastIndexOf('/');
  if (lastColon < 0 || lastColon < lastSlash) return undefined;
  return imageRef.slice(lastColon + 1) || undefined;
};

/** The floor for an application, given the artifact id it was deployed from. */
export const appVersionFloor = (
  artifactId: string | undefined | null
): VersionFloor | undefined => {
  if (!artifactId) return undefined;
  const alias = artifactId.split('/').pop() || artifactId;
  return MIN_APP_VERSIONS[alias];
};

/**
 * Whether a worker's image is too old to use, and the sentence to show if so.
 * `undefined` means the image is fine or its version cannot be read.
 */
export const imageTooOld = (
  imageRef: string | undefined | null
): { version: string; floor: VersionFloor } | undefined => {
  const version = imageVersionFromRef(imageRef);
  if (!version || !isBelowFloor(version, MIN_IMAGE_VERSION)) return undefined;
  return { version, floor: MIN_IMAGE_VERSION };
};

/**
 * Whether a deployed application is too old to use, and why. `undefined` means
 * it is fine, unknown to this build, or carries a version that cannot be read.
 */
export const appTooOld = (
  artifactId: string | undefined | null,
  version: string | undefined | null
): { version: string; floor: VersionFloor } | undefined => {
  const floor = appVersionFloor(artifactId);
  if (!floor || !version || !isBelowFloor(version, floor)) return undefined;
  return { version, floor };
};
