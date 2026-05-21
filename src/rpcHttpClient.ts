import axios from "axios";
import http from "node:http";
import https from "node:https";

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
});

export const rpcHttpClient = axios.create({
  headers: {
    "Content-Type": "application/json",
  },
  httpAgent,
  httpsAgent,
});
