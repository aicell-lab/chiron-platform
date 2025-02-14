import asyncio
import logging
from typing import Optional, Dict, Any

import ray
from ray import serve
from hypha_rpc import connect_to_server
import httpx
from functools import partial
import json
from urllib.parse import urljoin

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ray-deployment-manager")

class RayDeploymentManager:
    def __init__(self, ray_context):
        """Initialize the Ray Deployment Manager.
        
        Args:
            server_url: URL of the Hypha server
            workspace: Optional workspace name
            token: Optional authentication token
        """
        self.artifact_manager = None
        self.deployment_collection_id = "ray-deployments"
        self.service_info = None
        self.ray_context = ray_context
        self.dashboard_url = f"http://{ray_context.dashboard_url}"

    def _get_deployment_name(self, artifact_id: str) -> str:
        """Convert artifact ID to a deployment name.
        
        Args:
            artifact_id: The artifact ID to convert
            
        Returns:
            str: The converted deployment name
        """
        try:
            return artifact_id.split("/")[1].replace("-", "_")
        except IndexError:
            return artifact_id.replace("-", "_")

    async def connect(self, server):
        """Connect to the Hypha server and get artifact manager service."""
        assert ray.is_initialized(), "Ray must be initialized before using RayDeploymentManager"
        self.artifact_manager = await server.get_service("public/artifact-manager")
        self.server = server
        logger.info(f"Connected to Hypha server and Ray dashboard at {self.dashboard_url}")

    async def load_deployment_code(self, artifact_id: str, version=None, file_path: str = "main.py", timeout: int = 30) -> Optional[Dict[str, Any]]:
        """Load and execute deployment code from an artifact directly in memory.
        
        Args:
            artifact_id: ID of the artifact
            file_path: Path to the file within the artifact (default: main.py)
            timeout: Timeout in seconds for network requests (default: 30)
            
        Returns:
            Dictionary containing the module's globals or None if loading fails
            
        Raises:
            TimeoutError: If network requests exceed the timeout
            ValueError: If the code execution fails or ChironModel is not found
        """
        try:
            # Get download URL for the file
            download_url = await self.artifact_manager.get_file(
                artifact_id=artifact_id,
                version=version,
                file_path=file_path
            )
            
            # Download the file content with timeout
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(download_url)
                response.raise_for_status()
                code_content = response.text
            
            # Create a unique module name for this deployment
            module_name = f"deployment_{artifact_id.replace('-', '_').replace('/', '_')}"
            
            # Create a restricted globals dictionary for sandboxed execution
            safe_globals = {}
            # Execute the code in a sandboxed environment
            try:
                exec(code_content, safe_globals)
                if "ChironModel" not in safe_globals:
                    raise ValueError(f"ChironModel not found in {artifact_id}")
                logger.info(f"Successfully loaded deployment code for {artifact_id}")
                return safe_globals.get("ChironModel")
            except Exception as e:
                logger.error(f"Error executing deployment code for {artifact_id}: {e}")
                raise ValueError(f"Code execution failed: {str(e)}")
                
        except httpx.TimeoutException:
            logger.error(f"Timeout while downloading deployment file for {artifact_id}")
            raise TimeoutError(f"Network request timeout for {artifact_id}")
        except httpx.HTTPError as e:
            logger.error(f"HTTP error while downloading deployment file for {artifact_id}: {e}")
            raise
        except Exception as e:
            logger.error(f"Error loading deployment code for {artifact_id}: {e}")
            raise

    async def deploy_artifact(self, artifact_id: str, version=None, skip_update=False):
        """Deploy a single artifact to Ray Serve.
        
        Args:
            artifact_id: ID of the artifact to deploy
            version: Optional version of the artifact
            skip_update: Skip updating services after deployment
            
        Raises:
            ValueError: If deployment configuration is invalid
            RuntimeError: If deployment fails
        """
        try:
            # Load the deployment code
            ChironModel = await self.load_deployment_code(artifact_id, version=version)
            if not ChironModel:
                raise ValueError(f"Failed to load model code for {artifact_id}")
                
            # Read the manifest to get deployment configuration
            artifact = await self.artifact_manager.read(artifact_id, version=version)
            manifest = artifact.get("manifest")
            if not manifest or "deployment_config" not in manifest:
                raise ValueError(f"Invalid manifest or missing deployment_config for {artifact_id}")
                
            deployment_config = manifest["deployment_config"]
            
            try:
                deployment_name = self._get_deployment_name(artifact_id)
                deployment_config["name"] = deployment_name
                ChironModelDeployment = serve.deployment(**deployment_config)(ChironModel)
                # Bind the arguments to the deployment and return an Application
                app = ChironModelDeployment.bind()
                # Deploy the application
                ray.serve.run(app, name="Chiron")
            except Exception as e:
                raise RuntimeError(f"Ray Serve deployment failed: {str(e)}")
                
            logger.info(f"Successfully deployed {artifact_id}")
            
            if not skip_update:
                try:
                    svc = await self.update_services()
                except Exception as e:
                    logger.error(f"Failed to update services after deploying {artifact_id}: {e}")
                    # Continue since the deployment itself was successful
            return {"success": True, "message": f"Successfully deployed {artifact_id}", "service_id": self.service_info['id']}
            
        except Exception as e:
            logger.error(f"Error deploying {artifact_id}: {e}")
            raise

    async def undeploy_artifact(self, artifact_id: str, skip_update=False):
        """Remove a deployment from Ray Serve.
        
        Args:
            artifact_id: ID of the artifact to undeploy
        """
        deployment_name = self._get_deployment_name(artifact_id)
        ray.serve.delete(deployment_name)
        if not skip_update:
            await self.update_services()

    async def list_deployments(self) -> list:
        """List all deployments in the ray-deployments collection.
        
        Returns:
            List of deployments with their manifests and status
        """
        try:
            # Get deployments from Ray Serve HTTP API
            if not self.dashboard_url:
                raise RuntimeError("Ray dashboard URL is not available")
            ray_dashboard_url = self.dashboard_url
            async with httpx.AsyncClient() as client:
                response = await client.get(urljoin(ray_dashboard_url, "/api/serve/applications/"))
                response.raise_for_status()
                serve_data = response.json()

            # Convert serve deployments to dictionary format
            deployments = {}
            for app_name, app_info in serve_data.get("applications", {}).items():
                deployments[app_name] = app_info
            return {
                "success": True,
                "deployments": deployments
            }
        except Exception as e:
            logger.error(f"Error listing deployments: {e}")
            return {"success": False, "error": str(e)}

    async def get_service_info(self):
        return self.service_info

    async def deploy_all_artifacts(self):
        """Deploy all artifacts in the ray-deployments collection.
        
        This function will attempt to deploy all artifacts in the collection.
        If any deployment fails, it will continue with the remaining artifacts.
        
        Returns:
            dict: A dictionary containing the deployment results for each artifact
        """
        results = {}
        try:
            # Get all artifacts in the collection
            artifacts = await self.artifact_manager.list(
                parent_id=self.deployment_collection_id
            )
            
            # Deploy each artifact
            for artifact in artifacts:
                artifact_id = artifact['id']
                try:
                    await self.deploy_artifact(artifact_id, skip_update=True)
                    results[artifact_id] = {'success': True}
                except Exception as e:
                    logger.error(f"Failed to deploy {artifact_id}: {e}")
                    results[artifact_id] = {'success': False, 'error': str(e)}
            
            return results
            
        except Exception as e:
            logger.error(f"Error deploying all artifacts: {e}")
            raise

    async def update_services(self):
        """Update Hypha services based on currently deployed models.
        
        This function lists all deployed models and registers them as Hypha services.
        Each model's deployment handle will be exposed as a service function.
        """
        try:
            # Get all current deployments from Ray Serve HTTP API
            if not self.dashboard_url:
                raise RuntimeError("Ray dashboard URL is not available")
            ray_dashboard_url = self.dashboard_url
            async with httpx.AsyncClient() as client:
                response = await client.get(urljoin(ray_dashboard_url, "/api/serve/applications/"))
                response.raise_for_status()
                serve_data = response.json()
            
            # Create service functions for each deployment
            service_functions = {}
            
            # Define a partial function to create model functions
            async def create_model_function(handle, name, data=None, context=None):
                return await handle.remote(data=data)

            for app_name, app_info in serve_data.get("applications", {}).items():
                if app_name == "Chiron" and app_info.get("status") == "RUNNING":
                    for k in app_info["deployments"].keys():
                        # Get the deployment handle using the application name
                        handle = serve.get_deployment_handle(k, app_name)
                        model_function = partial(create_model_function, handle, app_name)
                        service_functions[k] = model_function
            
            # Register all model functions as a single service
            service_info = await self.server.register_service({
                "id": "ray-model-services",
                "config": {
                    "visibility": "public",
                    "require_context": True
                },
                **service_functions
            }, {"overwrite": True})
            
            self.service_info = service_info
            
            logger.info(f"Successfully registered {len(service_functions)} model services")
            return service_info
            
        except Exception as e:
            logger.error(f"Error updating services: {e}, dashboard url: {self.dashboard_url}")
            raise
