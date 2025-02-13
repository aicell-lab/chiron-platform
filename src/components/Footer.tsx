import React from 'react';
import { BiCube } from 'react-icons/bi';

const footerLinks = [
  {
    label: "View source code on GitHub",
    href: "https://github.com/aicell-io/chiron-platform",
    icon: "/img/github.png",
    caption: "Source Code"
  },
  {
    label: "Contact the development team",
    href: "mailto:wei.ouyang@scilifelab.se",
    icon: "/img/contact.png",
    caption: "Contact Us"
  },
  {
    label: "Report issues or request features",
    href: "https://github.com/aicell-io/chiron-platform/issues",
    icon: "/img/feedback-icon.png",
    caption: "Feedback"
  }
];

const Footer: React.FC = () => {
  return (
    <footer className="w-full py-8 px-4 mt-16 bg-gray-50 border-t border-gray-200">
      <div className="max-w-7xl mx-auto">
        {/* Links Section */}
        <div className="flex flex-wrap justify-center items-start gap-4 mb-8">
          {footerLinks.map((link, index) => (
            <div key={index} className="w-[150px] text-center">
              <div className="group relative" title={link.label}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block hover:opacity-80 transition-opacity"
                >
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
                </a>
                <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-4 py-2 bg-gray-900 text-white text-xs rounded-md shadow-lg whitespace-nowrap z-10">
                  {link.label}
                </div>
              </div>
            </div>
          ))}
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
    </footer>
  );
};

export default Footer; 