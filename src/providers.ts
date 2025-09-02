import { RpcProvider } from "starknet";
import dotenv from "dotenv";
dotenv.config();

const baseOriginalUrl = process.env.RPC_URL_ORIGINAL_NODE!;
const baseSyncingUrl = process.env.RPC_URL_SYNCING_NODE!;


const originalProvider = new RpcProvider({
  nodeUrl: `${baseOriginalUrl}/rpc/v0_8`,
});

const originalv7Provider = new RpcProvider({
  nodeUrl: `${baseOriginalUrl}/rpc/v0_7`,
});

const syncingProvider = new RpcProvider({
  nodeUrl: `${baseSyncingUrl}`,
  specVersion:  "0.8.1"

});

const syncingv7Provider = new RpcProvider({
  nodeUrl: `${baseSyncingUrl}/rpc/v0_7_1`,
  specVersion: "0.7.1"

});

export { originalProvider, originalv7Provider, syncingProvider, syncingv7Provider };
