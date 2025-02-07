import React from 'react';

const About: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
      <h1 className="text-4xl font-bold mb-8 text-center text-gray-900">About Tabula Platform</h1>
      
      <section className="mb-12 bg-white rounded-lg shadow-sm p-8">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Our Mission</h2>
        <p className="text-gray-600 leading-relaxed">
          Tabula Platform is a cutting-edge foundation model for single-cell transcriptomics that prioritizes privacy and ethical constraints through federated learning. Our platform is designed to handle large-scale single-cell data while preserving data privacy and facilitating robust downstream analysis tasks.
        </p>
      </section>

      <section className="mb-12 bg-white rounded-lg shadow-sm p-8">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Key Features</h2>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            'Privacy-preserving federated learning',
            'Tabular structure-aware modeling',
            'Multi-institution collaboration support',
            'Advanced cell type annotation',
            'Gene imputation capabilities',
            'Multi-batch integration tools',
            'Multi-omics integration support',
            'Secure data handling'
          ].map((item, index) => (
            <li key={index} className="flex items-start space-x-3">
              <svg className="h-6 w-6 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-gray-600">{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-12 bg-white rounded-lg shadow-sm p-8">
        <h2 className="text-2xl font-semibold mb-6 text-gray-800">Get Involved</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <a href="/#/upload" 
             target="_blank" 
             rel="noopener noreferrer"
             className="flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition duration-150 ease-in-out">
            Join Federation
          </a>
          <a href="#community-partners" 
             className="flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition duration-150 ease-in-out">
            Become a Partner
          </a>
        </div>
      </section>

      <section className="mb-12 bg-white rounded-lg shadow-sm p-8">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Our Approach</h2>
        <p className="text-gray-600 leading-relaxed mb-6">
          Tabula Platform revolutionizes single-cell data analysis by combining federated learning with innovative modeling approaches. Our platform explicitly accounts for the tabular structure of single-cell data while enabling secure, privacy-preserving collaboration across institutions.
        </p>
        <p className="text-gray-600 leading-relaxed">
          Through our federated learning approach, we enable institutions to contribute to model training without sharing sensitive data, while still benefiting from the collective knowledge of the entire network.
        </p>
      </section>
    </div>
  );
};

export default About; 