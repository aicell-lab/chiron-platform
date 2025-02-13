import ray
from ray import serve

@serve.deployment
class SimpleModel:
    def __init__(self):
        self.count = 0

    async def __call__(self, request):
        self.count += 1
        return {"count": self.count, "message": "Hello from Ray Serve!"}

# Deploy the model
simple_model = SimpleModel.bind()

def cleanup():
    """Optional cleanup function that will be called when undeploying."""
    SimpleModel.delete() 