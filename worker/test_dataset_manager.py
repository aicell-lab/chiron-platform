import asyncio
import base64
import json
from hypha_rpc import connect_to_server

async def test_dataset_manager():
    # Connect to Hypha server
    client = await connect_to_server({
        "server_url": "http://hypha-server.hypha.svc.cluster.local:9520",
        "workspace": "chiron-platform",
        "token": "YOUR_TOKEN_HERE",  # Replace with your actual token
    })
    
    # Get the dataset manager service
    dataset_manager = await client.get_service("dataset-manager")
    
    # Test ping
    print("Testing ping...")
    result = await dataset_manager.ping()
    print(f"Ping result: {result}")
    
    # Create a test dataset
    print("\nCreating test dataset...")
    test_dataset = {
        "name": "Test Dataset",
        "description": "A test dataset for the Chiron Platform",
        "tags": ["test", "demo"],
        "type": "single-cell",
        "id_emoji": "🧪",
    }
    
    try:
        result = await dataset_manager.create_dataset("test-dataset", test_dataset)
        print(f"Create dataset result: {json.dumps(result, indent=2)}")
    except Exception as e:
        print(f"Error creating dataset: {e}")
    
    # List datasets
    print("\nListing datasets...")
    try:
        datasets = await dataset_manager.list_datasets()
        print(f"Datasets: {json.dumps(datasets, indent=2)}")
    except Exception as e:
        print(f"Error listing datasets: {e}")
    
    # Upload a test file
    print("\nUploading test file...")
    test_content = "This is a test file for the Chiron Platform dataset manager."
    test_content_base64 = base64.b64encode(test_content.encode()).decode()
    
    try:
        result = await dataset_manager.upload_file("test-dataset", "test.txt", test_content_base64)
        print(f"Upload file result: {json.dumps(result, indent=2)}")
    except Exception as e:
        print(f"Error uploading file: {e}")
    
    # List files
    print("\nListing files...")
    try:
        files = await dataset_manager.list_files("test-dataset")
        print(f"Files: {json.dumps(files, indent=2)}")
    except Exception as e:
        print(f"Error listing files: {e}")
    
    # Clean up
    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(test_dataset_manager()) 