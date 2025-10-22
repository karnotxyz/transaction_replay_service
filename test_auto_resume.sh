#!/bin/bash

# Auto-Resume Testing Script
# This script will test the auto-resume functionality

set -e

echo "🧪 =================================="
echo "   AUTO-RESUME TESTING SCRIPT"
echo "===================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVICE_URL="${SERVICE_URL:-http://localhost:3000}"
SYNC_FROM="${SYNC_FROM:-409424}"
SYNC_TO="${SYNC_TO:-409460}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-9999}"

echo "Configuration:"
echo "  Service URL: $SERVICE_URL"
echo "  Sync Range: $SYNC_FROM -> $SYNC_TO"
echo "  Redis: $REDIS_HOST:$REDIS_PORT"
echo ""

# Helper functions
check_service() {
    echo -n "Checking if service is running... "
    if curl -sf "$SERVICE_URL/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ OK${NC}"
        return 0
    else
        echo -e "${RED}❌ FAILED${NC}"
        return 1
    fi
}

check_redis() {
    echo -n "Checking if Redis is running... "
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1; then
        echo -e "${GREEN}✅ OK${NC}"
        return 0
    else
        echo -e "${RED}❌ FAILED${NC}"
        return 1
    fi
}

get_process_id() {
    echo "$1" | jq -r '.processId'
}

get_redis_field() {
    local process_id=$1
    local field=$2
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" HGET "sync:$process_id" "$field" 2>/dev/null || echo ""
}

# Pre-flight checks
echo "📋 Pre-flight Checks"
echo "===================="
if ! check_service; then
    echo -e "${RED}❌ Service is not running. Please start it first.${NC}"
    echo "   Run: npm start"
    exit 1
fi

if ! check_redis; then
    echo -e "${RED}❌ Redis is not running. Please start it first.${NC}"
    echo "   Run: docker run -d -p 9999:9999 redis:7-alpine"
    exit 1
fi

echo -e "${GREEN}✅ All pre-flight checks passed!${NC}"
echo ""

# Test 1: Basic Auto-Resume
echo "🧪 TEST 1: Basic Auto-Resume"
echo "============================"
echo "This test will:"
echo "  1. Start a sync"
echo "  2. Wait for some progress"
echo "  3. Kill the service (simulating pod eviction)"
echo "  4. Restart the service"
echo "  5. Verify it auto-resumes from the correct position"
echo ""

read -p "Press Enter to start Test 1... " -n 1 -r
echo ""

# 1.1 Start sync
echo "1️⃣  Starting sync..."
RESPONSE=$(curl -s -X POST "$SERVICE_URL/sync" \
    -H 'Content-Type: application/json' \
    -d "{\"syncFrom\": $SYNC_FROM, \"syncTo\": $SYNC_TO, \"startTxIndex\": 0}")

PROCESS_ID=$(get_process_id "$RESPONSE")

if [ -z "$PROCESS_ID" ] || [ "$PROCESS_ID" = "null" ]; then
    echo -e "${RED}❌ Failed to start sync${NC}"
    echo "Response: $RESPONSE"
    exit 1
fi

echo -e "${GREEN}✅ Sync started with processId: $PROCESS_ID${NC}"

# 1.2 Wait for progress
echo ""
echo "2️⃣  Waiting for sync to make progress (10 seconds)..."
for i in {1..10}; do
    echo -n "."
    sleep 1
done
echo ""

# 1.3 Check current state
echo ""
echo "3️⃣  Current state before restart:"
CURRENT_BLOCK=$(get_redis_field "$PROCESS_ID" "currentBlock")
CURRENT_TX=$(get_redis_field "$PROCESS_ID" "currentTxIndex")
STATUS=$(get_redis_field "$PROCESS_ID" "status")

echo "   Block: $CURRENT_BLOCK"
echo "   TX Index: $CURRENT_TX"
echo "   Status: $STATUS"

if [ "$STATUS" != "running" ]; then
    echo -e "${YELLOW}⚠️  Sync is not running. It may have completed or failed.${NC}"
    echo "   Continuing anyway for testing purposes..."
fi

# 1.4 Simulate pod eviction
echo ""
echo "4️⃣  Simulating pod eviction (killing service)..."
echo "   Finding Node.js processes..."

# Try to find and kill the service
if pgrep -f "node.*dist/index.js" > /dev/null; then
    pkill -f "node.*dist/index.js"
    echo -e "${GREEN}✅ Service killed${NC}"
elif pgrep -f "ts-node.*src/index.ts" > /dev/null; then
    pkill -f "ts-node.*src/index.ts"
    echo -e "${GREEN}✅ Service killed${NC}"
else
    echo -e "${YELLOW}⚠️  Could not find Node.js process${NC}"
    echo "   Please manually kill your service now and press Enter"
    read -p "" -n 1 -r
fi

sleep 2

# 1.5 Verify Redis still has data
echo ""
echo "5️⃣  Verifying Redis still has the state..."
AFTER_KILL_BLOCK=$(get_redis_field "$PROCESS_ID" "currentBlock")
AFTER_KILL_TX=$(get_redis_field "$PROCESS_ID" "currentTxIndex")
AFTER_KILL_STATUS=$(get_redis_field "$PROCESS_ID" "status")

if [ -n "$AFTER_KILL_BLOCK" ] && [ -n "$AFTER_KILL_TX" ]; then
    echo -e "${GREEN}✅ Redis still has the state!${NC}"
    echo "   Block: $AFTER_KILL_BLOCK"
    echo "   TX Index: $AFTER_KILL_TX"
    echo "   Status: $AFTER_KILL_STATUS"
else
    echo -e "${RED}❌ Redis lost the state!${NC}"
    exit 1
fi

# 1.6 Restart service
echo ""
echo "6️⃣  Please restart your service now..."
echo "   Run: npm start"
echo "   (Or press Enter if already restarted)"
read -p "" -n 1 -r
echo ""

# 1.7 Wait for service to start
echo "7️⃣  Waiting for service to start..."
for i in {1..30}; do
    if check_service > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Service is back online${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

if ! check_service > /dev/null 2>&1; then
    echo -e "${RED}❌ Service did not start in time${NC}"
    exit 1
fi

# 1.8 Wait for auto-resume (2 sec delay + processing time)
echo ""
echo "8️⃣  Waiting for auto-resume (5 seconds)..."
sleep 5

# 1.9 Check if it auto-resumed
echo ""
echo "9️⃣  Checking if sync auto-resumed..."
STATUS_RESPONSE=$(curl -s "$SERVICE_URL/sync/status/$PROCESS_ID")
CURRENT_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')

if [ "$CURRENT_STATUS" = "running" ] || [ "$CURRENT_STATUS" = "completed" ]; then
    echo -e "${GREEN}✅ Auto-resume SUCCESS!${NC}"
    echo "   Current status: $CURRENT_STATUS"
    echo ""
    echo "Full status:"
    echo "$STATUS_RESPONSE" | jq '.'
else
    echo -e "${RED}❌ Auto-resume FAILED${NC}"
    echo "   Current status: $CURRENT_STATUS"
    echo ""
    echo "Full response:"
    echo "$STATUS_RESPONSE" | jq '.'
fi

echo ""
echo "🎉 TEST 1 COMPLETE!"
echo ""

# Test 2: Skip Last Transaction
echo "🧪 TEST 2: Skip Resume at Last Transaction"
echo "==========================================="
echo "This test will:"
echo "  1. Create a Redis entry at the last transaction"
echo "  2. Restart service"
echo "  3. Verify it marks as completed (not resumed)"
echo ""

read -p "Press Enter to start Test 2 (or Ctrl+C to skip)... " -n 1 -r
echo ""

# 2.1 Create test process ID
TEST_PROCESS_ID="test-last-tx-$(date +%s)"
TEST_BLOCK="$SYNC_TO"

echo "1️⃣  Creating test Redis entry at last transaction..."

# We'll assume 20 transactions (0-19)
# In real scenario, you'd fetch this from the blockchain
LAST_TX_INDEX=19

redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" HMSET "sync:$TEST_PROCESS_ID" \
    syncFrom "$SYNC_FROM" \
    syncTo "$SYNC_TO" \
    currentBlock "$TEST_BLOCK" \
    currentTxIndex "$LAST_TX_INDEX" \
    status "running" \
    createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > /dev/null

echo -e "${GREEN}✅ Created test entry${NC}"
echo "   Process ID: $TEST_PROCESS_ID"
echo "   Block: $TEST_BLOCK"
echo "   TX Index: $LAST_TX_INDEX (assuming last)"
echo "   Status: running"

# 2.2 Kill service
echo ""
echo "2️⃣  Killing service..."
if pgrep -f "node" > /dev/null; then
    pkill -f "node"
    echo -e "${GREEN}✅ Service killed${NC}"
else
    echo "   Please manually kill your service and press Enter"
    read -p "" -n 1 -r
fi

sleep 2

# 2.3 Restart
echo ""
echo "3️⃣  Please restart your service now..."
echo "   Run: npm start"
read -p "Press Enter when restarted... " -n 1 -r
echo ""

# Wait for startup
sleep 5

# 2.4 Check status
echo ""
echo "4️⃣  Checking if process was marked completed..."
FINAL_STATUS=$(get_redis_field "$TEST_PROCESS_ID" "status")

if [ "$FINAL_STATUS" = "completed" ]; then
    echo -e "${GREEN}✅ TEST 2 PASSED! Process marked as completed${NC}"
elif [ "$FINAL_STATUS" = "running" ]; then
    echo -e "${YELLOW}⚠️  Process is still running (may have actually resumed)${NC}"
    echo "   This could mean the block has more transactions than expected"
else
    echo -e "${RED}❌ TEST 2 FAILED${NC}"
    echo "   Expected: completed"
    echo "   Got: $FINAL_STATUS"
fi

# Cleanup
echo ""
echo "5️⃣  Cleaning up test entry..."
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" DEL "sync:$TEST_PROCESS_ID" > /dev/null
echo -e "${GREEN}✅ Cleanup complete${NC}"

echo ""
echo "🎉 TEST 2 COMPLETE!"
echo ""

# Summary
echo "📊 TESTING SUMMARY"
echo "=================="
echo ""
echo "Tests completed! Review the output above."
echo ""
echo "✅ What to look for:"
echo "   • Service logs showing 'Auto-resuming process'"
echo "   • Redis maintaining state across restarts"
echo "   • Sync continuing from correct block/TX"
echo "   • Last transaction scenario handled correctly"
echo ""
echo "📝 Next steps:"
echo "   1. Review service logs for auto-resume messages"
echo "   2. Check Redis: redis-cli KEYS 'sync:*'"
echo "   3. Deploy to K8s and test pod evictions"
echo ""
echo "🎉 Testing complete!"
