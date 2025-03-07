import asyncio
import base64
import json
import argparse
import os
from hypha_rpc import connect_to_server

async def main(args):
    # Connect to Hypha server
    client = await connect_to_server({
        "server_url": args.server_url,
        "workspace": args.workspace,
        "token": args.token,
    })
    
    # Get the dataset manager service
    dataset_manager = await client.get_service("dataset-manager")
    
    if args.command == "ping":
        result = await dataset_manager.ping()
        print(f"Ping result: {result}")
    
    elif args.command == "create_dataset":
        dataset_info = {
            "name": args.name,
            "description": args.description,
            "tags": args.tags.split(",") if args.tags else [],
            "type": args.type,
        }
        result = await dataset_manager.create_dataset(args.dataset_id, dataset_info)
        print(json.dumps(result, indent=2))
    
    elif args.command == "list_datasets":
        datasets = await dataset_manager.list_datasets()
        print(json.dumps(datasets, indent=2))
    
    elif args.command == "get_dataset":
        dataset = await dataset_manager.get_dataset(args.dataset_id)
        print(json.dumps(dataset, indent=2))
    
    elif args.command == "upload_file":
        with open(args.file_path, "rb") as f:
            file_content = f.read()
        
        file_content_base64 = base64.b64encode(file_content).decode()
        target_path = os.path.basename(args.file_path) if args.target_path is None else args.target_path
        
        result = await dataset_manager.upload_file(args.dataset_id, target_path, file_content_base64)
        print(json.dumps(result, indent=2))
    
    elif args.command == "list_files":
        directory = args.directory if hasattr(args, "directory") else None
        files = await dataset_manager.list_files(args.dataset_id, directory)
        print(json.dumps(files, indent=2))
    
    elif args.command == "delete_file":
        result = await dataset_manager.delete_file(args.dataset_id, args.file_path)
        print(json.dumps(result, indent=2))
    
    elif args.command == "delete_dataset":
        result = await dataset_manager.delete_dataset(args.dataset_id)
        print(json.dumps(result, indent=2))
    
    # Clean up
    await client.disconnect()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Client for the Chiron Platform Dataset Manager")
    
    # Connection parameters
    parser.add_argument("--server-url", default="https://hypha.aicell.io", help="Hypha server URL")
    parser.add_argument("--workspace", required=True, help="Hypha workspace")
    parser.add_argument("--token", required=True, help="Hypha token")
    
    # Command subparsers
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")
    subparsers.required = True
    
    # Ping command
    ping_parser = subparsers.add_parser("ping", help="Test connection to the dataset manager")
    
    # Create dataset command
    create_dataset_parser = subparsers.add_parser("create_dataset", help="Create a new dataset")
    create_dataset_parser.add_argument("dataset_id", help="ID for the new dataset")
    create_dataset_parser.add_argument("--name", required=True, help="Name of the dataset")
    create_dataset_parser.add_argument("--description", required=True, help="Description of the dataset")
    create_dataset_parser.add_argument("--tags", help="Comma-separated list of tags")
    create_dataset_parser.add_argument("--type", help="Type of the dataset")
    
    # List datasets command
    list_datasets_parser = subparsers.add_parser("list_datasets", help="List all datasets")
    
    # Get dataset command
    get_dataset_parser = subparsers.add_parser("get_dataset", help="Get information about a dataset")
    get_dataset_parser.add_argument("dataset_id", help="ID of the dataset")
    
    # Upload file command
    upload_file_parser = subparsers.add_parser("upload_file", help="Upload a file to a dataset")
    upload_file_parser.add_argument("dataset_id", help="ID of the dataset")
    upload_file_parser.add_argument("file_path", help="Path to the file to upload")
    upload_file_parser.add_argument("--target-path", help="Target path in the dataset (default: filename)")
    
    # List files command
    list_files_parser = subparsers.add_parser("list_files", help="List files in a dataset")
    list_files_parser.add_argument("dataset_id", help="ID of the dataset")
    list_files_parser.add_argument("--directory", help="Directory to list files from")
    
    # Delete file command
    delete_file_parser = subparsers.add_parser("delete_file", help="Delete a file from a dataset")
    delete_file_parser.add_argument("dataset_id", help="ID of the dataset")
    delete_file_parser.add_argument("file_path", help="Path to the file to delete")
    
    # Delete dataset command
    delete_dataset_parser = subparsers.add_parser("delete_dataset", help="Delete a dataset")
    delete_dataset_parser.add_argument("dataset_id", help="ID of the dataset")
    
    args = parser.parse_args()
    asyncio.run(main(args)) 