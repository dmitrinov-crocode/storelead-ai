import path from "node:path";
import type { NextConfig } from "next";
// The pipeline's config module has no relative imports, so it loads cleanly here
// and stays the single source of truth for where the database lives.
import { getConfig } from "../../src/config/index";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const config = getConfig();

const nextConfig: NextConfig = {
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  env: {
    STORELEAD_ROOT: workspaceRoot,
    STORELEAD_DB_PATH: config.paths.database,
    STORELEAD_DATA_DIR: config.paths.data,
    STORELEAD_SCREENSHOTS_DIR: config.paths.screenshots,
  },
};

export default nextConfig;
