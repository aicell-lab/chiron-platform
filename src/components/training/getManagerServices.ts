/**
 * Fetches all manager service IDs from a given workspace.
 * 
 * @param workspace - The Hypha workspace name
 * @returns A promise that resolves to an array of service IDs (strings)
 * @throws Error if the fetch fails or returns an unexpected format
 */
export async function getManagerServices(workspace: string): Promise<string[]> {
  if (!workspace.trim()) {
    throw new Error('Workspace name cannot be empty');
  }

  const url = `https://hypha.aicell.io/${workspace}/services/chiron-manager`;
  
  let response;
  let data;

  try {
    response = await fetch(url);
    data = await response.json();
  } catch (fetchError) {
    throw new Error(
      `Failed to fetch manager service information. The workspace may not exist or the service may not be available. Error: ${
        fetchError instanceof Error ? fetchError.message : 'Network error'
      }`
    );
  }

  // Handle single service response
  if (data.id) {
    return [data.id];
  }

  // Handle error response
  if (!data.success && data.detail) {
    const detail = data.detail;

    // Check if it's a "multiple services" error
    if (detail.includes('Multiple services found')) {
      // Extract service IDs from the error message
      // Pattern: b'services:public|bioengine-apps:ws-user-github|49943582/ID:chiron-manager@*'
      // We need to extract: ws-user-github|49943582/ID:chiron-manager
      const servicePattern = /b'services:[^:]+:([^@]+):chiron-manager@\*'/g;
      const matches = [...detail.matchAll(servicePattern)];
      const serviceIds = matches.map((match: RegExpMatchArray) => `${match[1]}:chiron-manager`);

      if (serviceIds.length > 0) {
        // Remove duplicates by converting to Set and back to array
        return Array.from(new Set(serviceIds));
      }
    }

    // Check if it's a "service not found" error
    if (detail.includes('Service not found')) {
      throw new Error(
        'Manager service not found in workspace. Please ensure the chiron-manager service is running in this workspace.'
      );
    }

    // Unknown error format
    throw new Error(`Failed to fetch manager service: ${detail}`);
  }

  // Unexpected response format
  throw new Error('Unexpected response format from service endpoint');
}
