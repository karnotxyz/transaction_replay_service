import { RpcProvider } from "starknet";
import dotenv from "dotenv";
dotenv.config();

const originalProvider = new RpcProvider({
  nodeUrl: process.env.RPC_URL_ORIGINAL_NODE!,
});

const syncingProvider = new RpcProvider({
  nodeUrl: process.env.RPC_URL_SYNCING_NODE!,
});

export { originalProvider, syncingProvider };
