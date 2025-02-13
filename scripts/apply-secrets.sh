#!/bin/bash

# Load the .env file
set -a
source .env
set +a

# Create the Kubernetes secret with the auth file and other environment variables
kubectl create secret generic chiron-secrets \
  --from-literal=HYPHA_CHIRON_TOKEN=$WORKSPACE_TOKEN \
  --dry-run=client -o yaml | kubectl apply --namespace=hypha -f -
