// AgentBoard.app: a small native window around the local AgentBoard dashboard.
// It finds the project folder and Node.js, starts `node agentboard/server.mjs` if
// nothing is answering yet, and shows http://localhost:<port>/ in a WKWebView.
// Build with app/build.sh. `AgentBoard --selftest` checks everything without a window.

import Cocoa
import WebKit

// MARK: - Settings

enum Settings {
    static let defaultPort = 4317
    static let projectKey = "AgentBoardProjectFolder"   // UserDefaults: the folder the user chose
    static let frameName = "AgentBoardMainWindow"

    static var port: Int {
        if let s = ProcessInfo.processInfo.environment["AGENTBOARD_PORT"],
           let p = Int(s.trimmingCharacters(in: .whitespaces)), (1...65535).contains(p) { return p }
        return defaultPort
    }

    static var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AgentBoard/server.log")
    }
    static let logDisplayPath = "~/Library/Logs/AgentBoard/server.log"

    static let pageColor = NSColor(name: NSColor.Name("AgentBoardPage")) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 0x26 / 255.0, green: 0x26 / 255.0, blue: 0x24 / 255.0, alpha: 1)
            : NSColor(srgbRed: 0xfa / 255.0, green: 0xf9 / 255.0, blue: 0xf5 / 255.0, alpha: 1)
    }
}

// MARK: - Project folder

enum Project {
    static func isValid(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: (path as NSString).appendingPathComponent("agentboard/server.mjs"))
    }

    /// Accepts the project folder itself, or the `agentboard` folder inside it.
    static func normalize(_ path: String) -> String? {
        let p = (path as NSString).standardizingPath
        if isValid(p) { return p }
        let parent = (p as NSString).deletingLastPathComponent
        if (p as NSString).lastPathComponent == "agentboard", isValid(parent) { return parent }
        return nil
    }

    static var saved: String? { UserDefaults.standard.string(forKey: Settings.projectKey) }
    static var bundled: String? { Bundle.main.object(forInfoDictionaryKey: "AgentBoardProject") as? String }

    /// The user's choice wins over the path the build script wrote into Info.plist.
    static func resolve() -> (path: String, source: String)? {
        if let s = saved, isValid(s) { return (s, "your chosen folder") }
        if let b = bundled, isValid(b) { return (b, "Info.plist") }
        return nil
    }

    static func save(_ path: String) { UserDefaults.standard.set(path, forKey: Settings.projectKey) }
}

// MARK: - Small process and HTTP helpers

/// Runs a short command and returns its stdout, or nil if it fails or takes too long.
func runCapture(_ executable: String, _ arguments: [String], timeout: TimeInterval) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: executable)
    p.arguments = arguments
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    killer.cancel()
    guard p.terminationReason == .exit, p.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)
}

enum NodeFinder {
    static func find() -> String? {
        let fm = FileManager.default
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where fm.isExecutableFile(atPath: path) { return path }
        // Fall back to the login shell, which knows about other installs on PATH.
        if let out = runCapture("/bin/zsh", ["-lc", "command -v node"], timeout: 6) {
            let lines = out.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            if let path = lines.last(where: { $0.hasPrefix("/") }), fm.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    static func version(_ node: String) -> String? {
        runCapture(node, ["--version"], timeout: 5)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

final class Flag: @unchecked Sendable { var value = false }

enum Health {
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.connectionProxyDictionary = [:]
        c.timeoutIntervalForRequest = 1
        c.urlCache = nil
        return URLSession(configuration: c)
    }()

    /// GET http://127.0.0.1:<port>/health; true only for HTTP 200. Blocking, so never call it on the main thread.
    static func check(port: Int, timeout: TimeInterval = 1) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        let done = DispatchSemaphore(value: 0)
        let ok = Flag()
        let task = session.dataTask(with: request) { _, response, _ in
            ok.value = (response as? HTTPURLResponse)?.statusCode == 200
            done.signal()
        }
        task.resume()
        if done.wait(timeout: .now() + timeout + 0.5) == .timedOut { task.cancel(); return false }
        return ok.value
    }
}

// MARK: - Server

enum Failure {
    case noProject
    case noNode
    case couldNotLaunch(String)
    case notHealthy(exitedEarly: Bool, portBusy: Bool)
    case lostConnection

    var plain: String {
        switch self {
        case .noProject: return "project folder not found (no agentboard/server.mjs)"
        case .noNode: return "Node.js not found"
        case .couldNotLaunch(let why): return "could not launch node: \(why)"
        case .notHealthy(let exited, let busy):
            return busy ? "port \(Settings.port) is used by another program"
                : exited ? "server exited right after starting" : "server did not answer /health within 8 s"
        case .lostConnection: return "dashboard stopped answering"
        }
    }
}

enum Outcome {
    case alreadyRunning
    case started(pid: Int32, seconds: Double)
    case failed(Failure)
}

/// Owns the one server process this app may have started. Methods block; call them off the main thread.
final class ServerManager: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var logHandle: FileHandle?

    func ensureRunning(project: String?, port: Int) -> Outcome {
        if Health.check(port: port) { return .alreadyRunning }
        guard let project else { return .failed(.noProject) }
        guard let node = NodeFinder.find() else { return .failed(.noNode) }
        stop()   // a server of ours that stopped answering

        let fm = FileManager.default
        let logURL = Settings.logURL
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        guard let log = try? FileHandle(forWritingTo: logURL) else {
            return .failed(.couldNotLaunch("can't write \(Settings.logDisplayPath)"))
        }
        let startOffset = log.seekToEndOfFile()
        let stamp = ISO8601DateFormatter().string(from: Date())
        log.write(Data("\n--- \(stamp) AgentBoard.app: \(node) agentboard/server.mjs (port \(port), folder \(project)) ---\n".utf8))

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [(project as NSString).appendingPathComponent("agentboard/server.mjs")]
        p.currentDirectoryURL = URL(fileURLWithPath: project, isDirectory: true)
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        let nodeDir = (node as NSString).deletingLastPathComponent
        env["PATH"] = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = log
        p.standardError = log
        do { try p.run() } catch {
            try? log.close()
            return .failed(.couldNotLaunch(error.localizedDescription))
        }
        lock.lock(); process = p; logHandle = log; lock.unlock()

        let started = Date()
        while Date().timeIntervalSince(started) < 8 {
            if Health.check(port: port, timeout: 0.5) {
                return .started(pid: p.processIdentifier, seconds: Date().timeIntervalSince(started))
            }
            if !p.isRunning { break }
            Thread.sleep(forTimeInterval: 0.15)
        }
        let exitedEarly = !p.isRunning
        stop()
        var portBusy = false
        if let reader = try? FileHandle(forReadingFrom: logURL) {
            try? reader.seek(toOffset: startOffset)
            let tail = String(decoding: reader.readDataToEndOfFile(), as: UTF8.self)
            portBusy = tail.contains("EADDRINUSE") || tail.contains("is busy")
            try? reader.close()
        }
        return .failed(.notHealthy(exitedEarly: exitedEarly, portBusy: portBusy))
    }

    /// Stops the server only if this app started it. Waits up to 3 s, then forces it.
    func stop() {
        lock.lock()
        let p = process, log = logHandle
        process = nil; logHandle = nil
        lock.unlock()
        guard let p else { return }
        if p.isRunning {
            p.terminate()
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL); p.waitUntilExit() }
        }
        try? log?.close()
    }
}

// MARK: - Built-in pages

enum Pages {
    static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    static let style = """
    :root { color-scheme: light dark; --bg:#faf9f5; --fg:#3d3929; --muted:#7a766b; --accent:#c96442;
      --btn:#f0eee6; --line:#e3e0d5; --face:#f3e3d0; --ink:#3d3929; --hair:#3d3929; }
    @media (prefers-color-scheme: dark) { :root { --bg:#262624; --fg:#ecebe4; --muted:#a9a69a; --accent:#d97757;
      --btn:#34332f; --line:#45443f; --face:#e9d6c0; --ink:#2b2724; --hair:#7a5c4c; } }
    html, body { margin:0; height:100%; background:var(--bg); color:var(--fg);
      font:15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; -webkit-user-select:none; cursor:default; }
    main { min-height:100%; box-sizing:border-box; padding:0 32px 40px; display:flex; flex-direction:column;
      align-items:center; justify-content:center; text-align:center; animation:in .45s ease .2s both; }
    @keyframes in { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:none } }
    h1 { font-size:21px; font-weight:600; letter-spacing:-.01em; margin:18px 0 6px; }
    p { margin:0 auto 6px; max-width:470px; color:var(--muted); }
    code { font:12.5px ui-monospace, Menlo, monospace; color:var(--fg); -webkit-user-select:text; }
    a { color:var(--accent); }
    .dots { display:flex; gap:9px; height:24px; align-items:center; }
    .dots span { width:10px; height:10px; border-radius:50%; background:var(--accent); opacity:.25;
      animation:bob 1.2s ease-in-out infinite; }
    .dots span:nth-child(2) { animation-delay:.18s } .dots span:nth-child(3) { animation-delay:.36s }
    @keyframes bob { 0%,100% { opacity:.25; transform:none } 50% { opacity:1; transform:translateY(-5px) } }
    .buttons { margin-top:22px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
    button { font:inherit; font-size:14px; padding:7px 16px; border-radius:8px; border:1px solid var(--line);
      background:var(--btn); color:var(--fg); cursor:pointer; }
    button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    @media (prefers-reduced-motion: reduce) { main, .dots span { animation:none } .dots span { opacity:.6 } }
    """

    static let sleepyFace = """
    <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
      <circle cx="38" cy="40" r="30" fill="var(--face)"/>
      <path d="M8 38 C8 18 22 8 38 8 C55 8 68 18 68 38 C61 30 54 27 47 26 C42 30 33 30 27 25 C21 29 14 32 8 38 Z" fill="var(--hair)"/>
      <path d="M24 44 q4 3 8 0 M44 44 q4 3 8 0" stroke="var(--ink)" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <path d="M34 54 q4 2.5 8 0" stroke="var(--ink)" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    </svg>
    """

    static func page(_ body: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8"><title>AgentBoard</title><style>\(style)</style>
        <script>function post(m){ try { window.webkit.messageHandlers.agentboard.postMessage(m) } catch (e) {} }</script>
        </head><body><main>\(body)</main></body></html>
        """
    }

    static func loading() -> String {
        page("""
        <div class="dots"><span></span><span></span><span></span></div>
        <h1>Opening your office…</h1>
        """)
    }

    static func failure(_ f: Failure, port: Int) -> String {
        let log = "<code>\(esc(Settings.logDisplayPath))</code>"
        let retry = #"<button class="primary" autofocus onclick="post('retry')">Try again</button>"#
        let retrySecondary = #"<button onclick="post('retry')">Try again</button>"#
        let choose = #"<button class="primary" autofocus onclick="post('chooseFolder')">Choose project folder…</button>"#
        let openLog = #"<button onclick="post('openLog')">Open log</button>"#
        let title: String, text: String, buttons: String
        switch f {
        case .noProject:
            title = "AgentBoard can’t find its folder"
            text = "Choose the project folder that has the <b>agentboard</b> folder inside it."
            buttons = choose + retrySecondary
        case .noNode:
            title = "Node.js isn’t installed"
            text = "AgentBoard needs Node.js to run. Install Node.js from <a href=\"https://nodejs.org\">nodejs.org</a>, then try again."
            buttons = retry
        case .couldNotLaunch(let why):
            title = "The office didn’t open"
            text = "AgentBoard couldn’t start its server (\(esc(why))). The log file may say more: \(log)"
            buttons = retry + openLog
        case .notHealthy(let exited, let busy):
            title = "The office didn’t open"
            if busy {
                text = "Another program is already using port \(port), so AgentBoard’s server couldn’t start. Quit that program, then try again."
            } else if exited {
                text = "AgentBoard’s server stopped right after it started. The log file may say why: \(log)"
            } else {
                text = "AgentBoard’s server didn’t answer within 8 seconds. The log file may say why: \(log)"
            }
            buttons = retry + openLog
        case .lostConnection:
            title = "The office isn’t answering"
            text = "The dashboard stopped responding. Try again to restart it. The log file may say why: \(log)"
            buttons = retry + openLog
        }
        return page("\(sleepyFace)<h1>\(title)</h1><p>\(text)</p><div class=\"buttons\">\(buttons)</div>")
    }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let server = ServerManager()
    private let serverQueue = DispatchQueue(label: "app.agentboard.server")
    private let port = Settings.port
    private var project: String?
    private var startupID = 0
    private var showingDashboard = false
    private var autoRetries = 0
    private var offeredFolderPanel = false
    private var builtInHTML = ""

    private var dashboardURL: URL { URL(string: "http://localhost:\(port)/")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
        buildMenus()
        makeWindow()
        startup()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        startupID += 1
        server.stop()
    }

    // MARK: Window

    private func makeWindow() {
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "AgentBoardApp/1.0"
        config.websiteDataStore = .default()   // persistent: localStorage survives restarts
        config.preferences.isElementFullscreenEnabled = true
        config.userContentController.add(self, name: "agentboard")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = Settings.pageColor
        webView.autoresizingMask = [.width, .height]
        webView.alphaValue = 0   // shown after the first page paints, so there is no white flash

        var size = NSSize(width: 1320, height: 860)
        if let visible = NSScreen.main?.visibleFrame.size {
            size.width = max(760, min(size.width, visible.width - 40))
            size.height = max(520, min(size.height, visible.height - 60))
        }
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "AgentBoard"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = Settings.pageColor
        window.contentMinSize = NSSize(width: 760, height: 520)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)

        let container = NSView(frame: NSRect(origin: .zero, size: size))
        webView.frame = container.bounds
        container.addSubview(webView)
        window.contentView = container

        if !window.setFrameUsingName(Settings.frameName) { window.center() }
        window.setFrameAutosaveName(Settings.frameName)
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    private func showBuiltIn(_ html: String) {
        showingDashboard = false
        builtInHTML = html
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func loadDashboard() {
        showingDashboard = true
        webView.load(URLRequest(url: dashboardURL))
    }

    // MARK: Startup

    /// Shows the loading page, makes sure a healthy server is answering, then loads the dashboard.
    private func startup(stopOursFirst: Bool = false) {
        startupID += 1
        let id = startupID
        showBuiltIn(Pages.loading())
        let project = Project.resolve()?.path
        self.project = project
        let port = self.port, server = self.server
        serverQueue.async {
            if stopOursFirst { server.stop() }
            let outcome = server.ensureRunning(project: project, port: port)
            Task { @MainActor in self.finishStartup(id, outcome) }
        }
    }

    private func finishStartup(_ id: Int, _ outcome: Outcome) {
        guard id == startupID else { return }
        switch outcome {
        case .alreadyRunning, .started:
            loadDashboard()
        case .failed(let failure):
            showFailure(failure)
            if case .noProject = failure, !offeredFolderPanel {
                offeredFolderPanel = true
                chooseProjectFolder(nil)
            }
        }
    }

    private func showFailure(_ f: Failure) { showBuiltIn(Pages.failure(f, port: port)) }

    // MARK: Project folder

    @objc func chooseProjectFolder(_ sender: Any?) {
        guard window.attachedSheet == nil else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Choose"
        panel.message = "Choose the project folder that has the “agentboard” folder inside it."
        if let p = project ?? Project.bundled { panel.directoryURL = URL(fileURLWithPath: p) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            MainActor.assumeIsolated { self.useProjectFolder(url.path) }
        }
    }

    private func useProjectFolder(_ path: String) {
        guard let root = Project.normalize(path) else {
            let alert = NSAlert()
            alert.messageText = "That folder doesn’t have AgentBoard in it"
            alert.informativeText = "Choose the folder that contains “agentboard/server.mjs”."
            alert.addButton(withTitle: "Choose Another…")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: window) { response in
                guard response == .alertFirstButtonReturn else { return }
                MainActor.assumeIsolated {
                    // Let the alert sheet finish closing before the panel opens.
                    DispatchQueue.main.async { self.chooseProjectFolder(nil) }
                }
            }
            return
        }
        let changed = root != project
        Project.save(root)
        if changed || !showingDashboard { startup(stopOursFirst: changed) }
    }

    // MARK: Menu actions

    @objc func showProjectInFinder(_ sender: Any?) {
        guard let p = project ?? Project.resolve()?.path else { chooseProjectFolder(nil); return }
        NSWorkspace.shared.open(URL(fileURLWithPath: p, isDirectory: true))
    }

    @objc func openServerLog(_ sender: Any?) {
        let url = Settings.logURL
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        } else {
            note("There’s no server log yet", "AgentBoard writes \(Settings.logDisplayPath) when it starts the dashboard server itself.")
        }
    }

    @objc func openHelp(_ sender: Any?) {
        guard let p = project ?? Project.resolve()?.path else { chooseProjectFolder(nil); return }
        let readme = URL(fileURLWithPath: p).appendingPathComponent("agentboard/README.md")
        if FileManager.default.fileExists(atPath: readme.path) {
            NSWorkspace.shared.open(readme)
        } else {
            note("Help isn’t available", "There’s no README.md in the agentboard folder.")
        }
    }

    @objc func reloadPage(_ sender: Any?) {
        if showingDashboard { webView.reload() } else { startup() }
    }

    private func note(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    // MARK: Script messages from the built-in pages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let command = message.body as? String else { return }
        switch command {
        case "retry": startup()
        case "chooseFolder": chooseProjectFolder(nil)
        case "openLog": openServerLog(nil)
        default: break
        }
    }

    // MARK: Navigation

    private func isLocal(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .allow }
        switch url.scheme?.lowercased() ?? "" {
        case "http", "https":
            if isLocal(url) { return .allow }
            if navigationAction.targetFrame?.isMainFrame ?? true {
                NSWorkspace.shared.open(url)
                return .cancel
            }
            return .allow
        case "about", "data", "blob":
            return .allow
        default:
            NSWorkspace.shared.open(url)   // mailto: and friends
            return .cancel
        }
    }

    /// window.open and target=_blank: localhost stays in this web view, anything else goes to the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isLocal(url) { webView.load(navigationAction.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.alphaValue = 1
        if showingDashboard { autoRetries = 0 }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webView.alphaValue = 1
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }   // load cancelled by our own policy
        webView.alphaValue = 1
        guard showingDashboard else { return }
        if autoRetries < 1 {
            autoRetries += 1
            startup()          // restarts the server if it went away
        } else {
            autoRetries = 0
            showFailure(.lostConnection)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if showingDashboard { webView.reload() } else { webView.loadHTMLString(builtInHTML, baseURL: nil) }
    }

    // MARK: JavaScript dialogs

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }

    // MARK: Menus

    private func buildMenus() {
        let main = NSMenu()

        let app = addSubmenu("AgentBoard", to: main)
        app.addItem(withTitle: "About AgentBoard", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide AgentBoard", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit AgentBoard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = addSubmenu("File", to: main)
        file.addItem(mine("Choose Project Folder…", #selector(chooseProjectFolder(_:))))
        file.addItem(mine("Show Project in Finder", #selector(showProjectInFinder(_:))))
        file.addItem(mine("Open Server Log", #selector(openServerLog(_:))))

        let edit = addSubmenu("Edit", to: main)
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
            .keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = addSubmenu("View", to: main)
        view.addItem(mine("Reload", #selector(reloadPage(_:)), key: "r"))
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.command, .control]

        let windowMenu = addSubmenu("Window", to: main)
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")

        let help = addSubmenu("Help", to: main)
        help.addItem(mine("AgentBoard Help", #selector(openHelp(_:)), key: "?"))

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
        NSApp.helpMenu = help
    }

    private func addSubmenu(_ title: String, to main: NSMenu) -> NSMenu {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        item.submenu = menu
        main.addItem(item)
        return menu
    }

    private func mine(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }
}

// MARK: - Self-test

enum SelfTest {
    static func run() -> Int32 {
        let port = Settings.port
        var ok = true
        print("AgentBoard self-test")
        let project = Project.resolve()
        if let project {
            print("  project: \(project.path) (from \(project.source))")
        } else {
            print("  project: NOT FOUND (Info.plist AgentBoardProject = \(Project.bundled ?? "missing"))")
            ok = false
        }
        if let node = NodeFinder.find() {
            print("  node:    \(node) \(NodeFinder.version(node) ?? "(version unknown)")")
        } else {
            print("  node:    NOT FOUND (install Node.js from nodejs.org)")
            ok = false
        }
        print("  port:    \(port)")
        let server = ServerManager()
        switch server.ensureRunning(project: project?.path, port: port) {
        case .alreadyRunning:
            print("  server:  already running and healthy (left running)")
        case .started(let pid, let seconds):
            print("  server:  started (pid \(pid)), healthy after \(String(format: "%.2f", seconds)) s")
            server.stop()
            if Health.check(port: port) {
                print("  stop:    FAILED, port \(port) still answers")
                ok = false
            } else {
                print("  stop:    stopped the server this test started")
            }
        case .failed(let failure):
            print("  server:  FAILED, \(failure.plain) (log: \(Settings.logDisplayPath))")
            ok = false
        }
        print(ok ? "result:  OK" : "result:  FAILED")
        return ok ? 0 : 1
    }
}

// MARK: - Entry point

@main
struct AgentBoardMain {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--selftest") {
            setvbuf(stdout, nil, _IOLBF, 0)
            exit(SelfTest.run())
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
