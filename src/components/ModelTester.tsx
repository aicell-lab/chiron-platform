import React, { useState, useRef, useEffect } from 'react';
import { useHyphaStore } from '../store/hyphaStore';
import ReactMarkdown from 'react-markdown';
import { Menu } from '@headlessui/react';

interface TestResult {
  name: string;
  success: boolean;
  details: {
    [key: string]: any;
  };
}

interface ModelTesterProps {
  artifactId?: string;
  version?: string;
  isDisabled?: boolean;
  className?: string;
}

const ModelTester: React.FC<ModelTesterProps> = ({ artifactId, version, isDisabled, className = '' }) => {
  const { server, isLoggedIn } = useHyphaStore();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
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
  }, [isOpen, testResult]);

  const runTest = async () => {
    if (!artifactId || !server) return;

    setIsLoading(true);
    setIsOpen(false);
    
    try {
      const runner = await server.getService('chiron-platform/ray-deployment-manager', {mode: "last", case_conversion: "camel"});
      const serviceInfo = await runner.getServiceInfo();
      if (!serviceInfo) {
        throw new Error('No deployed model found. Please deploy the model first.');
      }
      const services = await server.getService(serviceInfo.id);
      const service = services[artifactId.split("/")[1].replaceAll("-", "_")]
      const result = await service();
      setTestResult({
        name: 'Test Passed',
        success: true,
        details: result,
      });
      setIsOpen(true);
      
    } catch (err: any) {
      console.error('Test run failed:', err);
      setTestResult({
        name: 'Test Failed',
        success: false,
        details: err,
      });
      setIsOpen(true);
    } finally {
      setIsLoading(false);
    }
  };

  const getMarkdownContent = () => {
    if (!testResult) return '';

    let content = `# Test Results\n\n`;
    content += `**Status**: ${testResult.success ? '✅ Passed' : '❌ Failed'}\n\n`;
    content += testResult.details?JSON.stringify(testResult.details, null, 2): "";

    return content;
  };

  return (
    <div className={`relative ${className}`}>
      <div className="flex h-[40px]" ref={buttonRef}>
        <button
          onClick={runTest}
          disabled={isDisabled || isLoading || !isLoggedIn}
          className={`inline-flex items-center gap-2 px-4 h-full rounded-l-md font-medium transition-colors
            ${isDisabled || !isLoggedIn
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-300'
            }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{!isLoggedIn ? 'Login to Test' : 'Test Model'}</span>
        </button>

        <Menu as="div" className="relative h-full">
          <Menu.Button
            onClick={() => testResult && setIsOpen(!isOpen)}
            className={`inline-flex items-center px-2 h-full rounded-r-md font-medium transition-colors border-l
              ${isDisabled || !isLoggedIn
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : isLoading
                  ? 'bg-blue-600 text-white'
                  : testResult
                    ? testResult.success
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
            ) : testResult ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d={testResult.success
                    ? "M5 13l4 4L19 7"
                    : "M6 18L18 6M6 6l12 12"} />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              </svg>
            )}
            {testResult && (
              <svg className="w-5 h-5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </Menu.Button>

          {testResult && isOpen && (
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

export default ModelTester;