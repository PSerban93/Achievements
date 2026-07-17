const { execFile } = require("child_process");
const path = require("path");

function resolvePowerShellPath() {
  if (process.env.SystemRoot) {
    return path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }
  return "powershell.exe";
}

const PICKER_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "[System.Windows.Forms.Application]::EnableVisualStyles();",
  "$dialog = New-Object System.Windows.Forms.OpenFileDialog;",
  "$dialog.Title = $env:ACH_PICKER_TITLE;",
  "$dialog.Filter = 'Programs and shortcuts (*.exe;*.lnk)|*.exe;*.lnk|All files (*.*)|*.*';",
  "$dialog.CheckFileExists = $true;",
  "$dialog.Multiselect = $false;",
  "$dialog.RestoreDirectory = $true;",
  "$dialog.DereferenceLinks = $false;",
  "if ($env:ACH_PICKER_INITIAL_DIRECTORY -and [System.IO.Directory]::Exists($env:ACH_PICKER_INITIAL_DIRECTORY)) { $dialog.InitialDirectory = $env:ACH_PICKER_INITIAL_DIRECTORY; }",
  "if ($env:ACH_PICKER_FILE_NAME) { $dialog.FileName = $env:ACH_PICKER_FILE_NAME; }",
  "$result = $dialog.ShowDialog();",
  "if ($result -ne [System.Windows.Forms.DialogResult]::OK) { Write-Output 'CANCEL'; exit 0; }",
  "$bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.FileName);",
  "Write-Output ('SELECTED:' + [System.Convert]::ToBase64String($bytes));",
].join(" ");

function parsePickerOutput(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const resultLine = lines.findLast(
    (line) => line === "CANCEL" || line.startsWith("SELECTED:"),
  );
  if (resultLine === "CANCEL") {
    return { canceled: true, filePath: "" };
  }
  if (!resultLine?.startsWith("SELECTED:")) {
    throw new Error("Windows file picker returned no selection result");
  }
  const encodedPath = resultLine.slice("SELECTED:".length);
  const filePath = Buffer.from(encodedPath, "base64").toString("utf8").trim();
  if (!filePath) {
    throw new Error("Windows file picker returned an empty path");
  }
  return { canceled: false, filePath };
}

function pickWindowsExecutableOrShortcut({
  title = "Select executable or shortcut",
  initialDirectory = "",
  fileName = "",
} = {}) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows file picker is only available on Windows"));
  }
  const encodedScript = Buffer.from(PICKER_SCRIPT, "utf16le").toString("base64");
  const env = {
    ...process.env,
    ACH_PICKER_TITLE: String(title || ""),
    ACH_PICKER_INITIAL_DIRECTORY: String(initialDirectory || ""),
    ACH_PICKER_FILE_NAME: String(fileName || ""),
  };
  return new Promise((resolve, reject) => {
    execFile(
      resolvePowerShellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encodedScript,
      ],
      {
        env,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || error).trim();
          reject(new Error(detail || "Windows file picker failed"));
          return;
        }
        try {
          resolve(parsePickerOutput(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

module.exports = {
  parsePickerOutput,
  pickWindowsExecutableOrShortcut,
};
