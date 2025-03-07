import asyncio
import logging
import os
import sys
import base64
import io
from typing import Optional, Dict, Any, List

import ray
from hypha_rpc import connect_to_server
from ray_deployment_manager import RayDeploymentManager
from file_manager import FileManager

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
        self.file_manager = FileManager()

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

    # File Management Functions
    async def create_dataset(self, dataset_id: str, manifest_data: Dict[str, Any], context: Optional[Dict] = None) -> Dict[str, Any]:
        """Create a new dataset."""
        try:
            return self.file_manager.create_dataset(dataset_id, manifest_data)
        except Exception as e:
            logger.error(f"Error creating dataset {dataset_id}: {e}")
            return {"success": False, "error": str(e)}

    async def get_dataset(self, dataset_id: str, context: Optional[Dict] = None) -> Dict[str, Any]:
        """Get information about a dataset."""
        try:
            return self.file_manager.get_dataset(dataset_id)
        except Exception as e:
            logger.error(f"Error getting dataset {dataset_id}: {e}")
            return {"success": False, "error": str(e)}

    async def update_dataset(self, dataset_id: str, manifest_data: Dict[str, Any], context: Optional[Dict] = None) -> Dict[str, Any]:
        """Update a dataset's metadata."""
        try:
            return self.file_manager.update_dataset(dataset_id, manifest_data)
        except Exception as e:
            logger.error(f"Error updating dataset {dataset_id}: {e}")
            return {"success": False, "error": str(e)}

    async def delete_dataset(self, dataset_id: str, context: Optional[Dict] = None) -> Dict[str, Any]:
        """Delete a dataset."""
        try:
            return self.file_manager.delete_dataset(dataset_id)
        except Exception as e:
            logger.error(f"Error deleting dataset {dataset_id}: {e}")
            return {"success": False, "error": str(e)}

    async def list_datasets(self, context: Optional[Dict] = None) -> List[Dict[str, Any]]:
        """List all datasets."""
        try:
            return self.file_manager.list_datasets()
        except Exception as e:
            logger.error(f"Error listing datasets: {e}")
            return {"success": False, "error": str(e)}

    async def upload_file(self, dataset_id: str, file_path: str, file_content_base64: str, context: Optional[Dict] = None) -> Dict[str, Any]:
        """Upload a file to a dataset."""
        try:
            # Decode base64 content
            file_content_bytes = base64.b64decode(file_content_base64)
            file_content_io = io.BytesIO(file_content_bytes)
            
            return self.file_manager.upload_file(dataset_id, file_path, file_content_io)
        except Exception as e:
            logger.error(f"Error uploading file to dataset {dataset_id}: {e}")
            return {"success": False, "error": str(e)}

    async def delete_file(self, dataset_id: str, file_path: str, context: Optional[Dict] = None) -> Dict[str, Any]:
        """Delete a file from a dataset."""
        try:
            return self.file_manager.delete_file(dataset_id, file_path)
        except Exception as e:
            logger.error(f"Error deleting file from dataset {dataset_id}: {e}")
            return {"success": False, "error": str(e)}

    async def list_files(self, dataset_id: str, directory: Optional[str] = None, context: Optional[Dict] = None) -> List[Dict[str, Any]]:
        """List files in a dataset."""
        try:
            return self.file_manager.list_files(dataset_id, directory)
        except Exception as e:
            logger.error(f"Error listing files in dataset {dataset_id}: {e}")
            return {"success": False, "error": str(e)}

    async def register_service(self):
        """Register the Ray deployment manager as a Hypha service."""
        # Get configuration from environment
        server_url = os.getenv("HYPHA_SERVER_URL", "https://hypha.aicell.io")
        workspace = os.getenv("HYPHA_WORKSPACE")
        token = os.getenv("HYPHA_TOKEN")
        service_id = os.getenv("HYPHA_SERVICE_ID", "ray-deployment-manager")
        file_service_id = os.getenv("HYPHA_FILE_SERVICE_ID", "dataset-manager")

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
            "ping_interval": None, # Disable pinging to avoid disconnecting
        })

        # Connect the manager to Hypha
        await self.manager.connect(self.client)
        logger.info(f"Connected to Hypha server at {server_url}")

        # Register the Ray deployment manager service
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
        logger.info(f"Ray deployment manager service registered with ID: {service_info['id']}")

        # Register the file management service
        file_service_info = await self.client.register_service({
            "id": file_service_id,
            "config": {
                "visibility": "public",
                "require_context": True,
                "description": "Dataset management service for storing and retrieving datasets",
            },
            # Exposed functions
            "ping": self.ping,
            "create_dataset": self.create_dataset,
            "get_dataset": self.get_dataset,
            "update_dataset": self.update_dataset,
            "delete_dataset": self.delete_dataset,
            "list_datasets": self.list_datasets,
            "upload_file": self.upload_file,
            "delete_file": self.delete_file,
            "list_files": self.list_files,
        })
        logger.info(f"Dataset manager service registered with ID: {file_service_info['id']}")

        await self.client.serve()


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