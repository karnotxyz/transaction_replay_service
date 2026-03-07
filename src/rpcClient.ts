import axios from "axios";
import http from "http";
import https from "https";

const KEEP_ALIVE_OPTIONS = {
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
};

const httpAgent = new http.Agent(KEEP_ALIVE_OPTIONS);
const httpsAgent = new https.Agent(KEEP_ALIVE_OPTIONS);

export const rpcHttpClient = axios.create({
  httpAgent,
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
  },
});
