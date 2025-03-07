# Chiron Platform Dataset Manager

This component provides a dataset management service for the Chiron Platform, allowing users to store, organize, and retrieve datasets for federated learning and other tasks.

## Features

- Create, update, and delete datasets
- Upload and manage files within datasets
- List available datasets and files
- Metadata management with manifest files

## Architecture

The dataset manager is deployed as a Kubernetes pod with a persistent volume for storing datasets. It exposes its functionality through a Hypha service, which can be accessed by clients using the Hypha RPC protocol.

Each dataset is stored as a directory with a `manifest.yaml` file containing metadata about the dataset, such as:

- Name and description
- Tags and badges
- Creation and update timestamps
- File count and total size
- Owner information

## Usage

### Using the Client Script

The `client_test.py` script provides a command-line interface for interacting with the dataset manager:

```bash
# Set up environment variables for convenience
export HYPHA_TOKEN="your-token-here"
export HYPHA_WORKSPACE="chiron-platform"
export HYPHA_SERVER="https://hypha.aicell.io"

# Test connection
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN ping

# Create a dataset
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN create_dataset my-dataset --name "My Dataset" --description "A dataset for testing" --tags "test,demo" --type "single-cell"

# List all datasets
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN list_datasets

# Upload a file
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN upload_file my-dataset path/to/local/file.csv --target-path data/file.csv

# List files in a dataset
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN list_files my-dataset

# Get dataset information
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN get_dataset my-dataset

# Delete a file
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN delete_file my-dataset data/file.csv

# Delete a dataset
python client_test.py --workspace $HYPHA_WORKSPACE --token $HYPHA_TOKEN delete_dataset my-dataset
```

### Using the Hypha RPC API

You can also interact with the dataset manager programmatically using the Hypha RPC API:

```python
import asyncio
import base64
from hypha_rpc import connect_to_server

async def example():
    # Connect to Hypha server
    client = await connect_to_server({
        "server_url": "https://hypha.aicell.io",
        "workspace": "chiron-platform",
        "token": "your-token-here",
    })
    
    # Get the dataset manager service
    dataset_manager = await client.get_service("dataset-manager")
    
    # Create a dataset
    dataset_info = {
        "name": "My Dataset",
        "description": "A dataset for testing",
        "tags": ["test", "demo"],
        "type": "single-cell",
    }
    await dataset_manager.create_dataset("my-dataset", dataset_info)
    
    # Upload a file
    with open("path/to/local/file.csv", "rb") as f:
        file_content = f.read()
    
    file_content_base64 = base64.b64encode(file_content).decode()
    await dataset_manager.upload_file("my-dataset", "data/file.csv", file_content_base64)
    
    # List files
    files = await dataset_manager.list_files("my-dataset")
    print(files)
    
    # Clean up
    await client.disconnect()

# Run the example
asyncio.run(example())
```

## Deployment

The dataset manager is deployed as part of the Chiron Platform worker container. It uses a persistent volume claim to store datasets, ensuring data persistence across pod restarts.

To deploy or update the dataset manager:

1. Build the Docker image:
   ```bash
   docker build -t oeway/hypha-ray-manager:latest .
   docker push oeway/hypha-ray-manager:latest
   ```

2. Apply the Kubernetes manifests:
   ```bash
   kubectl apply -f datasets-pvc.yaml -n hypha
   kubectl apply -f deployment.yaml -n hypha
   ```

## Future Improvements

- Add support for dataset versioning
- Implement access control for datasets
- Add support for dataset sharing between workspaces
- Provide a web UI for dataset management
- Add support for dataset import/export 