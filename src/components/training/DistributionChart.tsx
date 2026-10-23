import React from 'react';
import { thresholdBin } from '../../config/preprocessing';

interface DistributionChartProps {
  /** One count per bin. Aggregate only: this never carries a per-cell value. */
  counts: number[];
  /** Bin edges, one longer than `counts`. Log spaced. */
  edges: number[];
  /** Observations at zero, which log bins have nowhere to put. */
  zero?: number;
  /** Where the filter cuts, drawn as a line through the bars. */
  threshold?: number | null;
  thresholdLabel?: string;
  /** What one observation is: "cells", "genes". */
  unit: string;
  title: string;
  /** One sentence saying what the reader is looking at. */
  caption?: string;
  /** True when some stores of this dataset could not be merged in. */
  partial?: boolean;
  /** Set when this is ONE store's distribution rather than the dataset's,
   *  which the chart has to say rather than label it with the dataset. */
  fromStore?: string;
  ofFiles?: number;
}

const compact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  if (value >= 10) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
};

/**
 * A log-binned distribution with the threshold that cuts it marked.
 *
 * Aggregate by construction. The only numbers that reach this component are
 * one count per bin, which is what lets a federated platform show an organiser
 * what their filter did to a site's data without the site saying anything
 * about any one cell.
 *
 * The bars are drawn with plain elements rather than a charting library. There
 * are at most a few dozen of them, the axis is fixed, and the one interactive
 * thing is a tooltip, so a dependency would buy nothing and cost a bundle.
 */
const DistributionChart: React.FC<DistributionChartProps> = ({
  counts,
  edges,
  zero,
  threshold,
  thresholdLabel,
  unit,
  title,
  caption,
  partial,
  fromStore,
  ofFiles,
}) => {
  if (!counts?.length || !edges?.length) {
    return (
      <div className="bg-gray-50 rounded-xl p-3">
        <p className="text-xs font-medium text-gray-500">{title}</p>
        <p className="text-xs text-gray-400 italic mt-2">
          Not computed for this dataset yet.
        </p>
      </div>
    );
  }

  // Trim the empty tails. The grid is fixed so that stores can be added
  // together, which leaves most of it empty on any one dataset, and drawing
  // twenty empty bars either side makes the occupied middle unreadable.
  let first = counts.findIndex(c => c > 0);
  let last = counts.length - 1;
  while (last > 0 && counts[last] === 0) last -= 1;
  if (first === -1) first = 0;
  if (last < first) last = first;

  const cutAt = thresholdBin(edges, threshold ?? undefined);
  // Keep the threshold's bar visible even when it falls in an empty tail,
  // otherwise a filter that excludes everything shows no line at all.
  if (cutAt !== undefined) {
    first = Math.min(first, cutAt);
    last = Math.max(last, cutAt);
  }

  const shown = counts.slice(first, last + 1);
  const peak = Math.max(...shown, 1);
  const total = counts.reduce((sum, c) => sum + c, 0);

  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <div className="flex items-baseline justify-between mb-1">
        <p className="text-xs font-medium text-gray-500">{title}</p>
        <p className="text-[10px] text-gray-400">
          {total.toLocaleString()} {unit}
          {zero ? ` + ${zero.toLocaleString()} at zero` : ''}
        </p>
      </div>

      <div className="flex items-end gap-px h-20" role="img" aria-label={title}>
        {shown.map((count, i) => {
          const index = first + i;
          const isCut = cutAt === index;
          const low = edges[index];
          const high = edges[index + 1];
          return (
            <div
              key={index}
              className="flex-1 flex flex-col justify-end h-full group relative"
              title={
                `${compact(low)} to ${compact(high)} ${unit.replace(/s$/, '')}` +
                `: ${count.toLocaleString()}`
              }
            >
              <div
                className={`w-full rounded-t ${
                  isCut ? 'bg-amber-400' : 'bg-blue-400 group-hover:bg-blue-500'
                } transition-colors`}
                // The threshold's bar keeps a floor even when its bin is
                // empty. Without it, widening the range to include the cut
                // achieved nothing but a wider empty axis: the amber bar had
                // zero height and drew nothing, in exactly the case the
                // widening exists for, which is a filter that excludes
                // everything.
                style={{
                  height: `${Math.max(
                    (count / peak) * 100,
                    count > 0 ? 2 : isCut ? 6 : 0
                  )}%`,
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
        <span>{compact(edges[first])}</span>
        <span>{compact(edges[last + 1])}</span>
      </div>

      {cutAt !== undefined && thresholdLabel && (
        <p className="text-[10px] text-amber-700 mt-1">{thresholdLabel}</p>
      )}
      {cutAt === undefined && threshold ? (
        <p className="text-[10px] text-gray-400 mt-1">
          {threshold > edges[edges.length - 1]
            ? `The threshold of ${threshold.toLocaleString()} is above everything
               measured here, so it excludes all of them.`
            : `The threshold of ${threshold.toLocaleString()} is below everything
               measured here, so it excludes none of them${
                 zero ? ` beyond the ${zero.toLocaleString()} at zero` : ''
               }.`}
        </p>
      ) : null}
      {caption && <p className="text-[10px] text-gray-500 mt-1">{caption}</p>}
      {partial && (
        <p className="text-[10px] text-amber-700 mt-1">
          Some files of this dataset were prepared on a different scale and are
          not included in this chart.
        </p>
      )}
      {/* A per-gene distribution cannot be summed across a dataset's files
          without counting each gene once per file, so the manager sends one
          file's and names it. Saying so is the difference between a figure and
          a mislabelled one. */}
      {fromStore && (ofFiles ?? 1) > 1 && (
        <p className="text-[10px] text-gray-500 mt-1">
          From {fromStore}, one of this dataset's {ofFiles} files. Genes cannot
          be counted across files without counting each one more than once.
        </p>
      )}
    </div>
  );
};

export default DistributionChart;
