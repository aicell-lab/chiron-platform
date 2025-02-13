import asyncio
import logging
from typing import Optional, Dict, Any

import ray
from hypha_rpc import connect_to_server
import httpx

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ray-deployment-manager")

class RayDeploymentManager:
    def __init__(self, server_url: str, workspace: str = None, token: Optional[str] = None):
        """Initialize the Ray Deployment Manager.
        
        Args:
            server_url: URL of the Hypha server
            workspace: Optional workspace name
            token: Optional authentication token
        """
        self.server_url = server_url
        self.workspace = workspace
        self.token = token
        self.artifact_manager = None
        self.deployments: Dict[str, Any] = {}
        self.deployment_collection_id = "ray-deployments"
        
        # Ensure Ray is initialized
        if not ray.is_initialized():
            ray.init(address="auto")

    async def connect(self):
        """Connect to the Hypha server and get artifact manager service."""
        server = await connect_to_server({
            "server_url": self.server_url,
            "workspace": self.workspace,
            "token": self.token
        })
        self.artifact_manager = await server.get_service("public/artifact-manager")
        logger.info("Connected to Hypha server")

    async def load_deployment_code(self, artifact_id: str, file_path: str = "main.py") -> Optional[Dict[str, Any]]:
        """Load and execute deployment code from an artifact directly in memory.
        
        Args:
            artifact_id: ID of the artifact
            file_path: Path to the file within the artifact (default: main.py)
            
        Returns:
            Dictionary containing the module's globals or None if loading fails
        """
        try:
            # Get download URL for the file
            download_url = await self.artifact_manager.get_file(
                artifact_id=artifact_id,
                file_path=file_path
            )
            
            # Download the file content
            async with httpx.AsyncClient() as client:
                response = await client.get(download_url)
                if response.status_code != 200:
                    logger.error(f"Failed to download deployment file for {artifact_id}: {response.status_code}")
                    return None
                
                code_content = response.text
                
                # Create a unique module name for this deployment
                module_name = f"deployment_{artifact_id.replace('-', '_').replace('/', '_')}"
                
                # Create an in-memory module
                try:
                    # Execute the code in a new module namespace
                    module_globals = {}
                    exec(code_content, module_globals)
                    logger.info(f"Successfully loaded deployment code for {artifact_id}")
                    return module_globals
                except Exception as e:
                    logger.error(f"Error executing deployment code for {artifact_id}: {e}")
                    return None
                
        except Exception as e:
            logger.error(f"Error loading deployment code for {artifact_id}: {e}")
            return None

    async def deploy_artifact(self, artifact_id: str):
        """Deploy a single artifact to Ray Serve.
        
        Args:
            artifact_id: ID of the artifact to deploy
        """
        try:
            # Load the deployment code
            deployment_globals = await self.load_deployment_code(artifact_id)
            if not deployment_globals:
                return

            # Read the manifest to get deployment configuration
            manifest = await self.artifact_manager.read(artifact_id)
            
            # Store deployment information
            self.deployments[artifact_id] = {
                "manifest": manifest,
                "globals": deployment_globals
            }
            
            logger.info(f"Successfully deployed {artifact_id}")
            
        except Exception as e:
            logger.error(f"Error deploying {artifact_id}: {e}")

    async def undeploy_artifact(self, artifact_id: str):
        """Remove a deployment from Ray Serve.
        
        Args:
            artifact_id: ID of the artifact to undeploy
        """
        if artifact_id in self.deployments:
            try:
                # Get deployment info
                deployment_info = self.deployments[artifact_id]
                
                # Call cleanup function if it exists
                if "cleanup" in deployment_info["globals"]:
                    deployment_info["globals"]["cleanup"]()
                
                # Remove deployment info
                del self.deployments[artifact_id]
                logger.info(f"Successfully undeployed {artifact_id}")
                
            except Exception as e:
                logger.error(f"Error undeploying {artifact_id}: {e}")

    async def monitor_deployments(self, poll_interval: int = 30):
        """Monitor the ray-deployments collection for changes and update deployments accordingly.
        
        Args:
            poll_interval: Time between checks for changes (in seconds)
        """
        while True:
            try:
                # Get current list of deployments
                deployments = await self.artifact_manager.list(
                    parent_id=self.deployment_collection_id
                )
                
                current_deployment_ids = {d["id"] for d in deployments}
                existing_deployment_ids = set(self.deployments.keys())
                
                # Deploy new artifacts
                for deployment in deployments:
                    if deployment["id"] not in existing_deployment_ids:
                        await self.deploy_artifact(deployment["id"])
                
                # Undeploy removed artifacts
                for deployment_id in existing_deployment_ids - current_deployment_ids:
                    await self.undeploy_artifact(deployment_id)
                
            except Exception as e:
                logger.error(f"Error in deployment monitor: {e}")
            
            await asyncio.sleep(poll_interval)

    async def list_deployments(self) -> list:
        """List all deployments in the ray-deployments collection.
        
        Returns:
            List of deployments with their manifests and status
        """
        try:
            # Get current list of deployments from artifact manager
            deployments = await self.artifact_manager.list(
                parent_id=self.deployment_collection_id
            )
            
            # Enhance deployment info with current deployment status
            deployment_list = []
            for deployment in deployments:
                deployment_info = {
                    "id": deployment["id"],
                    "manifest": deployment["manifest"],
                    "is_deployed": deployment["id"] in self.deployments,
                }
                if deployment["id"] in self.deployments:
                    deployment_info["deployment"] = {
                        "manifest": self.deployments[deployment["id"]]["manifest"],
                    }
                deployment_list.append(deployment_info)
                
            return deployment_list
            
        except Exception as e:
            logger.error(f"Error listing deployments: {e}")
            raise

async def main():
    """Main function to run the deployment manager."""
    import os
    # Get configuration from environment variables
    server_url = os.getenv("HYPHA_SERVER_URL", "https://hypha.aicell.io")
    workspace = os.getenv("HYPHA_WORKSPACE")
    token = os.getenv("HYPHA_TOKEN")
    
    # Create and start the deployment manager
    manager = RayDeploymentManager(
        server_url=server_url,
        workspace=workspace,
        token=token
    )
    
    await manager.connect()
    
    # Start monitoring deployments
    await manager.monitor_deployments()

if __name__ == "__main__":
    asyncio.run(main()) 