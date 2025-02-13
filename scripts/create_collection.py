import os
from dotenv import load_dotenv
from hypha_rpc import connect_to_server

# Load environment variables from .env file
load_dotenv()

SERVER_URL = os.getenv("SERVER_URL", "https://hypha.aicell.io")

async def create_collection():
    server = await connect_to_server({
        "server_url": SERVER_URL,
        "workspace": "chiron-platform",
        "token": os.environ.get("WORKSPACE_TOKEN")
    })
    artifact_manager = await server.get_service("public/artifact-manager")

    collection = await artifact_manager.create(
        alias="chiron-platform/collection",
        type="collection",
        manifest={
            "name": "Chiron Platform Data Collection",
            "description": "A collection of data for the Chiron Platform project",
            "version": "0.1.0",
            "authors": [],
            "tags": ["chiron-platform", "single-cell", "federated-learning"],
            "license": "MIT",
            "documentation": "",
            "covers": [],
            "badges": [],
            "links": []
        },
        config={
            "permissions": {"*": "r", "@": "r+"},
        },
        overwrite=True
    )
    print(f"Collection created: {collection}")

if __name__ == "__main__":
    import asyncio
    asyncio.run(create_collection()) 