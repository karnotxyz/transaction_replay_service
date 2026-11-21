#!/bin/sh
set -eu

image=ghcr.io/madara-alliance/madara:manual-5f78283
docker image inspect "$image" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$image"
docker tag "$image" karnot/local-madara-pr1349:5f78283
docker image inspect mongo:7 >/dev/null 2>&1 || docker pull mongo:7
docker network inspect local-committed-replay >/dev/null 2>&1 || docker network create local-committed-replay

if docker container inspect local-committed-mongo >/dev/null 2>&1; then
  docker start local-committed-mongo >/dev/null 2>&1 || true
else
  docker run -d --name local-committed-mongo --network local-committed-replay --network-alias mongo \
    -p 127.0.0.1:27117:27017 mongo:7 --replSet rs0 --bind_ip_all >/dev/null
fi
ready=0
for attempt in $(seq 1 30); do
  if docker exec local-committed-mongo mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -qx 1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo 'Local MongoDB did not become ready' >&2; exit 1; }
docker exec local-committed-mongo mongosh --quiet --eval 'try { rs.status() } catch { rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo:27017"}]}) }' >/dev/null

start_node() {
  name=$1 public=$2 admin=$3 private=$4 feeder=$5 database=$6 committed=$7
  if docker container inspect "$name" >/dev/null 2>&1; then
    docker start "$name" >/dev/null 2>&1 || true
    return
  fi
  docker run -d --platform linux/amd64 --name "$name" --network local-committed-replay \
    -p "127.0.0.1:$public:9944" -p "127.0.0.1:$admin:9943" \
    -p "127.0.0.1:$private:9945" -p "127.0.0.1:$feeder:8080" \
    -v "$name-db:/data" "$image" --devnet --name "$name" --base-path /data \
    --chain-config-override chain_id=LOCAL_REPLAY,block_time=2s \
    --rpc-external --rpc-admin --rpc-admin-external --rpc-unsafe \
    --rpc-committed-data --rpc-committed-data-external \
    --gateway-enable --gateway-external --feeder-gateway-enable \
    --external-db-enabled --external-db-mongodb-uri 'mongodb://mongo:27017/?replicaSet=rs0' \
    --external-db-database "$database" $committed >/dev/null
}

start_node local-replay-c1 19944 19943 19945 18080 local_replay_c1 ''
start_node local-replay-c2 29944 29943 29945 28080 local_replay_c2 '--use-committed-data'
ready=0
for attempt in $(seq 1 60); do
  if curl -fsS -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"starknet_chainId","params":[]}' \
      http://127.0.0.1:19944/rpc/v0.10.2/ 2>/dev/null | grep -q 'result' && \
     curl -fsS -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"starknet_chainId","params":[]}' \
      http://127.0.0.1:29944/rpc/v0.10.2/ 2>/dev/null | grep -q 'result'; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo 'Local Madara RPC did not become ready' >&2; exit 1; }
echo 'Local C1/C2 ready on ports 19944 and 29944.'
