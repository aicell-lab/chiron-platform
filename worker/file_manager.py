import os
import yaml
import shutil
import logging
import datetime
from typing import Dict, List, Optional, Any, BinaryIO
from pathlib import Path

from dataset_schema import DatasetManifest, Badge

logger = logging.getLogger("file_manager")

class FileManager:
    """Manages datasets and files in the worker container."""
    
    def __init__(self, base_dir: str = "/app/datasets"):
        """Initialize the file manager with the base directory for datasets.
        
        Args:
            base_dir: Base directory where datasets are stored
        """
        self.base_dir = Path(base_dir)
        # Create the base directory if it doesn't exist
        os.makedirs(self.base_dir, exist_ok=True)
        logger.info(f"FileManager initialized with base directory: {self.base_dir}")
    
    def _get_dataset_path(self, dataset_id: str) -> Path:
        """Get the path to a dataset directory.
        
        Args:
            dataset_id: ID of the dataset
            
        Returns:
            Path to the dataset directory
        """
        # Sanitize dataset_id to prevent directory traversal
        safe_id = dataset_id.replace('..', '').replace('/', '_').replace('\\', '_')
        return self.base_dir / safe_id
    
    def _get_manifest_path(self, dataset_id: str) -> Path:
        """Get the path to a dataset's manifest file.
        
        Args:
            dataset_id: ID of the dataset
            
        Returns:
            Path to the manifest file
        """
        return self._get_dataset_path(dataset_id) / "manifest.yaml"
    
    def _calculate_directory_size(self, directory: Path) -> int:
        """Calculate the total size of files in a directory.
        
        Args:
            directory: Directory to calculate size for
            
        Returns:
            Total size in bytes
        """
        total_size = 0
        for dirpath, _, filenames in os.walk(directory):
            for filename in filenames:
                file_path = os.path.join(dirpath, filename)
                if os.path.isfile(file_path):
                    total_size += os.path.getsize(file_path)
        return total_size
    
    def _count_files(self, directory: Path) -> int:
        """Count the number of files in a directory.
        
        Args:
            directory: Directory to count files in
            
        Returns:
            Number of files
        """
        count = 0
        for dirpath, _, filenames in os.walk(directory):
            count += len(filenames)
        return count
    
    def create_dataset(self, dataset_id: str, manifest_data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new dataset with the given ID and manifest data.
        
        Args:
            dataset_id: ID for the new dataset
            manifest_data: Data for the manifest file
            
        Returns:
            Created manifest data
        """
        dataset_path = self._get_dataset_path(dataset_id)
        manifest_path = self._get_manifest_path(dataset_id)
        
        # Check if dataset already exists
        if dataset_path.exists():
            raise ValueError(f"Dataset '{dataset_id}' already exists")
        
        # Create dataset directory
        os.makedirs(dataset_path, exist_ok=True)
        
        # Add timestamps
        now = datetime.datetime.now().isoformat()
        manifest_data["created_at"] = now
        manifest_data["updated_at"] = now
        manifest_data["file_count"] = 0
        manifest_data["size_bytes"] = 0
        
        # Validate manifest data
        manifest = DatasetManifest(**manifest_data)
        
        # Write manifest file
        with open(manifest_path, 'w') as f:
            yaml.dump(manifest.dict(), f)
        
        logger.info(f"Created dataset: {dataset_id}")
        return manifest.dict()
    
    def get_dataset(self, dataset_id: str) -> Dict[str, Any]:
        """Get information about a dataset.
        
        Args:
            dataset_id: ID of the dataset
            
        Returns:
            Dataset manifest data
        """
        manifest_path = self._get_manifest_path(dataset_id)
        
        if not manifest_path.exists():
            raise ValueError(f"Dataset '{dataset_id}' not found")
        
        with open(manifest_path, 'r') as f:
            manifest_data = yaml.safe_load(f)
        
        # Update file count and size
        dataset_path = self._get_dataset_path(dataset_id)
        manifest_data["file_count"] = self._count_files(dataset_path) - 1  # Exclude manifest.yaml
        manifest_data["size_bytes"] = self._calculate_directory_size(dataset_path)
        
        return manifest_data
    
    def update_dataset(self, dataset_id: str, manifest_data: Dict[str, Any]) -> Dict[str, Any]:
        """Update a dataset's manifest data.
        
        Args:
            dataset_id: ID of the dataset
            manifest_data: New manifest data
            
        Returns:
            Updated manifest data
        """
        manifest_path = self._get_manifest_path(dataset_id)
        
        if not manifest_path.exists():
            raise ValueError(f"Dataset '{dataset_id}' not found")
        
        # Read existing manifest
        with open(manifest_path, 'r') as f:
            existing_data = yaml.safe_load(f)
        
        # Update with new data
        existing_data.update(manifest_data)
        existing_data["updated_at"] = datetime.datetime.now().isoformat()
        
        # Validate updated manifest
        manifest = DatasetManifest(**existing_data)
        
        # Write updated manifest
        with open(manifest_path, 'w') as f:
            yaml.dump(manifest.dict(), f)
        
        logger.info(f"Updated dataset: {dataset_id}")
        return manifest.dict()
    
    def delete_dataset(self, dataset_id: str) -> Dict[str, Any]:
        """Delete a dataset.
        
        Args:
            dataset_id: ID of the dataset
            
        Returns:
            Status information
        """
        dataset_path = self._get_dataset_path(dataset_id)
        
        if not dataset_path.exists():
            raise ValueError(f"Dataset '{dataset_id}' not found")
        
        # Get manifest data before deletion for the response
        try:
            manifest_data = self.get_dataset(dataset_id)
        except Exception:
            manifest_data = {"id": dataset_id}
        
        # Delete the dataset directory
        shutil.rmtree(dataset_path)
        
        logger.info(f"Deleted dataset: {dataset_id}")
        return {
            "success": True,
            "message": f"Dataset '{dataset_id}' deleted successfully",
            "dataset": manifest_data
        }
    
    def list_datasets(self) -> List[Dict[str, Any]]:
        """List all datasets.
        
        Returns:
            List of dataset information
        """
        datasets = []
        
        for item in self.base_dir.iterdir():
            if item.is_dir():
                dataset_id = item.name
                manifest_path = item / "manifest.yaml"
                
                if manifest_path.exists():
                    try:
                        datasets.append(self.get_dataset(dataset_id))
                    except Exception as e:
                        logger.warning(f"Error reading manifest for dataset '{dataset_id}': {e}")
        
        return datasets
    
    def upload_file(self, dataset_id: str, file_path: str, file_content: BinaryIO) -> Dict[str, Any]:
        """Upload a file to a dataset.
        
        Args:
            dataset_id: ID of the dataset
            file_path: Path where the file should be stored (relative to dataset root)
            file_content: File content as bytes
            
        Returns:
            Status information
        """
        dataset_path = self._get_dataset_path(dataset_id)
        
        if not dataset_path.exists():
            raise ValueError(f"Dataset '{dataset_id}' not found")
        
        # Sanitize file path to prevent directory traversal
        safe_path = file_path.replace('..', '').lstrip('/')
        full_path = dataset_path / safe_path
        
        # Create parent directories if they don't exist
        os.makedirs(full_path.parent, exist_ok=True)
        
        # Write the file
        with open(full_path, 'wb') as f:
            shutil.copyfileobj(file_content, f)
        
        # Update the manifest's updated_at timestamp
        try:
            manifest_path = self._get_manifest_path(dataset_id)
            with open(manifest_path, 'r') as f:
                manifest_data = yaml.safe_load(f)
            
            manifest_data["updated_at"] = datetime.datetime.now().isoformat()
            
            with open(manifest_path, 'w') as f:
                yaml.dump(manifest_data, f)
        except Exception as e:
            logger.warning(f"Error updating manifest for dataset '{dataset_id}': {e}")
        
        logger.info(f"Uploaded file to dataset '{dataset_id}': {safe_path}")
        return {
            "success": True,
            "message": f"File '{safe_path}' uploaded successfully to dataset '{dataset_id}'",
            "dataset_id": dataset_id,
            "file_path": safe_path,
            "file_size": os.path.getsize(full_path)
        }
    
    def delete_file(self, dataset_id: str, file_path: str) -> Dict[str, Any]:
        """Delete a file from a dataset.
        
        Args:
            dataset_id: ID of the dataset
            file_path: Path to the file (relative to dataset root)
            
        Returns:
            Status information
        """
        dataset_path = self._get_dataset_path(dataset_id)
        
        if not dataset_path.exists():
            raise ValueError(f"Dataset '{dataset_id}' not found")
        
        # Sanitize file path to prevent directory traversal
        safe_path = file_path.replace('..', '').lstrip('/')
        full_path = dataset_path / safe_path
        
        if not full_path.exists():
            raise ValueError(f"File '{file_path}' not found in dataset '{dataset_id}'")
        
        # Don't allow deleting the manifest file
        if safe_path == "manifest.yaml":
            raise ValueError("Cannot delete manifest.yaml file")
        
        # Delete the file
        os.remove(full_path)
        
        # Update the manifest's updated_at timestamp
        try:
            manifest_path = self._get_manifest_path(dataset_id)
            with open(manifest_path, 'r') as f:
                manifest_data = yaml.safe_load(f)
            
            manifest_data["updated_at"] = datetime.datetime.now().isoformat()
            
            with open(manifest_path, 'w') as f:
                yaml.dump(manifest_data, f)
        except Exception as e:
            logger.warning(f"Error updating manifest for dataset '{dataset_id}': {e}")
        
        logger.info(f"Deleted file from dataset '{dataset_id}': {safe_path}")
        return {
            "success": True,
            "message": f"File '{safe_path}' deleted successfully from dataset '{dataset_id}'",
            "dataset_id": dataset_id,
            "file_path": safe_path
        }
    
    def list_files(self, dataset_id: str, directory: Optional[str] = None) -> List[Dict[str, Any]]:
        """List files in a dataset.
        
        Args:
            dataset_id: ID of the dataset
            directory: Directory to list files from (relative to dataset root)
            
        Returns:
            List of file information
        """
        dataset_path = self._get_dataset_path(dataset_id)
        
        if not dataset_path.exists():
            raise ValueError(f"Dataset '{dataset_id}' not found")
        
        # Sanitize directory path to prevent directory traversal
        if directory:
            safe_dir = directory.replace('..', '').lstrip('/')
            list_path = dataset_path / safe_dir
        else:
            safe_dir = ""
            list_path = dataset_path
        
        if not list_path.exists() or not list_path.is_dir():
            raise ValueError(f"Directory '{directory}' not found in dataset '{dataset_id}'")
        
        files = []
        
        for item in list_path.iterdir():
            relative_path = str(item.relative_to(dataset_path))
            
            if item.is_file():
                files.append({
                    "name": item.name,
                    "path": relative_path,
                    "size": item.stat().st_size,
                    "modified": datetime.datetime.fromtimestamp(item.stat().st_mtime).isoformat(),
                    "type": "file"
                })
            elif item.is_dir():
                files.append({
                    "name": item.name,
                    "path": relative_path,
                    "modified": datetime.datetime.fromtimestamp(item.stat().st_mtime).isoformat(),
                    "type": "directory"
                })
        
        return files 