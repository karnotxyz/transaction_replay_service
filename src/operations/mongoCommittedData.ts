import { createHash } from "node:crypto";
import axios from "axios";
import { Binary, MongoClient, type Db, type ObjectId } from "mongodb";
import { hash } from "starknet";

const IMPORT = "madara_V0_1_0_importCommittedDataSet";
const UPDATE = "madara_V0_1_0_updateCommittedDataSet";
const COMBINED = "madara_V0_1_0_importCommittedDataAndSubmitTransaction";
const FELT_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const PUBLISH_SELECTOR = felt(hash.getSelectorFromName("publish_snapshot_root"));

type JsonObject = Record<string, unknown>;

interface Namespace {
  application_id: string;
  dataset_id: string;
}

interface Dataset {
  root: string;
  entries: unknown[];
  signatures: unknown[];
  update?: Namespace & { base_root: string | null };
}

interface ArchiveManifest {
  _id: ObjectId;
  method: string;
  request_bytes: number;
  chunk_count: number;
  payload_sha256: Binary;
  dataset_roots: string[];
}

interface ArchiveChunk {
  _id: string;
  call_id: ObjectId;
  index: number;
  payload: Binary;
}

interface ArchiveRequest {
  datasets: Dataset[];
  transaction?: JsonObject;
}

export interface MongoReplaySettings {
  uri: string;
  database: string;
  collection: string;
  executor: string;
  oracle: string;
  targetRpc: string;
  targetFeeder: string;
}

function hex(value: bigint): string {
  return "0x" + value.toString(16);
}

function felt(value: unknown): string {
  if (typeof value !== "string" || !/^0x[\da-f]+$/i.test(value)) {
    throw new Error("Expected a hexadecimal felt");
  }
  const number = BigInt(value);
  if (number >= FELT_PRIME) throw new Error("Felt is out of range");
  return hex(number);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as JsonObject;
}

export function readMongoReplaySettings(env: NodeJS.ProcessEnv): MongoReplaySettings | undefined {
  if (env.COMMITTED_DATA_REPLAY_ENABLED !== "true") return undefined;
  const source = env.COMMITTED_DATA_REPLAY_SOURCE ?? "feeder";
  if (source === "feeder") return undefined;
  if (source !== "mongo") throw new Error("COMMITTED_DATA_REPLAY_SOURCE must be feeder or mongo");
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Mongo committed-data replay requires ${name}`);
    return value;
  };
  return {
    uri: required("COMMITTED_DATA_MONGO_URI"),
    database: env.COMMITTED_DATA_MONGO_DATABASE ?? "committed_data",
    collection: env.COMMITTED_DATA_MONGO_AUDIT_COLLECTION ?? "proxy_rpc_calls",
    executor: felt(required("COMMITTED_DATA_EXECUTOR_ADDRESS")),
    oracle: felt(required("COMMITTED_DATA_ORACLE_ADDRESS")),
    targetRpc: required("COMMITTED_DATA_TARGET_RPC_URL"),
    targetFeeder: required("COMMITTED_DATA_TARGET_FEEDER_URL").replace(/\/$/, ""),
  };
}

export function publishedRoots(tx: JsonObject, executor: string, oracle: string): string[] {
  if (tx.type !== "INVOKE" || tx.sender_address === undefined || felt(tx.sender_address) !== executor) return [];
  const calldata = tx.calldata;
  if (!Array.isArray(calldata) || calldata.length === 0) throw new Error("Missing executor calldata");

  // Cairo 1 account encoding: count followed by (to, selector, length, calldata...) for each call.
  const count = BigInt(felt(calldata[0]));
  if (count > BigInt(Math.floor((calldata.length - 1) / 3))) throw new Error("Invalid executor multicall count");
  let cursor = 1;
  const roots: string[] = [];
  for (let index = 0; index < Number(count); index++) {
    const address = felt(calldata[cursor++]);
    const selector = felt(calldata[cursor++]);
    const length = BigInt(felt(calldata[cursor++]));
    if (length > BigInt(calldata.length - cursor)) throw new Error("Truncated executor multicall");
    if (address === oracle && selector === PUBLISH_SELECTOR) {
      // publish_snapshot_root(root, snapshot_id, timestamp)
      if (length !== 3n) throw new Error("Invalid publish_snapshot_root calldata");
      roots.push(felt(calldata[cursor]));
    }
    cursor += Number(length);
  }
  if (cursor !== calldata.length) throw new Error("Unexpected trailing executor calldata");
  return roots;
}

function parseDataset(raw: JsonObject): Dataset {
  const { entries, signatures, update } = raw;
  if (!Array.isArray(entries) || (signatures != null && !Array.isArray(signatures))) {
    throw new Error("Invalid archived dataset parameters");
  }
  let metadata: Dataset["update"];
  if (update != null) {
    const fields = object(update);
    metadata = {
      application_id: felt(fields.application_id),
      dataset_id: felt(fields.dataset_id),
      base_root: fields.base_root === null ? null : felt(fields.base_root),
    };
  }
  return { root: felt(raw.root), entries, signatures: signatures ?? [], update: metadata };
}

function parseArchive(body: Buffer, method: string): ArchiveRequest {
  const raw = object(JSON.parse(body.toString("utf8")));
  if (raw.jsonrpc !== "2.0" || raw.method !== method) throw new Error("Archive RPC metadata mismatch");
  const params = raw.params;
  if (method === COMBINED) {
    const [datasets, transaction] = Array.isArray(params)
      ? params
      : [object(params).datasets, object(params).transaction];
    if (!Array.isArray(datasets)) throw new Error("Invalid archived dataset list");
    return { datasets: datasets.map(value => parseDataset(object(value))), transaction: object(transaction) };
  }
  if (method !== UPDATE && method !== IMPORT) throw new Error("Unexpected archive method");
  if (!Array.isArray(params)) return { datasets: [parseDataset(object(params))] };
  const [root, entries, signatures] = method === UPDATE ? params.slice(1) : params;
  return { datasets: [parseDataset({ root, entries, signatures, update: method === UPDATE ? params[0] : undefined })] };
}

const INVOKE_FIELDS = [
  "type", "version", "sender_address", "nonce", "calldata", "signature", "max_fee", "resource_bounds", "tip",
  "paymaster_data", "account_deployment_data", "nonce_data_availability_mode", "fee_data_availability_mode", "proof_facts",
];

function normalize(value: unknown): unknown {
  if (typeof value === "string" && /^0x[\da-f]+$/i.test(value)) return hex(BigInt(value));
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function sameInvoke(source: JsonObject, archived: JsonObject | undefined): boolean {
  return archived !== undefined && archived.is_query !== true && INVOKE_FIELDS.every(field =>
    JSON.stringify(normalize(source[field])) === JSON.stringify(normalize(archived[field])));
}

function matchesNamespace(update: Dataset["update"], scope?: Namespace): boolean {
  return !scope || (update?.application_id === scope.application_id && update.dataset_id === scope.dataset_id);
}

// The C2 catalogs seek strictly after a numeric felt (or a lexicographically ordered tuple).
function before(values: string[]): string[] | undefined {
  const cursor = values.map(value => BigInt(value));
  for (let index = cursor.length - 1; index >= 0; index--) {
    if (cursor[index] > 0n) {
      cursor[index]--;
      return cursor.map(hex);
    }
    cursor[index] = FELT_PRIME - 1n;
  }
  return undefined;
}

export function createMongoCommittedDataImporter(settings: MongoReplaySettings, database: Db) {
  const manifests = database.collection<ArchiveManifest>(settings.collection, { readConcern: { level: "majority" } });
  const chunks = database.collection<ArchiveChunk>(settings.collection + "_chunks", { readConcern: { level: "majority" } });

  async function readArchive(manifest: ArchiveManifest): Promise<ArchiveRequest> {
    const { _id, method, request_bytes: size, chunk_count: count, payload_sha256: digest } = manifest;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_REQUEST_BYTES ||
        count !== Math.ceil(size / CHUNK_BYTES) || !(digest instanceof Binary)) {
      throw new Error(`Invalid manifest for archived request ${_id}`);
    }
    const payload = Buffer.allocUnsafe(size);
    for (let index = 0; index < count; index++) {
      const chunk = await chunks.findOne({ _id: `${_id}:${index}`, call_id: _id, index });
      const offset = index * CHUNK_BYTES;
      if (!(chunk?.payload instanceof Binary) || chunk.payload.length() !== Math.min(CHUNK_BYTES, size - offset)) {
        throw new Error(`Missing or invalid archive chunk ${_id}:${index}`);
      }
      payload.set(chunk.payload.value(), offset);
    }
    if (!createHash("sha256").update(payload).digest().equals(digest.value())) {
      throw new Error(`Archive digest mismatch for request ${_id}`);
    }
    return parseArchive(payload, method);
  }

  async function available(root: string, scope?: Namespace, signal?: AbortSignal): Promise<boolean> {
    const [after] = before([root]) ?? [];
    const { data: roots } = await axios.get<unknown[]>(settings.targetFeeder + "/get_committed_data_roots", {
      params: after ? { after } : undefined, timeout: 30000, signal,
    });
    if (!Array.isArray(roots)) throw new Error("Invalid C2 committed-data root catalog");
    if (roots.length === 0 || felt(roots[0]) !== root) return false;
    if (!scope) return true;
    const cursor = before([scope.application_id, scope.dataset_id, root]);
    const { data: versions } = await axios.get<unknown[]>(settings.targetFeeder + "/get_committed_data_versions", {
      params: cursor ? { application_id: cursor[0], dataset_id: cursor[1], root: cursor[2] } : undefined,
      timeout: 30000, signal,
    });
    if (!Array.isArray(versions)) throw new Error("Invalid C2 committed-data version catalog");
    if (versions.length === 0) return false;
    const version = object(versions[0]);
    return felt(version.root) === root && felt(version.application_id) === scope.application_id &&
      felt(version.dataset_id) === scope.dataset_id;
  }

  async function locate(root: string, tx?: JsonObject, scope?: Namespace) {
    const cursor = manifests.find({ dataset_roots: root }).sort({ _id: -1 });
    try {
      for await (const manifest of cursor) {
        const request = await readArchive(manifest);
        if (tx && !sameInvoke(tx, request.transaction)) continue;
        const index = request.datasets.findIndex(dataset => dataset.root === root && matchesNamespace(dataset.update, scope));
        if (index !== -1) return { manifest, index, dataset: request.datasets[index] };
      }
    } finally {
      await cursor.close();
    }
    throw new Error(`No matching archived committed dataset for root ${root}`);
  }

  async function send(dataset: Dataset, signal?: AbortSignal) {
    const { update, root, entries, signatures } = dataset;
    const { data } = await axios.post(settings.targetRpc, {
      jsonrpc: "2.0", id: root, method: update ? UPDATE : IMPORT,
      params: update ? [update, root, entries, signatures] : [root, entries, signatures],
    }, { timeout: 300000, signal });
    if (data?.jsonrpc !== "2.0" || data.id !== root || data.result !== null || "error" in data) {
      throw new Error(`C2 did not acknowledge committed dataset ${root}: ${data?.error?.message ?? "invalid response"}`);
    }
  }

  async function ensure(root: string, tx: JsonObject, signal?: AbortSignal) {
    const seen = new Set<string>();
    const pending: { manifest: ArchiveManifest; index: number }[] = [];
    let current = root;
    let scope: Namespace | undefined;
    while (!await available(current, scope, signal)) {
      if (seen.has(current)) throw new Error(`Cycle in committed-data bases at root ${current}`);
      seen.add(current);
      const { manifest, index, dataset } = await locate(current, current === root ? tx : undefined, scope);
      if (!dataset.update?.base_root || await available(dataset.update.base_root, dataset.update, signal)) {
        await send(dataset, signal);
        break;
      }
      pending.push({ manifest, index });
      current = dataset.update.base_root;
      scope = dataset.update;
    }
    // Keep archive references rather than retaining every large dataset in a dependency chain.
    for (const { manifest, index } of pending.reverse()) {
      const { datasets } = await readArchive(manifest);
      await send(datasets[index], signal);
    }
  }

  return async (transactions: readonly JsonObject[], signal?: AbortSignal) => {
    const required = new Map<string, JsonObject>();
    for (const tx of transactions) {
      for (const root of publishedRoots(tx, settings.executor, settings.oracle)) {
        if (!required.has(root)) required.set(root, tx);
      }
    }
    for (const [root, tx] of required) {
      signal?.throwIfAborted();
      await ensure(root, tx, signal);
    }
  };
}

let archive: {
  client: MongoClient;
  import: ReturnType<typeof createMongoCommittedDataImporter>;
} | undefined;

export async function importMongoCommittedData(
  settings: MongoReplaySettings,
  transactions: readonly JsonObject[],
  signal?: AbortSignal,
): Promise<void> {
  if (!archive) {
    const client = new MongoClient(settings.uri, { serverSelectionTimeoutMS: 10000 });
    archive = { client, import: createMongoCommittedDataImporter(settings, client.db(settings.database)) };
  }
  await archive.import(transactions, signal);
}

export async function closeMongoCommittedData(): Promise<void> {
  const current = archive;
  archive = undefined;
  await current?.client.close();
}
