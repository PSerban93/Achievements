"use strict";
const path = require("path");

// Native executables keep their existing spawn path. Batch files need cmd.exe;
// pass paths/arguments through environment variables so literal &, %, !, ^ and
// parentheses in a game directory never become shell instructions.
function scriptLaunch(executable, args = [], env = process.env) {
  if (process.platform !== "win32") return null;
  const extension = path.extname(executable).toLowerCase();
  if (extension === ".ps1") return { executable: path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", executable, ...args], env };
  if (![".bat", ".cmd"].includes(extension)) return null;
  if ([executable, ...args].some(v => /["\r\n\0]/.test(String(v)))) throw new Error("Unsupported quote or newline in batch launch argument");
  const variables = { ...env, ACHIEVEMENTS_LAUNCH_SCRIPT: executable };
  const refs = args.map((value, i) => { variables[`ACHIEVEMENTS_LAUNCH_ARG_${i}`] = String(value); return `"%ACHIEVEMENTS_LAUNCH_ARG_${i}%"`; });
  return { executable: path.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/v:off", "/s", "/c", `""%ACHIEVEMENTS_LAUNCH_SCRIPT%"${refs.length ? " " + refs.join(" ") : ""}"`], env: variables,
    windowsVerbatimArguments: true };
}
module.exports = { scriptLaunch };
