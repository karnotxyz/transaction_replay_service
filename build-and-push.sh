#!/bin/bash

# Exit on error
set -e

# Get commit tag from CLI argument if provided, otherwise use git commit hash
if [ -n "$1" ]; then
    COMMIT_TAG="$1"
    echo "Using provided commit tag: ${COMMIT_TAG}"
else
    COMMIT_TAG=$(git rev-parse --short=7 HEAD)
    echo "No tag provided, using git commit hash: ${COMMIT_TAG}"
fi

# Docker image details
IMAGE_REPO="public.ecr.aws/o5q6k5w4/karnot-operator/txn_replay_service"
IMAGE_TAG="${IMAGE_REPO}:${COMMIT_TAG}"

echo "=================================================="
echo "Building Docker image with tag: ${COMMIT_TAG}"
echo "Full image name: ${IMAGE_TAG}"
echo "=================================================="

# Build the Docker image using buildx for cross-platform support
echo "Building Docker image..."
docker buildx build --platform linux/amd64 -t "${IMAGE_TAG}" --load .

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

