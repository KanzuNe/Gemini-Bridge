import path from "node:path";

import { APP_DATA_ROOT, DEFAULT_MODEL, GEMINI_MODEL_MAP } from "./constants.js";
import type { RuntimeConfig } from "./types.js";
import { readJsonFile, writeJsonFile } from "./utils.js";

export const CONFIG_FILE = path.join(APP_DATA_ROOT, "data", "config.json");

const DEFAULT_CONFIG: RuntimeConfig = {
  port: 3100,
  host: "127.0.0.1",
  defaultModel: DEFAULT_MODEL,
  proxy: null,
  anchorUrl: null,
  apiKey: null,
  cookieFilePath: path.join(APP_DATA_ROOT, "cookies.json"),
  cookieCheckIntervalMs: 1_000,
  historyDbPath: path.join(APP_DATA_ROOT, "data", "history.db"),
};

export function loadConfig(): RuntimeConfig {
  const loaded = readJsonFile<Partial<RuntimeConfig>>(CONFIG_FILE, {});
  const envPort = Number.parseInt(process.env.GEMINI_NODE_BRIDGE_PORT ?? "", 10);
  const envHost = process.env.GEMINI_NODE_BRIDGE_HOST?.trim() || "";
  const envApiKey = process.env.GEMINI_BRIDGE_API_KEY?.trim() || "";
  const loadedDefaultModel = loaded.defaultModel ?? DEFAULT_CONFIG.defaultModel;
  const defaultModel = GEMINI_MODEL_MAP.get(loadedDefaultModel)?.name ?? DEFAULT_MODEL;

  return {
    ...DEFAULT_CONFIG,
    ...loaded,
    defaultModel,
    port: Number.isNaN(envPort) ? (loaded.port ?? DEFAULT_CONFIG.port) : envPort,
    host: envHost || loaded.host || DEFAULT_CONFIG.host,
    apiKey: envApiKey || loaded.apiKey || DEFAULT_CONFIG.apiKey,
  };
}

export function saveConfig(config: RuntimeConfig): RuntimeConfig {
  writeJsonFile(CONFIG_FILE, config);
  return config;
}
