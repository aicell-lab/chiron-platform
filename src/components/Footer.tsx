import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BiCube } from 'react-icons/bi';
import ReportIssueDialog from './ReportIssueDialog';
import { onReportIssuePrompt } from '../utils/reportIssuePrompt';

// Each entry is either a link out (href) or an in-page action (onClick).
// Report Issue is the action: it opens a dialog rather than sending the user
// to GitHub, because the whole point is that a reporter should not need an
// account anywhere to tell us something is broken.
interface FooterLink {
  label: string;
  icon: string;
  caption: string;
  href?: string;
  onClick?: () => void;
}

// How long the ring stays on the button. Long enough to be seen after the
// scroll settles, short enough that it does not become part of the page.
const HIGHLIGHT_MS = 2600;

const Footer: React.FC = () => {
  const [reportOpen, setReportOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const [promptReason, setPromptReason] = useState<string | null>(null);
  const reportButtonRef = useRef<HTMLButtonElement>(null);

  // Draw attention to the Report Issue button when an error surface asks for
  // it. The button sits below the fold on nearly every page, so an error
  // banner further up has no visible route to the reporting path unless we
  // bring the two together.
  useEffect(() => {
    const timers: number[] = [];

    const unsubscribe = onReportIssuePrompt(({ reason }) => {
      setPromptReason(reason);
      setHighlighted(true);

      const button = reportButtonRef.current;
      if (button) {
        // Only scroll when the button is actually out of view. Yanking the
        // viewport of someone who can already see it is pure annoyance, and
        // the ring alone is enough in that case.
        const rect = button.getBoundingClientRect();
        const visible = rect.top >= 0 && rect.bottom <= window.innerHeight;
        if (!visible) {
          button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      timers.push(
        window.setTimeout(() => setHighlighted(false), HIGHLIGHT_MS)
      );
    });

    return () => {
      unsubscribe();
      timers.forEach(window.clearTimeout);
    };
  }, []);

  const openReport = useCallback(() => {
    setHighlighted(false);
    setReportOpen(true);
  }, []);

  const footerLinks: FooterLink[] = [
    {
      label: "View source code on GitHub",
      href: "https://github.com/aicell-lab/chiron-platform",
      icon: "/img/github.png",
      caption: "Source Code"
    },
    {
      label: "Contact the development team",
      href: "mailto:nils.mechtel@scilifelab.se",
      icon: "/img/contact.png",
      caption: "Contact Us"
    },
    {
      label: "Report issues or request features",
      href: "https://github.com/aicell-lab/chiron-platform/issues",
      icon: "/img/feedback-icon.png",
      caption: "Feedback"
    },
    {
      label: "Send us a problem report with the platform logs attached",
      onClick: openReport,
      icon: "/img/bug-icon.png",
      caption: "Report Issue"
    }
  ];

  return (
    <footer className="w-full py-8 px-4 mt-16 bg-gray-50 border-t border-gray-200">
      <div className="max-w-7xl mx-auto">
        {/* Raised only while a prompt is live, so the ring has a reason next to
            it rather than appearing unexplained. */}
        {promptReason && highlighted && (
          <div className="max-w-2xl mx-auto mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-md text-center">
            <p className="text-sm text-red-800">
              Something went wrong. Send us a report and the platform logs come with it.
            </p>
            <p className="mt-1 text-xs text-red-700 font-mono break-words">
              {promptReason}
            </p>
          </div>
        )}

        {/* Links Section */}
        <div className="flex flex-wrap justify-center items-start gap-4 mb-8">
          {footerLinks.map((link, index) => {
            const isReportIssue = link.caption === 'Report Issue';
            const figure = (
              <figure className="flex flex-col items-center">
                <img
                  src={link.icon}
                  alt={link.caption}
                  className="h-[45px] w-auto object-contain mb-2"
                />
                <figcaption className="text-sm text-gray-600 hidden md:block">
                  {link.caption}
                </figcaption>
              </figure>
            );
            return (
              <div key={index} className="w-[150px] text-center">
                <div className="group relative" title={link.label}>
                  {link.onClick ? (
                    <button
                      type="button"
                      ref={isReportIssue ? reportButtonRef : undefined}
                      onClick={link.onClick}
                      className={`inline-block rounded-lg p-2 hover:opacity-80 transition-all ${
                        isReportIssue && highlighted
                          ? 'ring-4 ring-red-400 ring-offset-2 bg-red-50'
                          : ''
                      }`}
                    >
                      {figure}
                    </button>
                  ) : (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block rounded-lg p-2 hover:opacity-80 transition-opacity"
                    >
                      {figure}
                    </a>
                  )}
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-4 py-2 bg-gray-900 text-white text-xs rounded-md shadow-lg whitespace-nowrap z-10">
                    {link.label}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Content Section */}
        <div className="text-center space-y-6 max-w-4xl mx-auto">
          <div className="border-t border-gray-200 pt-6">
            <div className="flex items-center justify-center text-2xl font-bold text-blue-600 mb-4">
              <BiCube className="mr-2" size={24} />
              Chiron Platform
            </div>
            <p className="text-base text-gray-700 font-medium mb-4">
              A privacy-preserving federated learning platform for single-cell transcriptomics
            </p>
            <p className="text-sm text-gray-600 leading-relaxed px-4">
              Chiron Platform enables secure, collaborative model training across institutions while preserving data privacy and ethical constraints. Join our federation to contribute to advancing single-cell analysis while keeping sensitive data secure.
            </p>
          </div>
        </div>
      </div>

      <ReportIssueDialog open={reportOpen} onClose={() => setReportOpen(false)} />
    </footer>
  );
};

export default Footer;
