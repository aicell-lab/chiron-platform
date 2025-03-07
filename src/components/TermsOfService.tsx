import React from 'react';
import ReactMarkdown from 'react-markdown';

const TermsOfService: React.FC = () => {
  const termsContent = `
# Chiron Platform Terms of Service

## 1. Introduction

Welcome to the Chiron Platform. By accessing or using our services, you agree to be bound by these Terms of Service.

## 2. Use of Service

The Chiron Platform provides tools for federated learning and privacy-preserving data processing in single-cell transcriptomics. Users must comply with all applicable laws and regulations when using our services.

## 3. Privacy and Data Protection

### 3.1 Data Privacy
We are committed to protecting your data privacy. The platform is designed with privacy-preserving technologies to ensure sensitive data remains secure.

### 3.2 Federated Learning
Our federated learning approach allows models to be trained across multiple institutions without sharing raw data, preserving privacy and ethical constraints.

## 4. User Responsibilities

Users are responsible for:
- Ensuring they have proper authorization to use any data processed through our platform
- Maintaining the confidentiality of their account credentials
- Using the platform in accordance with ethical guidelines for biomedical research

## 5. Intellectual Property

### 5.1 Platform Content
The Chiron Platform, including its software, design, and documentation, is protected by intellectual property rights.

### 5.2 User Content
Users retain rights to their data while granting limited licenses necessary for platform operation.

## 6. Limitation of Liability

The Chiron Platform is provided "as is" without warranties of any kind, either express or implied.

## 7. Changes to Terms

We may update these Terms of Service from time to time. Continued use of the platform after changes constitutes acceptance of the revised terms.

## 8. Contact Information

For questions about these Terms of Service, please contact us at [contact@chironplatform.org](mailto:contact@chironplatform.org).

Last Updated: ${new Date().toLocaleDateString()}
`;

  return (
    <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
      <h1 className="text-4xl font-bold mb-8 text-center text-gray-900">Terms of Service</h1>
      <div className="prose prose-blue max-w-none bg-white rounded-lg shadow-sm p-8">
        <ReactMarkdown>{termsContent}</ReactMarkdown>
      </div>
    </div>
  );
};

export default TermsOfService; 