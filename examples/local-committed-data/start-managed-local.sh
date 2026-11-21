#!/bin/sh
set -eu

c1_image=ghcr.io/madara-alliance/madara:manual-5f78283
c2_image=${C2_IMAGE:-ghcr.io/madara-alliance/madara:manual-780f287}
docker image inspect "$c1_image" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$c1_image"
docker image inspect "$c2_image" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$c2_image"
docker network inspect local-committed-replay >/dev/null 2>&1 || docker network create local-committed-replay >/dev/null
docker container inspect local-committed-mongo >/dev/null 2>&1 || {
  docker run -d --name local-committed-mongo --network local-committed-replay --network-alias mongo \
    -p 127.0.0.1:27117:27017 mongo:7 --replSet rs0 --bind_ip_all >/dev/null
}
docker start local-committed-mongo >/dev/null 2>&1 || true

if docker container inspect local-managed-c1 >/dev/null 2>&1 || docker container inspect local-managed-c2 >/dev/null 2>&1; then
  echo 'Managed test containers already exist; use their existing databases or remove them explicitly for a fresh run.' >&2
  exit 1
fi

docker run -d --platform linux/amd64 --name local-managed-c1 --network local-committed-replay \
  -p 127.0.0.1:39944:9944 -p 127.0.0.1:39943:9943 \
  -p 127.0.0.1:39945:9945 -p 127.0.0.1:38080:8080 \
  -v local-managed-c1-db:/data "$c1_image" --devnet --name Local-Managed-C1 --base-path /data \
  --chain-config-override chain_id=LOCAL_REPLAY,block_time=60s \
  --rpc-external --rpc-admin --rpc-admin-external --rpc-unsafe \
  --rpc-committed-data --rpc-committed-data-external \
  --gateway-enable --gateway-external --feeder-gateway-enable \
  --external-db-enabled --external-db-mongodb-uri 'mongodb://mongo:27017/?replicaSet=rs0' \
  --external-db-database local_managed_c1 >/dev/null

# Distinct genesis timestamps make the block hashes diverge even when the
# initial state and every replayed account transaction are identical.
sleep 2
docker run -d --platform linux/amd64 --name local-managed-c2 --network local-committed-replay \
  -p 127.0.0.1:49944:9944 -p 127.0.0.1:49943:9943 \
  -p 127.0.0.1:49945:9945 -p 127.0.0.1:48080:8080 \
  -v local-managed-c2-db:/data "$c2_image" --devnet --name Local-Managed-C2 --base-path /data \
  --chain-config-override chain_id=LOCAL_REPLAY,block_time=60s \
  --use-committed-data --replay-mode --mempool-paused --no-l1-sync \
  --rpc-external --rpc-admin --rpc-admin-external --rpc-unsafe \
  --rpc-committed-data --rpc-committed-data-external \
  --gateway-enable --gateway-external --feeder-gateway-enable \
  --external-db-enabled --external-db-mongodb-uri 'mongodb://mongo:27017/?replicaSet=rs0' \
  --external-db-database local_managed_c2 >/dev/null

echo 'Managed C1/C2 containers started on public RPC ports 39944 and 49944.'
