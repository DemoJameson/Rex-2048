import { pluginRexWidget } from "@rexnow/rslib-plugin";
import { defineConfig } from "@rslib/core";

export default defineConfig({
  plugins: [
    pluginRexWidget({
      devPort: 18082,
      encrypt: false,
    }),
  ],
  lib: [
    {
      format: "esm",
      syntax: ["node 18"],
    },
  ],
});
