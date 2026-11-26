import { setTimeout as delay } from "node:timers/promises";
import axios from "axios";
import { hash } from "starknet";

const IMPORT = "madara_V0_1_0_importCommittedDataSet";
const UPDATE = "madara_V0_1_0_updateCommittedDataSet";
const FELT_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
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

type Lookup = { root: string } & ({ transaction_hash: string } | Namespace);

export interface ProxyReplaySettings {
  proxyFeeder: string;
  token: string;
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

export function readProxyReplaySettings(env: NodeJS.ProcessEnv): ProxyReplaySettings | undefined {
  if (env.COMMITTED_DATA_REPLAY_ENABLED !== "true") return undefined;
  const source = env.COMMITTED_DATA_REPLAY_SOURCE ?? "feeder";
  if (source === "feeder") return undefined;
  if (source !== "proxy") throw new Error("COMMITTED_DATA_REPLAY_SOURCE must be feeder or proxy");
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Proxy committed-data replay requires ${name}`);
    return value;
  };
  const endpoint = (name: string, feeder = false) => {
    const url = new URL(required(name));
    const path = url.pathname.replace(/\/$/, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || (feeder && !path.endsWith("/feeder_gateway"))) {
      throw new Error(`Invalid URL in ${name}`);
    }
    return url.origin + (feeder ? path : url.pathname);
  };
  const token = required("COMMITTED_DATA_PROXY_TOKEN");
  if (!/^[\x21-\x7e]{32,}$/.test(token)) throw new Error("Invalid COMMITTED_DATA_PROXY_TOKEN");
  return {
    proxyFeeder: endpoint("COMMITTED_DATA_PROXY_FEEDER_URL", true),
    token,
    executor: felt(required("COMMITTED_DATA_EXECUTOR_ADDRESS")),
    oracle: felt(required("COMMITTED_DATA_ORACLE_ADDRESS")),
    targetRpc: endpoint("COMMITTED_DATA_TARGET_RPC_URL"),
    targetFeeder: endpoint("COMMITTED_DATA_TARGET_FEEDER_URL", true),
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

export async function importProxyCommittedData(
  settings: ProxyReplaySettings,
  transactions: readonly JsonObject[],
  signal?: AbortSignal,
): Promise<void> {
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

  async function fetchDataset(lookup: Lookup): Promise<Dataset> {
    const url = settings.proxyFeeder + "/get_signed_committed_data_update";
    for (let attempt = 0; ; attempt++) {
      const response = await axios.get<unknown>(url, {
        params: lookup,
        headers: { Authorization: "Bearer " + settings.token },
        timeout: 50000,
        maxRedirects: 0,
        maxContentLength: 128 * 1024 * 1024,
        validateStatus: () => true,
        signal,
      }).catch(() => {
        // Axios errors retain request headers. Keep credentials out of replay logs.
        signal?.throwIfAborted();
        return null;
      });
      if (response?.status === 200) {
        const dataset = parseDataset(object(response.data));
        if (dataset.root !== lookup.root || ("application_id" in lookup &&
            (dataset.update?.application_id !== lookup.application_id || dataset.update.dataset_id !== lookup.dataset_id))) {
          throw new Error(`Proxy returned the wrong signed dataset for root ${lookup.root}`);
        }
        return dataset;
      }
      const status = response?.status;
      if (attempt === 2 || (status !== undefined && status !== 429 && status < 500)) {
        throw new Error(`Proxy signed dataset lookup failed for root ${lookup.root}: ${status ?? "connection failed"}`);
      }
      await delay(500 * (attempt + 1), undefined, { signal });
    }
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
    if (!await available(root, update, signal)) {
      throw new Error(`C2 acknowledged committed dataset ${root} but it is not available from the feeder`);
    }
  }

  async function ensure(lookup: Lookup) {
    let dataset = await fetchDataset(lookup);
    if (await available(dataset.root, dataset.update, signal)) return;

    const seen = new Set<string>();
    const pending: Lookup[] = [];
    while (dataset.update?.base_root && !await available(dataset.update.base_root, dataset.update, signal)) {
      pending.push(lookup);
      const { application_id, dataset_id, base_root: root } = dataset.update;
      const key = `${application_id}:${dataset_id}:${root}`;
      if (seen.has(key)) throw new Error(`Cycle in committed-data bases at root ${root}`);
      seen.add(key);
      lookup = { root, application_id, dataset_id };
      dataset = await fetchDataset(lookup);
    }
    await send(dataset, signal);
    // Retain only lookups while walking long dependency chains.
    while (pending.length) {
      const dependent = await fetchDataset(pending.pop()!);
      await send(dependent, signal);
    }
  }

  for (const tx of transactions) {
    for (const root of new Set(publishedRoots(tx, settings.executor, settings.oracle))) {
      signal?.throwIfAborted();
      await ensure({ root, transaction_hash: felt(tx.transaction_hash) });
    }
  }
}
