import AppKit
import Foundation

private let serviceLabel = "com.glab.local-agent"

private struct ServiceState {
    let installed: Bool
    let running: Bool
    let pid: String?
}

final class GLABAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "正在检查服务…", action: nil, keyEquivalent: "")
    private let startItem = NSMenuItem(title: "启动服务", action: #selector(startService), keyEquivalent: "")
    private let stopItem = NSMenuItem(title: "停止服务", action: #selector(stopService), keyEquivalent: "")
    private let restartItem = NSMenuItem(title: "重新启动服务", action: #selector(restartService), keyEquivalent: "")
    private let uninstallItem = NSMenuItem(title: "卸载后台服务（取消登录自启）", action: #selector(uninstallService), keyEquivalent: "")
    private var busy = false
    private var timer: Timer?

    private var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(serviceLabel).plist")
    }

    private var logsURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/GLAB")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "GLAB"
        statusItem.button?.toolTip = "GLAB 本地代理服务"

        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        for item in [startItem, stopItem, restartItem, uninstallItem] {
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let logsItem = NSMenuItem(title: "打开日志文件夹", action: #selector(openLogs), keyEquivalent: "")
        logsItem.target = self
        menu.addItem(logsItem)
        let quitItem = NSMenuItem(title: "退出菜单栏 App（服务继续运行）", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu

        refreshStatus()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    private func state() -> ServiceState {
        let installed = FileManager.default.fileExists(atPath: plistURL.path)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["print", "gui/\(getuid())/\(serviceLabel)"]
        let output = Pipe()
        task.standardOutput = output
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
            guard task.terminationStatus == 0 else {
                return ServiceState(installed: installed, running: false, pid: nil)
            }
            let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let pid = text.range(of: #"\bpid = (\d+)"#, options: .regularExpression)
                .map { String(text[$0]).replacingOccurrences(of: "pid = ", with: "") }
            return ServiceState(installed: installed, running: pid != nil, pid: pid)
        } catch {
            return ServiceState(installed: installed, running: false, pid: nil)
        }
    }

    private func refreshStatus() {
        guard !busy else { return }
        let current = state()
        statusLine.title = current.running ? "服务运行中 · PID \(current.pid ?? "?")" :
            (current.installed ? "服务已停止 · 登录时会自动启动" : "服务未安装")
        statusItem.button?.toolTip = "GLAB · \(statusLine.title)"
        startItem.title = current.installed ? "启动服务" : "安装并启动服务"
        startItem.isEnabled = !current.running
        stopItem.isEnabled = current.running
        restartItem.isEnabled = current.installed
        uninstallItem.isEnabled = current.installed
    }

    private func runService(_ command: String) {
        guard !busy else { return }
        guard let resources = Bundle.main.resourceURL else { return }
        busy = true
        statusLine.title = "正在\(command == "install" ? "安装" : command == "uninstall" ? "卸载" : "操作")服务…"
        for item in [startItem, stopItem, restartItem, uninstallItem] { item.isEnabled = false }

        let node = resources.appendingPathComponent("runtime/node")
        let script = resources.appendingPathComponent("cli/service.js")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let task = Process()
            task.executableURL = node
            task.arguments = [script.path, command]
            let output = Pipe()
            task.standardOutput = output
            task.standardError = output
            var errorMessage: String?
            do {
                try task.run()
                task.waitUntilExit()
                let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                if task.terminationStatus != 0 { errorMessage = text.isEmpty ? "服务操作失败（退出码 \(task.terminationStatus)）" : text }
            } catch {
                errorMessage = error.localizedDescription
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                self.refreshStatus()
                if let errorMessage {
                    let alert = NSAlert()
                    alert.messageText = "GLAB 服务操作失败"
                    alert.informativeText = errorMessage
                    alert.alertStyle = .warning
                    NSApp.activate(ignoringOtherApps: true)
                    alert.runModal()
                }
            }
        }
    }

    @objc private func startService() {
        runService(FileManager.default.fileExists(atPath: plistURL.path) ? "start" : "install")
    }

    @objc private func stopService() { runService("stop") }
    @objc private func restartService() { runService("restart") }

    @objc private func uninstallService() {
        let alert = NSAlert()
        alert.messageText = "卸载 GLAB 后台服务？"
        alert.informativeText = "服务将停止，且下次登录不再自动启动。日志和 Skills 文件会保留。"
        alert.addButton(withTitle: "卸载")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { runService("uninstall") }
    }

    @objc private func openLogs() {
        try? FileManager.default.createDirectory(at: logsURL, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logsURL)
    }

    @objc private func quitApp() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = GLABAppDelegate()
app.delegate = delegate
app.run()
