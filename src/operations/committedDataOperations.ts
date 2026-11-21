import axios from "axios";

const ROOTS_PER_PAGE = 64;
const importedRoots = new Set<string>();
let importTail: Promise<void> = Promise.resolve();

interface DatasetPage {
  root: string;
  count: number;
  entries: [string, string][];
}

function endpoints(): { feeder: string; privateRpc: string } | undefined {
  if (process.env.COMMITTED_DATA_REPLAY_ENABLED !== "true") return undefined;
  const feeder = process.env.COMMITTED_DATA_SOURCE_FEEDER_URL;
  const privateRpc = process.env.COMMITTED_DATA_TARGET_RPC_URL;
  if (!feeder || !privateRpc) {
    throw new Error("Committed-data replay requires COMMITTED_DATA_SOURCE_FEEDER_URL and COMMITTED_DATA_TARGET_RPC_URL");
  }
  return { feeder: feeder.replace(/\/$/, ""), privateRpc };
}

async function importMissingDatasets(feeder: string, privateRpc: string): Promise<void> {
  let after: string | undefined;
  while (true) {
    const url = `${feeder}/get_committed_data_roots${after ? `?after=${after}` : ""}`;
    const { data: roots } = await axios.get<string[]>(url);
    if (!Array.isArray(roots)) throw new Error(`Invalid committed-data root catalog from ${url}`);
    for (const root of roots) {
      if (importedRoots.has(root)) continue;
      const entries: [string, string][] = [];
      let count = 0;
      do {
        const { data: page } = await axios.get<DatasetPage>(`${feeder}/get_committed_data`, {
          params: { root, start: entries.length },
        });
        if (!page || BigInt(page.root) !== BigInt(root) || !Number.isInteger(page.count) || page.count < 1) {
          throw new Error(`Invalid committed-data page for root ${root}`);
        }
        count = page.count;
        if (!Array.isArray(page.entries) || page.entries.length === 0) throw new Error(`Empty committed-data page for root ${root}`);
        entries.push(...page.entries);
        if (entries.length > count) throw new Error(`Committed-data page overflow for root ${root}`);
      } while (entries.length < count);
      const { data: imported } = await axios.post(privateRpc, {
        jsonrpc: "2.0",
        id: root,
        method: "madara_V0_1_0_importCommittedDataSet",
        params: [root, entries, []],
      });
      if (imported.error) throw new Error(`C2 committed-data import ${root}: ${imported.error.message}`);
      importedRoots.add(root);
    }
    if (roots.length < ROOTS_PER_PAGE) return;
    after = roots.at(-1);
  }
}

/** Import every C1 dataset seen by the feeder before submitting the next managed block. */
export async function importCommittedDataBeforeBlock(): Promise<void> {
  const configured = endpoints();
  if (!configured) return;
  const run = importTail.then(() => importMissingDatasets(configured.feeder, configured.privateRpc));
  importTail = run.catch(() => undefined);
  await run;
}
