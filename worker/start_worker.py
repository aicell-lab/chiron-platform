import asyncio
import logging
import os
import sys
from typing import Optional, Dict, Any

import ray
from hypha_rpc import connect_to_server
from ray_deployment_manager import RayDeploymentManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("worker")
logger.setLevel(logging.INFO)

class Worker:
    def __init__(self):
        self.manager = None
        self.running = False
        self.client = None

    async def deploy(self, artifact_id: str, version: str=None, context: Optional[Dict] = None) -> Dict[str, Any]:
        """Deploy a single artifact."""
        try:
            return await self.manager.deploy_artifact(artifact_id, version=version)
        except Exception as e:
            logger.error(f"Error deploying {artifact_id}: {e}")
            return {"success": False, "error": str(e)}

    async def undeploy(self, artifact_id: str, context: Optional[Dict] = None) -> Dict[str, Any]:
        """Undeploy a single artifact."""
        try:
            await self.manager.undeploy_artifact(artifact_id)
            return {"success": True, "message": f"Successfully undeployed {artifact_id}"}
        except Exception as e:
            logger.error(f"Error undeploying {artifact_id}: {e}")
            return {"success": False, "error": str(e)}

    async def list_deployments(self, context: Optional[Dict] = None) -> Dict[str, Any]:
        """List all current deployments."""
        try:
            # Get deployments from Ray Serve
            serve_deployments = await self.manager.list_deployments()
            return serve_deployments
        except Exception as e:
            logger.error(f"Error listing deployments: {e}")
            return {"success": False, "error": str(e)}

    async def ping(self, context: Optional[Dict] = None) -> str:
        """Simple health check endpoint."""
        return "pong"
    
    async def get_service_info(self, context: Optional[Dict] = None) -> Dict[str, Any]:
        """Get information about the service."""
        return await self.manager.get_service_info()

    async def register_service(self):
        """Register the Ray deployment manager as a Hypha service."""
        try:
            # Get configuration from environment
            server_url = os.getenv("HYPHA_SERVER_URL", "https://hypha.aicell.io")
            workspace = os.getenv("HYPHA_WORKSPACE")
            token = os.getenv("HYPHA_TOKEN")
            service_id = os.getenv("HYPHA_SERVICE_ID", "ray-deployment-manager")

            if not workspace:
                raise ValueError("HYPHA_WORKSPACE environment variable must be set")
            if not token:
                raise ValueError("HYPHA_TOKEN environment variable must be set")

            # Initialize Ray
            ray_address = os.getenv("RAY_ADDRESS")
            ray_context=ray.init(address=ray_address)

            # Initialize the deployment manager
            self.manager = RayDeploymentManager(ray_context)

            # Connect to Hypha server
            self.client = await connect_to_server({
                "server_url": server_url,
                "workspace": workspace,
                "token": token,
                "method_timeout": 600,
            })

            # Connect the manager to Hypha
            await self.manager.connect(self.client)
            logger.info(f"Connected to Hypha server at {server_url}")

            # Register the service
            service_info = await self.client.register_service({
                "id": service_id,
                "config": {
                    "visibility": "public",
                    "require_context": True,
                },
                # Exposed functions
                "ping": self.ping,
                "deploy": self.deploy,
                "undeploy": self.undeploy,
                "list_deployments": self.list_deployments,
                "get_service_info": self.get_service_info,
            })

            logger.info(f"Service registered with ID: {service_info['id']}")

            # Keep the service running
            self.running = True
            while self.running:
                await asyncio.sleep(1)

        except Exception as e:
            logger.error(f"Failed to start worker: {e}")
            raise
        finally:
            logger.info("Worker shutdown complete")

async def main():
    """Main entry point for the worker."""
    worker = Worker()
    try:
        await worker.register_service()
    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt, shutting down...")
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main()) 