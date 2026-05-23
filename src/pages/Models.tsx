import React from 'react';
import { BiCube } from 'react-icons/bi';

const Models: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center pt-16">
      <div className="bg-gradient-to-r from-blue-100 to-purple-100 p-8 rounded-full mb-8 shadow-inner">
        <BiCube className="text-blue-500 w-24 h-24" />
      </div>
      <h1 className="text-4xl font-bold text-gray-800 mb-6 bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-purple-600">
        Models Coming Soon
      </h1>
      <p className="text-xl text-gray-600 max-w-2xl leading-relaxed">
        We are actively working on integrating foundation models into the Chiron Platform. 
        Soon, you will be able to browse, test, and deploy single-cell models directly from here.
      </p>
    </div>
  );
};

export default Models;
