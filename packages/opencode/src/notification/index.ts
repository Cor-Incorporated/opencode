import { platform } from "os"
import { Process } from "@/util/process"
import { which } from "@/util/which"

const APPS = new Set([
  "terminal",
  "terminalapp",
  "iterm",
  "iterm2",
  "warp",
  "alacritty",
  "kitty",
  "ghostty",
  "wezterm",
  "hyper",
  "tabby",
  "wave",
  "tmux",
  "zellij",
  "visualstudiocode",
  "visualstudiocodeinsiders",
  "code",
  "codeinsiders",
  "cursor",
  "vscodium",
  "windsurf",
])

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function escapeForOsascript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function terminal(name: string) {
  return APPS.has(norm(name))
}

export function xml(title: string, message: string) {
  return `<toast><visual><binding template='ToastText02'><text id='1'>${escapeXml(title)}</text><text id='2'>${escapeXml(message)}</text></binding></visual></toast>`
}

export namespace Notification {
  export async function terminalIsFocused(): Promise<boolean> {
    if (platform() !== "darwin") return false

    const result = await Process.text(
      [
        "osascript",
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ],
      { nothrow: true },
    )
    return terminal(result.text.trim())
  }

  export async function show(title: string, message: string): Promise<void> {
    const os = platform()

    if (os === "darwin") {
      const escaped = escapeForOsascript(message)
      const titleEscaped = escapeForOsascript(title)
      await Process.run(
        [
          "osascript",
          "-e",
          `tell application "Terminal" to display notification "${escaped}" with title "${titleEscaped}"`,
        ],
        { nothrow: true },
      )
      return
    }

    if (os === "linux") {
      if (which("notify-send")) {
        await Process.run(["notify-send", "--app-name=opencode", title, message], { nothrow: true })
        return
      }
      if (which("notify")) {
        await Process.run(["notify", title, message], { nothrow: true })
        return
      }
      return
    }

    if (os === "win32") {
      const proc = Process.spawn(
        [
          "powershell.exe",
          "-NonInteractive",
          "-NoProfile",
          "-Command",
          [
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
            "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
            "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
            "$xml.LoadXml([Console]::In.ReadToEnd())",
            "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
            '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("opencode").Show($toast)',
          ].join("; "),
        ],
        {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        },
      )
      if (!proc.stdin) return
      proc.stdin.write(xml(title, message))
      proc.stdin.end()
      await proc.exited.catch(() => {})
      return
    }
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
