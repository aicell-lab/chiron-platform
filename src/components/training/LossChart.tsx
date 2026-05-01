import React, { useRef, useState } from 'react';

interface LossChartProps {
  title: string;
  /** Aggregated loss per round: [round, loss][] */
  data: [number, number][];
  /** Main line color */
  color: string;
  /** Area fill color */
  fill: string;
  /** Per-trainer losses keyed by client ID: Record<clientId, [round, loss][]> */
  clientData?: Record<string, [number, number][]>;
  /** Optional display labels keyed by client ID (e.g. worker names) */
  clientLabels?: Record<string, string>;
}

const TRAINER_PALETTE = ['#f97316', '#a855f7', '#ef4444', '#06b6d4', '#f59e0b', '#ec4899'];

const W = 420;
const H = 200;
const PAD = { l: 52, r: 16, t: 16, b: 36 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;

const LossChart: React.FC<LossChartProps> = ({ title, data, color, fill, clientData = {}, clientLabels = {} }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const mainData = data.map(([round, value]) => ({ round, value }));
  const clientEntries = Object.entries(clientData);

  // Union of all rounds across all series
  const allRounds = [...new Set([
    ...mainData.map(d => d.round),
    ...clientEntries.flatMap(([, arr]) => arr.map(([r]) => r)),
  ])].sort((a, b) => a - b);

  const allValues = [
    ...mainData.map(d => d.value),
    ...clientEntries.flatMap(([, arr]) => arr.map(([, v]) => v)),
  ];
  const maxV = allValues.length > 0 ? Math.max(...allValues) : 1;
  const minV = allValues.length > 0 ? Math.min(...allValues) : 0;
  const range = maxV - minV || 1;

  const roundToX = (round: number) => {
    const idx = allRounds.indexOf(round);
    return PAD.l + (idx / Math.max(allRounds.length - 1, 1)) * PLOT_W;
  };
  const valueToY = (v: number) => PAD.t + ((maxV - v) / range) * PLOT_H;

  const mainPts = mainData.map(d => ({
    x: roundToX(d.round), y: valueToY(d.value), round: d.round, value: d.value,
  }));

  const clientPts = clientEntries.map(([clientId, arr], ci) => ({
    clientId,
    label: clientLabels[clientId] || `Trainer ${ci + 1}`,
    color: TRAINER_PALETTE[ci % TRAINER_PALETTE.length],
    pts: arr.map(([round, value]) => ({ x: roundToX(round), y: valueToY(value), round, value })),
    byRound: Object.fromEntries(arr.map(([r, v]) => [r, v])),
  }));

  const handleMouseMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (!svgRef.current || !containerRef.current || mainPts.length === 0) return;
    const svgRect = svgRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const scaleX = W / svgRect.width;
    const mouseX = (e.clientX - svgRect.left) * scaleX;

    let closestIdx = 0;
    let minDist = Infinity;
    mainPts.forEach((p, i) => {
      const d = Math.abs(p.x - mouseX);
      if (d < minDist) { minDist = d; closestIdx = i; }
    });
    setHoverIdx(closestIdx);
    setTooltipPos({ x: e.clientX - containerRect.left, y: e.clientY - containerRect.top });
  };

  const hoverPt = hoverIdx !== null ? mainPts[hoverIdx] : null;

  const visibleRoundLabels = allRounds.filter((_, i, a) =>
    i === 0 || i === a.length - 1 || a.length <= 10 || i % Math.ceil(a.length / 5) === 0
  );

  return (
    <div>
      {/* Title + legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
        <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{title}</h4>
        <div className="flex flex-wrap gap-x-3 gap-y-1 ml-auto items-center">
          <div className="flex items-center gap-1">
            <svg width="20" height="8">
              <line x1="0" y1="4" x2="20" y2="4" stroke={color} strokeWidth="2.5" />
              <circle cx="10" cy="4" r="2.5" fill={color} />
            </svg>
            <span className="text-xs text-gray-500">Aggregated</span>
          </div>
          {clientPts.map(({ clientId, label, color: c }) => (
            <div key={clientId} className="flex items-center gap-1">
              <svg width="20" height="8">
                <line x1="0" y1="4" x2="20" y2="4" stroke={c} strokeWidth="1.5" strokeDasharray="4 2" />
                <circle cx="10" cy="4" r="2" fill={c} />
              </svg>
              <span className="text-xs text-gray-400">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div ref={containerRef} className="relative bg-gray-50 rounded-xl p-2 border border-gray-100">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ cursor: 'crosshair' }}>
          {/* Y grid + labels */}
          {Array.from({ length: 5 }).map((_, i) => {
            const v = maxV - (i / 4) * range;
            const y = PAD.t + (i / 4) * PLOT_H;
            return (
              <g key={i}>
                <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#e5e7eb" strokeWidth="1" />
                <text x={PAD.l - 4} y={y + 4} textAnchor="end" fontSize="9" fill="#9ca3af">{v.toFixed(3)}</text>
              </g>
            );
          })}

          {/* X labels */}
          {visibleRoundLabels.map(round => (
            <text key={round} x={roundToX(round)} y={H - 8} textAnchor="middle" fontSize="9" fill="#9ca3af">{round}</text>
          ))}
          <text x={W / 2} y={H - 1} textAnchor="middle" fontSize="9" fill="#6b7280">Round</text>

          {/* Area fill (aggregated) */}
          {mainPts.length > 1 && (
            <polygon
              points={[
                ...mainPts.map(p => `${p.x},${p.y}`),
                `${mainPts[mainPts.length - 1].x},${PAD.t + PLOT_H}`,
                `${mainPts[0].x},${PAD.t + PLOT_H}`,
              ].join(' ')}
              fill={fill} opacity="0.4"
            />
          )}

          {/* Per-trainer dashed lines (behind main) */}
          {clientPts.map(({ clientId, color: c, pts }) => (
            <g key={clientId}>
              {pts.length > 1 && (
                <polyline
                  points={pts.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="5 3" strokeLinejoin="round" opacity="0.75"
                />
              )}
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="2.5" fill={c} stroke="white" strokeWidth="1" opacity="0.85" />
              ))}
            </g>
          ))}

          {/* Aggregated line */}
          {mainPts.length > 1 && (
            <polyline
              points={mainPts.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round"
            />
          )}
          {mainPts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={color} stroke="white" strokeWidth="1.5" />
          ))}

          {/* Hover overlay: crosshair + enlarged dots */}
          {hoverPt && (
            <g>
              <line
                x1={hoverPt.x} y1={PAD.t} x2={hoverPt.x} y2={PAD.t + PLOT_H}
                stroke="#6b7280" strokeWidth="1" strokeDasharray="4 3" opacity="0.6"
              />
              {clientPts.map(({ clientId, color: c, pts }) => {
                const pt = pts.find(p => p.round === hoverPt.round);
                return pt ? (
                  <circle key={clientId} cx={pt.x} cy={pt.y} r="4" fill={c} stroke="white" strokeWidth="2" />
                ) : null;
              })}
              <circle cx={hoverPt.x} cy={hoverPt.y} r="5" fill={color} stroke="white" strokeWidth="2" />
            </g>
          )}

          {/* Invisible mouse capture rect */}
          <rect
            x={PAD.l} y={PAD.t} width={PLOT_W} height={PLOT_H}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => { setHoverIdx(null); setTooltipPos(null); }}
          />
        </svg>

        {/* Tooltip */}
        {hoverPt && tooltipPos && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg bg-white border border-gray-200 shadow-lg p-2 text-xs"
            style={{
              top: Math.max(0, tooltipPos.y - 10),
              ...(containerRef.current && tooltipPos.x > containerRef.current.clientWidth - 150
                ? { right: containerRef.current.clientWidth - tooltipPos.x + 14 }
                : { left: tooltipPos.x + 14 }),
              minWidth: 130,
            }}
          >
            <div className="font-semibold text-gray-700 mb-1.5">Round {hoverPt.round}</div>
            <div className="flex items-center gap-1.5 text-gray-600">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
              <span>Aggregated</span>
              <span className="ml-auto font-mono font-bold">{hoverPt.value.toFixed(4)}</span>
            </div>
            {clientPts.map(({ clientId, label, color: c, byRound }) => {
              const v = byRound[hoverPt.round];
              return v !== undefined ? (
                <div key={clientId} className="flex items-center gap-1.5 text-gray-500 mt-0.5">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: c }} />
                  <span>{label}</span>
                  <span className="ml-auto font-mono">{v.toFixed(4)}</span>
                </div>
              ) : null;
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default LossChart;
