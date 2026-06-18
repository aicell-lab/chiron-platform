import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { BiCube } from 'react-icons/bi';
import { TbServer, TbTopologyStar, TbExternalLink } from 'react-icons/tb';

const BIORXIV_URL = 'https://www.biorxiv.org/content/10.1101/2025.01.06.631427v1';
const BIOENGINE_URL = 'https://github.com/aicell-lab/bioengine';
const CHIRON_GITHUB_URL = 'https://github.com/aicell-lab/chiron-platform';
const SKILL_URL = 'https://chiron.aicell.io/skills/chiron-platform/SKILL.md';

// Strong ease-out from emil-design-eng — used for entry / exit motion
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];
const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];

// Concept animations and explainers are a work in progress — hidden until
// they have been refined. Flip to true to re-enable the "How Chiron works"
// section. All concept components below stay in the file so the next
// editing round can iterate without resurrecting them. The widened boolean
// type stops TypeScript from narrowing to the literal `false` and tripping
// the no-unused-vars lint on the use site below.
const SHOW_HOW_CHIRON_WORKS: boolean = false;

type DirectionCardProps = {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: string;
  to: string;
};

const DirectionCard: React.FC<DirectionCardProps> = ({ icon, title, body, cta, to }) => {
  const navigate = useNavigate();
  const go = () => navigate(to);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      }}
      className="group bg-white/70 backdrop-blur-sm rounded-2xl shadow-sm border border-white/40 hover:shadow-lg hover:border-blue-200 transition-all duration-200 p-6 flex flex-col h-full cursor-pointer active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <div className="w-12 h-12 rounded-xl bg-gradient-to-r from-blue-100 to-purple-100 flex items-center justify-center mb-4 group-hover:scale-105 transition-transform duration-200">
        {icon}
      </div>
      <h3 className="text-xl font-semibold text-gray-800 mb-2">{title}</h3>
      <p className="text-gray-600 mb-6 leading-relaxed text-sm flex-grow">{body}</p>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          go();
        }}
        className="w-full px-6 py-3 text-white rounded-xl shadow-sm font-medium bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
      >
        {cta}
      </button>
    </div>
  );
};

const BioEngineAnim: React.FC = () => {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 320 280" className="w-full h-full" role="img" aria-label="BioEngine schematic">
      {/* Worker container */}
      <rect x="60" y="70" width="220" height="170" rx="20" fill="#EEF2FF" stroke="#C7D2FE" strokeWidth="2" />
      <text x="170" y="100" textAnchor="middle" fontSize="13" fontWeight="600" fill="#4338CA">
        BioEngine Worker
      </text>

      {/* Model artifact sliding in */}
      <motion.g
        initial={reduce ? { x: 100, opacity: 1 } : { x: -80, opacity: 0 }}
        animate={
          reduce
            ? {}
            : {
                x: [-80, 100, 100, -80, -80],
                opacity: [0, 1, 1, 0, 0],
              }
        }
        transition={{
          duration: 5,
          times: [0, 0.25, 0.6, 0.85, 1],
          ease: EASE_OUT,
          repeat: Infinity,
          repeatDelay: 0.5,
        }}
      >
        <rect x="10" y="115" width="60" height="50" rx="8" fill="#A78BFA" />
        <text x="40" y="138" textAnchor="middle" fontSize="9" fontWeight="600" fill="white">
          model
        </text>
        <text x="40" y="152" textAnchor="middle" fontSize="8" fill="white">
          v0.5.1
        </text>
      </motion.g>

      {/* Three deployment circles inside the worker */}
      {[
        { cx: 110, cy: 175, label: 'Data Server', color: '#60A5FA' },
        { cx: 170, cy: 175, label: 'Trainer', color: '#34D399' },
        { cx: 230, cy: 175, label: 'Manager', color: '#FBBF24' },
      ].map((d, i) => (
        <g key={d.label}>
          <motion.circle
            cx={d.cx}
            cy={d.cy}
            r="22"
            fill={d.color}
            initial={reduce ? { scale: 1, opacity: 1 } : { scale: 0.85, opacity: 0.4 }}
            animate={
              reduce
                ? {}
                : {
                    scale: [0.85, 1, 0.85],
                    opacity: [0.4, 1, 0.4],
                  }
            }
            transition={{
              duration: 2.4,
              ease: EASE_IN_OUT,
              repeat: Infinity,
              delay: 1.2 + i * 0.3,
            }}
          />
          <text x={d.cx} y={d.cy + 38} textAnchor="middle" fontSize="9" fill="#4B5563">
            {d.label}
          </text>
        </g>
      ))}

      {/* Worker base label */}
      <text x="170" y="220" textAnchor="middle" fontSize="9" fill="#6B7280" fontStyle="italic">
        a Ray-based runtime for AI apps
      </text>
    </svg>
  );
};

const WorkerAnim: React.FC = () => {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 320 280" className="w-full h-full" role="img" aria-label="Worker schematic">
      {/* Worker container */}
      <rect x="40" y="40" width="200" height="200" rx="16" fill="#F0F9FF" stroke="#BAE6FD" strokeWidth="2" />
      <text x="140" y="60" textAnchor="middle" fontSize="11" fontWeight="600" fill="#0369A1">
        BioEngine Worker
      </text>

      {/* Data Server box */}
      <rect x="60" y="80" width="160" height="50" rx="8" fill="white" stroke="#7DD3FC" strokeWidth="1.5" />
      <text x="140" y="100" textAnchor="middle" fontSize="10" fontWeight="600" fill="#0C4A6E">
        Data server
      </text>
      <text x="140" y="115" textAnchor="middle" fontSize="9" fill="#334155">
        .h5ad → .zarr
      </text>

      {/* Internal stream line */}
      <motion.line
        x1="140"
        y1="130"
        x2="140"
        y2="155"
        stroke="#06B6D4"
        strokeWidth="2"
        strokeDasharray="3 3"
        initial={reduce ? { strokeDashoffset: 0 } : { strokeDashoffset: 20 }}
        animate={reduce ? {} : { strokeDashoffset: 0 }}
        transition={{ duration: 1.2, ease: 'linear', repeat: Infinity }}
      />

      {/* Trainer box */}
      <rect x="60" y="155" width="160" height="65" rx="8" fill="white" stroke="#86EFAC" strokeWidth="1.5" />
      <text x="140" y="175" textAnchor="middle" fontSize="10" fontWeight="600" fill="#14532D">
        Tabula Trainer
      </text>
      <text x="140" y="190" textAnchor="middle" fontSize="9" fill="#334155">
        GPU
      </text>

      {/* Outgoing weights arrow */}
      <motion.g
        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
        animate={reduce ? {} : { opacity: [0, 1, 1, 0] }}
        transition={{ duration: 3, times: [0, 0.2, 0.8, 1], repeat: Infinity, repeatDelay: 0.4 }}
      >
        <line x1="240" y1="187" x2="295" y2="187" stroke="#0EA5E9" strokeWidth="2" markerEnd="url(#arrowBlue)" />
        <text x="295" y="180" textAnchor="end" fontSize="9" fontWeight="600" fill="#0369A1">
          weights only →
        </text>
      </motion.g>

      {/* Blocked raw-data attempt */}
      <motion.g
        initial={{ opacity: 0 }}
        animate={reduce ? { opacity: 0.6 } : { opacity: [0, 0, 0.9, 0.9, 0] }}
        transition={{ duration: 3, times: [0, 0.4, 0.5, 0.8, 1], repeat: Infinity, repeatDelay: 0.4 }}
      >
        <line
          x1="40"
          y1="105"
          x2="15"
          y2="105"
          stroke="#EF4444"
          strokeWidth="2"
          strokeDasharray="4 4"
        />
        <circle cx="40" cy="105" r="7" fill="white" stroke="#EF4444" strokeWidth="2" />
        <line x1="36" y1="101" x2="44" y2="109" stroke="#EF4444" strokeWidth="2" />
        <line x1="44" y1="101" x2="36" y2="109" stroke="#EF4444" strokeWidth="2" />
        <text x="22" y="125" textAnchor="middle" fontSize="8" fill="#B91C1C">
          raw data blocked
        </text>
      </motion.g>

      <defs>
        <marker id="arrowBlue" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" fill="#0EA5E9" />
        </marker>
      </defs>

      <text x="140" y="255" textAnchor="middle" fontSize="9" fill="#6B7280" fontStyle="italic">
        two isolated containers per site
      </text>
    </svg>
  );
};

const FederatedAnim: React.FC = () => {
  const reduce = useReducedMotion();
  const ROUND_PERIOD = 6;

  const workers = [
    { cx: 80, cy: 70, label: 'Site A' },
    { cx: 240, cy: 70, label: 'Site B' },
    { cx: 160, cy: 230, label: 'Site C' },
  ];

  return (
    <svg viewBox="0 0 320 280" className="w-full h-full" role="img" aria-label="Federated learning schematic">
      {/* Central orchestrator */}
      <circle cx="160" cy="150" r="42" fill="#FCE7F3" stroke="#F9A8D4" strokeWidth="2" />
      <text x="160" y="145" textAnchor="middle" fontSize="10" fontWeight="700" fill="#9D174D">
        Orchestrator
      </text>
      <text x="160" y="160" textAnchor="middle" fontSize="9" fill="#831843">
        FedAvg
      </text>

      {/* Worker nodes */}
      {workers.map((w) => (
        <g key={w.label}>
          <motion.circle
            cx={w.cx}
            cy={w.cy}
            r="22"
            fill="#DBEAFE"
            stroke="#93C5FD"
            strokeWidth="2"
            initial={reduce ? { scale: 1 } : { scale: 1 }}
            animate={
              reduce
                ? {}
                : {
                    scale: [1, 1.12, 1, 1],
                  }
            }
            transition={{
              duration: ROUND_PERIOD,
              times: [0, 0.35, 0.5, 1],
              repeat: Infinity,
              ease: EASE_IN_OUT,
            }}
          />
          <text x={w.cx} y={w.cy + 4} textAnchor="middle" fontSize="10" fontWeight="600" fill="#1E40AF">
            {w.label}
          </text>
        </g>
      ))}

      {/* Broadcast arrows (purple, outward from orchestrator) */}
      {workers.map((w) => (
        <motion.line
          key={`broadcast-${w.label}`}
          x1="160"
          y1="150"
          x2={w.cx}
          y2={w.cy}
          stroke="#7C3AED"
          strokeWidth="2"
          strokeLinecap="round"
          initial={reduce ? { pathLength: 1, opacity: 0.4 } : { pathLength: 0, opacity: 0 }}
          animate={
            reduce
              ? {}
              : {
                  pathLength: [0, 1, 1, 1],
                  opacity: [0, 0.9, 0, 0],
                }
          }
          transition={{
            duration: ROUND_PERIOD,
            times: [0, 0.2, 0.35, 1],
            repeat: Infinity,
            ease: EASE_OUT,
          }}
        />
      ))}

      {/* Aggregate arrows (orange dashed, inward to orchestrator) */}
      {workers.map((w) => (
        <motion.line
          key={`aggregate-${w.label}`}
          x1={w.cx}
          y1={w.cy}
          x2="160"
          y2="150"
          stroke="#F59E0B"
          strokeWidth="2"
          strokeDasharray="4 4"
          strokeLinecap="round"
          initial={reduce ? { opacity: 0.4 } : { opacity: 0 }}
          animate={
            reduce
              ? {}
              : {
                  opacity: [0, 0, 0.9, 0, 0],
                }
          }
          transition={{
            duration: ROUND_PERIOD,
            times: [0, 0.55, 0.7, 0.85, 1],
            repeat: Infinity,
            ease: EASE_OUT,
          }}
        />
      ))}

      {/* Legend (always visible) */}
      <g>
        <line x1="20" y1="265" x2="35" y2="265" stroke="#7C3AED" strokeWidth="2" />
        <text x="40" y="269" fontSize="9" fill="#4B5563">
          broadcast
        </text>
        <line x1="120" y1="265" x2="135" y2="265" stroke="#F59E0B" strokeWidth="2" strokeDasharray="3 3" />
        <text x="140" y="269" fontSize="9" fill="#4B5563">
          weights only
        </text>
      </g>
    </svg>
  );
};

type ConceptProps = {
  index: number;
  title: string;
  body: string;
  link: { href: string; label: string };
  animation: React.ReactNode;
};

const Concept: React.FC<ConceptProps> = ({ index, title, body, link, animation }) => {
  const reverse = index % 2 === 1;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center py-8">
      <div className={`order-1 ${reverse ? 'md:order-2' : 'md:order-1'}`}>
        <div className="max-w-md mx-auto md:mx-0">
          <div className="aspect-square">{animation}</div>
        </div>
      </div>
      <div className={`order-2 ${reverse ? 'md:order-1' : 'md:order-2'}`}>
        <h3 className="text-xl font-semibold text-gray-800 mb-3">{title}</h3>
        <p className="text-gray-600 leading-relaxed mb-4">{body}</p>
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 text-sm font-medium"
        >
          {link.label}
          <TbExternalLink size={14} />
        </a>
      </div>
    </div>
  );
};

const Landing: React.FC = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* Hero */}
      <section className="container mx-auto px-4 pt-16 pb-10">
        <div className="text-center max-w-3xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-700 to-purple-700 mb-4">
            Chiron
          </h1>
          <p className="text-lg md:text-xl text-gray-700 leading-relaxed">
            A decentralized platform for collaborative single-cell foundation models.
          </p>
          <p className="text-sm text-gray-500 mt-3 max-w-2xl mx-auto">
            Explore published models, set up a worker on your hardware, and join federated training sessions — all without
            moving raw single-cell data off your site.
          </p>
        </div>
      </section>

      {/* Three direction cards */}
      <section className="container mx-auto px-4 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
          <DirectionCard
            icon={<BiCube className="text-blue-700" size={26} />}
            title="Explore models"
            body="Browse the Chiron Model Hub. Discover published Tabula checkpoints, filter by tissue, and load them in a notebook for zero-shot or fine-tuning runs."
            cta="Open the Model Hub"
            to="/models"
          />
          <DirectionCard
            icon={<TbServer className="text-blue-700" size={26} />}
            title="Set up a worker"
            body="Bring your data, run a BioEngine Worker on your hardware. A browser wizard generates a one-line launch command for Docker, Podman, Singularity, or Apptainer."
            cta="Launch the setup wizard"
            to="/worker"
          />
          <DirectionCard
            icon={<TbTopologyStar className="text-blue-700" size={26} />}
            title="Train models"
            body="Configure and monitor a federated training session across your registered workers. Watch per-round losses and downstream-task metrics, publish the result to the Hub."
            cta="Configure training"
            to="/training"
          />
        </div>
      </section>

      {/* How Chiron works — hidden until the section is refined.
          Flip SHOW_HOW_CHIRON_WORKS at the top of the file to re-enable. */}
      {SHOW_HOW_CHIRON_WORKS && (
        <section className="container mx-auto px-4 pb-16 max-w-5xl">
          <div className="text-center max-w-2xl mx-auto mb-6">
            <h2 className="text-2xl md:text-3xl font-semibold text-gray-800 mb-2">How Chiron works</h2>
            <p className="text-sm text-gray-600">
              Three concepts that underpin the platform. The animations loop continuously — give them a few seconds to walk
              you through what happens.
            </p>
          </div>

          <div className="bg-white/60 backdrop-blur-sm border border-white/40 rounded-3xl px-6 md:px-10 py-4 divide-y divide-gray-100">
            <Concept
              index={0}
              title="BioEngine: an open runtime for biomedical AI apps"
              body="BioEngine is a Ray-based runtime that lets researchers package an AI tool — a model, a fine-tuning loop, an inference pipeline — as a versioned artifact and deploy it on their own hardware behind a Hypha RPC endpoint. Chiron is built on top of BioEngine. The Manager, Orchestrator and Trainer are all BioEngine apps."
              link={{ href: BIOENGINE_URL, label: 'BioEngine on GitHub' }}
              animation={<BioEngineAnim />}
            />
            <Concept
              index={1}
              title="Workers: two isolated containers per site"
              body="Each participating site runs a BioEngine Worker that pairs a local data server (which exposes private single-cell data over an authenticated container-internal stream) with a Tabula Trainer (which holds the GPU-bound model). Raw data never leaves the site. Only transformer weights are exchanged with the rest of the federation."
              link={{ href: SKILL_URL, label: 'Chiron platform skill' }}
              animation={<WorkerAnim />}
            />
            <Concept
              index={2}
              title="Federated learning: train without sharing raw data"
              body="A central orchestrator broadcasts the current global model to every participating worker. Each worker trains for one epoch on its private data and returns only the updated transformer weights. The orchestrator averages them with FedAvg into a new global model and starts the next round. Across the whole run the orchestrator only ever sees weights and scalar metrics."
              link={{ href: BIORXIV_URL, label: 'Read the bioRxiv preprint' }}
              animation={<FederatedAnim />}
            />
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="container mx-auto px-4 pb-10">
        <div className="max-w-5xl mx-auto pt-6 border-t border-gray-200 flex flex-col md:flex-row items-center justify-between gap-3 text-sm text-gray-500">
          <p>Chiron is open source and built on top of BioEngine.</p>
          <div className="flex items-center gap-4">
            <a
              href={CHIRON_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-700 transition-colors duration-200"
            >
              GitHub
            </a>
            <a
              href={BIORXIV_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-700 transition-colors duration-200"
            >
              Preprint
            </a>
            <a
              href={BIOENGINE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-700 transition-colors duration-200"
            >
              BioEngine
            </a>
            <a
              href={SKILL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-700 transition-colors duration-200"
            >
              For agents
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
