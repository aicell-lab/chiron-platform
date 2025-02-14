import React, { useState, useRef, useEffect } from 'react';
import { useHyphaStore } from '../store/hyphaStore';
import ReactMarkdown from 'react-markdown';
import { Menu } from '@headlessui/react';

interface DeploymentResult {
  name: string;
  success: boolean;
  details: {
    [key: string]: any;
  };
  services?: any;
}

interface ModelDeployerProps {
  artifactId?: string;
  version?: string;
  isDisabled?: boolean;
  className?: string;
  onDeploymentComplete?: (services: any) => void;
}

const ModelDeployer: React.FC<ModelDeployerProps> = ({ 
  artifactId, 
  version, 
  isDisabled, 
  className = '',
  onDeploymentComplete 
}) => {
  const { server, isLoggedIn } = useHyphaStore();
  const [deploymentResult, setDeploymentResult] = useState<DeploymentResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  // Add effect to adjust dropdown position
  useEffect(() => {
    if (isOpen && dropdownRef.current && buttonRef.current) {
      const dropdown = dropdownRef.current;
      const button = buttonRef.current;
      const dropdownRect = dropdown.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      
      // Check if dropdown would go outside the right edge of viewport
      const viewportWidth = window.innerWidth;
      const spaceOnRight = viewportWidth - buttonRect.right;
      const spaceOnLeft = buttonRect.left;
      
      // Reset any previous positioning
      dropdown.style.right = '';
      dropdown.style.left = '';
      
      if (spaceOnRight < dropdownRect.width && spaceOnLeft > dropdownRect.width) {
        // Position to the left if there's more space
        dropdown.style.right = '0px';
      } else {
        // Default position to the left edge of the button
        dropdown.style.left = '0px';
      }
    }
  }, [isOpen, deploymentResult]);

  const runDeploy = async () => {
    if (!artifactId || !server) return;

    setIsLoading(true);
    setIsOpen(false);
    
    try {
      const runner = await server.getService('chiron-platform/ray-deployment-manager', {mode: "last", case_conversion: "camel"});
      const result = await runner.deploy(artifactId, version);
      if(result.success) {
        const serviceInfo = await runner.getServiceInfo();
        const services = await server.getService(serviceInfo.id);
        result["services"] = services;
        setDeploymentResult(result);
        setIsOpen(true);
        onDeploymentComplete?.(services);
      } else {
        throw result.error;
      }
      
    } catch (err: any) {
      console.error('Deployment failed:', err);
      setDeploymentResult({
        name: 'Deployment Failed',
        success: false,
        details: err,
      });
      setIsOpen(true);
    } finally {
      setIsLoading(false);
    }
  };

  const getMarkdownContent = () => {
    if (!deploymentResult) return '';

    let content = `# Deployment Results\n\n`;
    content += `**Status**: ${deploymentResult.success ? '✅ Deployed' : '❌ Failed'}\n\n`;
    content += deploymentResult ? JSON.stringify(deploymentResult, null, 2) : "";

    return content;
  };

  return (
    <div className={`relative ${className}`}>
      <div className="flex h-[40px]" ref={buttonRef}>
        <button
          onClick={runDeploy}
          disabled={isDisabled || isLoading || !isLoggedIn}
          className={`inline-flex items-center gap-2 px-4 h-full rounded-l-md font-medium transition-colors
            ${isDisabled || !isLoggedIn
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-300'
            }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
              d="M5 15l7-7 7 7" />
          </svg>
          <span>{!isLoggedIn ? 'Login to Deploy' : 'Deploy'}</span>
        </button>

        <Menu as="div" className="relative h-full">
          <Menu.Button
            onClick={() => deploymentResult && setIsOpen(!isOpen)}
            className={`inline-flex items-center px-2 h-full rounded-r-md font-medium transition-colors border-l
              ${isDisabled || !isLoggedIn
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : isLoading
                  ? 'bg-blue-600 text-white'
                  : deploymentResult
                    ? deploymentResult.success
                      ? 'bg-green-600 text-white hover:bg-green-700'
                      : 'bg-red-600 text-white hover:bg-red-700'
                    : 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-300'
              }`}
            disabled={isDisabled || !isLoggedIn}
          >
            {isLoading ? (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : deploymentResult ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d={deploymentResult.success
                    ? "M5 13l4 4L19 7"
                    : "M6 18L18 6M6 6l12 12"} />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M5 15l7-7 7 7" />
              </svg>
            )}
            {deploymentResult && (
              <svg className="w-5 h-5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </Menu.Button>

          {deploymentResult && isOpen && (
            <div 
              ref={dropdownRef}
              className="absolute mt-2 w-[600px] max-h-[80vh] overflow-y-auto origin-top-right bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none z-50"
            >
              <div className="p-6 relative">
                <button
                  onClick={() => setIsOpen(false)}
                  className="absolute top-2 right-2 text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <ReactMarkdown className="prose prose-sm max-w-none">
                  {getMarkdownContent()}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </Menu>
      </div>
    </div>
  );
};

export default ModelDeployer;