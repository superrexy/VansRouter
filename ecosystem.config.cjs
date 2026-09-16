const path = require("node:path");

const root = __dirname;
const currentLink = process.env.CURRENT_LINK || "/var/lib/9router/current";

module.exports = {
  apps: [{
    name: process.env.PM2_APP_NAME || "9router",
    cwd: root,
    script: path.join(root, "server.js"),
    exec_mode: "fork",
    instances: 1,
    env: {
      NODE_ENV: process.env.NODE_ENV || "production",
      PORT: process.env.PORT || "3003",
      RELEASE_SERVER: process.env.RELEASE_SERVER || path.join(currentLink, "server.js"),
      RELEASE_BUILD_ID: process.env.RELEASE_BUILD_ID || "",
    },
  }],
};
