/**
 * Service — registers the SuperCompress proxy as an OS-level background service
 * that starts automatically when the user logs in.
 *
 * macOS:  Uses launchd via a ~/Library/LaunchAgents plist file
 * Linux:  Uses systemd via a ~/.config/systemd/user unit file
 * Windows: Uses a scheduled task (future)
 */

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const os = require("os");

const HOME = os.homedir();

/**
 * Generate the launchd plist content for macOS.
 * API key is NOT stored in the plist — the server reads it from
 * ~/.supercompress/config.json at startup via compressor.getApiKey().
 */
function launchdPlist(configDir, configPath) {
  const serverPath = path.join(__dirname, "server.js");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.supercompress.service</string>

    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${serverPath}</string>
        <string>8080</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>SUPERCOMPRESS_CONFIG_DIR</key>
        <string>${configDir}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${configDir}/proxy.log</string>

    <key>StandardErrorPath</key>
    <string>${configDir}/proxy.log</string>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>WorkingDirectory</key>
    <string>${configDir}</string>
</dict>
</plist>`;
}

/**
 * Generate the systemd user unit content for Linux.
 * API key is NOT stored in the unit — the server reads it from
 * ~/.supercompress/config.json at startup via compressor.getApiKey().
 */
function systemdUnit(configDir, configPath) {
  const serverPath = path.join(__dirname, "server.js");
  const nodePath = process.execPath || "/usr/bin/node";
  return `[Unit]
Description=SuperCompress Proxy — LLM context compression for coding agents
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${serverPath} 8080
Restart=on-failure
RestartSec=5
Environment=SUPERCOMPRESS_CONFIG_DIR=${configDir}
StandardOutput=append:${configDir}/proxy.log
StandardError=append:${configDir}/proxy.log

[Install]
WantedBy=default.target
`;
}

/**
 * Register the proxy as a background service.
 * Returns true on success, false on failure.
 */
function registerService(configDir, configPath) {
  try {
    const platform = process.platform;

    // API key is read from config at runtime by compressor.js
    // (no need to bake it into the service definition)

    if (platform === "darwin") {
      // ── macOS: launchd ──
      const launchAgentDir = path.join(HOME, "Library", "LaunchAgents");
      if (!fs.existsSync(launchAgentDir)) {
        fs.mkdirSync(launchAgentDir, { recursive: true });
      }

      const plistPath = path.join(launchAgentDir, "com.supercompress.proxy.plist");
      let plistContent = launchdPlist(configDir, configPath);

      fs.writeFileSync(plistPath, plistContent);
      fs.chmodSync(plistPath, 0o644);

    // Load the service
      try {
        execFileSync("launchctl", ["load", plistPath], { stdio: "ignore" });
      } catch (loadErr) {
        // Try unloading first (in case it's already loaded)
        try {
          execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
        } catch {}
        
        try {
          execFileSync("launchctl", ["load", plistPath], { stdio: "ignore" });
        } catch (e2) {
          console.error(`  ⚠ Could not load launchd service: ${e2.message}`);
          return false;
        }
      }
      
      return true;
    } else if (platform === "linux") {
      // ── Linux: systemd user unit ──
      const systemdDir = path.join(HOME, ".config", "systemd", "user");
      if (!fs.existsSync(systemdDir)) {
        fs.mkdirSync(systemdDir, { recursive: true });
      }

      const unitPath = path.join(systemdDir, "supercompress.service");
      let unitContent = systemdUnit(configDir, configPath);

      fs.writeFileSync(unitPath, unitContent);

      // Enable and start
      try {
        execSync("systemctl --user daemon-reload", { stdio: "ignore" });
        execSync("systemctl --user enable supercompress", { stdio: "ignore" });
        execSync("systemctl --user start supercompress", { stdio: "ignore" });
      } catch (e) {
        console.error(`  ⚠ Could not enable systemd service: ${e.message}`);
        return false;
      }

      return true;
    } else if (platform === "win32") {
      // ── Windows: Create a scheduled task ──
      // For now just log a message (full Windows support coming)
      console.log("  → Windows auto-start is not yet supported.");
      console.log("  → Add a shortcut to `supercompress start` in your Startup folder.");
      return false;
    }

    return false;
  } catch (err) {
    console.error(`  ⚠ Service registration error: ${err.message}`);
    return false;
  }
}

/**
 * Unregister the background service.
 */
function unregisterService() {
  try {
    const platform = process.platform;

    if (platform === "darwin") {
      const plistPath = path.join(HOME, "Library", "LaunchAgents", "com.supercompress.proxy.plist");
      if (fs.existsSync(plistPath)) {
        try { execSync(`launchctl unload ${plistPath}`, { stdio: "ignore" }); } catch {}
        fs.unlinkSync(plistPath);
      }
      return true;
    } else if (platform === "linux") {
      try {
        execSync("systemctl --user stop supercompress", { stdio: "ignore" });
        execSync("systemctl --user disable supercompress", { stdio: "ignore" });
      } catch {}
      const unitPath = path.join(HOME, ".config", "systemd", "user", "supercompress.service");
      if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

module.exports = registerService;
module.exports.unregister = unregisterService;
