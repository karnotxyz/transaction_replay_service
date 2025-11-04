#!/bin/bash

# Exit on error
set -e

# Get the first 7 characters of the last git commit hash
COMMIT_TAG=$(git rev-parse --short=7 HEAD)

# Docker image details
IMAGE_REPO="public.ecr.aws/o5q6k5w4/karnot-operator/txn_replay_service"
IMAGE_TAG="${IMAGE_REPO}:${COMMIT_TAG}"

echo "=================================================="
echo "Building Docker image with tag: ${COMMIT_TAG}"
echo "Full image name: ${IMAGE_TAG}"
echo "=================================================="

# Build the Docker image
echo "Building Docker image..."
docker build --platform linux/amd64 -t "${IMAGE_TAG}" .

echo "=================================================="
echo "Build completed successfully!"
echo "=================================================="

# Push the Docker image
echo "Pushing Docker image to ECR..."
docker push --platform linux/amd64 "${IMAGE_TAG}"

echo "=================================================="
echo "Push completed successfully!"
echo "Image pushed: ${IMAGE_TAG}"
echo "=================================================="

