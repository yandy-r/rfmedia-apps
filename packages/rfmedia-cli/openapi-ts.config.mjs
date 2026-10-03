import { fileURLToPath } from "node:url";

const packageUrl = new URL("./", import.meta.url);

export default {
  input: fileURLToPath(new URL("openapi/lidarr-v1.json", packageUrl)),
  output: {
    path: fileURLToPath(new URL("src/lib/lidarr/generated", packageUrl)),
    importFileExtension: ".js",
    tsConfigPath: fileURLToPath(new URL("tsconfig.json", packageUrl)),
  },
  plugins: [
    {
      name: "@hey-api/client-fetch",
      bundle: true,
    },
    "@hey-api/typescript",
    {
      name: "@hey-api/sdk",
      auth: false,
      client: false,
      operations: "flat",
    },
  ],
};
