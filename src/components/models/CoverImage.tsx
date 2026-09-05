import React, { useEffect, useState } from 'react';
import { resolveCoverUrl, resolveCoverFallbackUrl } from '../../utils/artifactApi';

interface CoverImageProps {
  /** Raw `manifest.cover` value, whatever shape it happens to be. */
  cover: unknown;
  /** Artifact the manifest belongs to, used to resolve artifact-local paths. */
  artifactId: string;
  alt: string;
  className?: string;
  /** Rendered when there is no cover at all, or when both candidates 404. */
  fallback?: React.ReactNode;
  loading?: 'lazy' | 'eager';
}

/**
 * A model cover image that survives the two conventions in circulation.
 *
 * `manifest.cover` is a bare filename on everything the trainers publish
 * (`scgpt.png`, `tabula.png`) because the adapter names an asset shipped with
 * the site. The eight seeded `tabula-*` artifacts additionally carry that same
 * file inside the artifact, so for those the artifact-local path resolves too.
 * Nothing else does: the save path uploads `model.pth`, `documentation.md` and
 * `training_history.json` and no cover, so resolving a bare filename against
 * the artifact 404s for every model a user has actually trained.
 *
 * Rather than pick one convention and break the other set, this tries the site
 * asset first and falls back to the artifact-local file, then to the caller's
 * placeholder. A cover that is already an absolute URL is used as-is and has no
 * fallback to try.
 */
const CoverImage: React.FC<CoverImageProps> = ({
  cover,
  artifactId,
  alt,
  className,
  fallback = null,
  loading = 'lazy',
}) => {
  const primary = resolveCoverUrl(cover, artifactId);
  const secondary = resolveCoverFallbackUrl(cover, artifactId);

  // `step` walks primary -> secondary -> give up. Reset it when the inputs
  // change so a re-used component instance doesn't stay stuck on a failure
  // that belonged to the previous artifact.
  const [step, setStep] = useState(0);
  useEffect(() => { setStep(0); }, [primary, secondary]);

  const src = step === 0 ? primary : step === 1 ? secondary : null;
  if (!src) return <>{fallback}</>;

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={() => setStep(s => (s === 0 && secondary ? 1 : 2))}
    />
  );
};

export default CoverImage;
