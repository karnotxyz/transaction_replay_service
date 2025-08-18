import { Contract, Provider, RpcProvider } from "starknet";
import ERC20 from "./contracts/ERC20.json" with { type: "json" };
import { ApiPromise, HttpProvider } from "@polkadot/api";
import logger from "./logger.js";
import db from "./models/index.js";

const eth_address =
  "0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

const nonce_tracker: Record<string, number> = {};
const polkadotProvider = new HttpProvider(process.env.RPC_URL_SYNCING_NODE || "");

// ---- Functions ----

/**
 * Returns ERC20 balance of an address.
 */
export async function getBalance(
  address: string,
  provider: RpcProvider,
): Promise<bigint> {
  const erc20 = new Contract(ERC20.abi, eth_address, provider);
  const balance: any = await erc20.call("balanceOf", [address]);
  // Only returning the low part as per original code
  return BigInt(balance.balance.low);
}

/**
 * Returns the nonce for an address.
 * Special handling for address "0x1" with local nonce tracker.
 */
export async function getNonce(
  address: string,
  provider: RpcProvider,
  nonce: string
): Promise<string> {
  if (address !== "0x1") {
    return nonce;
  }

  if (nonce_tracker[address] === undefined) {
    nonce_tracker[address] = Number(await provider.getNonceForAddress(address));
  }

  const address_nonce = nonce_tracker[address];
  nonce_tracker[address] += 1;

  console.log(nonce_tracker[address]);
  return `0x${address_nonce.toString(16)}`;
}

/**
 * Sets disableFee flag on polkadot side.
 */
export async function setDisableFee(value: boolean): Promise<void> {
  logger.info(`Setting disable fees to - ${value}`);
  const api = await ApiPromise.create({ provider: polkadotProvider });
  const extrinsic = api.tx.starknet.setDisableFee(value);
  await extrinsic.send();

  // Sleep for 7 seconds
  await new Promise((resolve) => setTimeout(resolve, 7000));
}

/**
 * Create or update syncing_db row.
 */
export async function syncDbCreateOrUpdate(
  attribute: string,
  // FIX: The 'value' parameter is changed from 'string' to 'number' to match
  // the model definition (DataTypes.INTEGER) and how it's being called.
  value: number
): Promise<void> {
  // FIX: Use the initialized model from the db object.
  const row = await db.syncing_db.findOne({ where: { attribute } });

  if (row != null) {
    row.dataValues.value = value;
    await row.save();
    return;
  }

  // FIX: Use the initialized model from the db object.
  await db.syncing_db.create({ attribute, value });
}


/**
 * Get latest block number from provider.
 */
export async function getLatestBlockNumber(provider: RpcProvider): Promise<number> {
  const latestBlock: any = await provider.getBlockLatestAccepted();
  return latestBlock.block_number;
}
