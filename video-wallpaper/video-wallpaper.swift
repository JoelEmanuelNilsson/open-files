// video-wallpaper -- a looping video as the desktop.
//
// It plays one video, muted, on every screen, at the desktop's own window
// level: above the desktop picture, below the desktop icons and every window.
// It never decides WHICH video. A theme's `wallpaper` may name a video, and on
// every apply and every appearance flip bin/theme writes that path to
// theme/gen/wallpaper/video -- or empties the file when the wallpaper is an
// image. This process follows that one file, so light/dark, the settle-and-
// reread around the appearance notification, and which theme is current keep
// exactly one owner. See README.md beside this file.
//
//   video-wallpaper --follow FILE        play the video FILE names, for ever
//   video-wallpaper --still VIDEO OUT    write VIDEO's middle frame to OUT (JPEG)
//
// --still is how bin/theme puts a frame of the video under it as the real
// desktop picture, which is what the lock screen, Mission Control and a
// crashed player show. The middle frame, because a loop's seam -- and any
// crossfade baked into it -- sits at the ends.
//
// Threading: everything runs on the main queue. Notifications are delivered
// there, the file watch fires there, and the two KVO callbacks hop there.

import AVFoundation
import AppKit

let fadeSeconds = 1.0

func log(_ message: String) {
    FileHandle.standardError.write(Data("video-wallpaper: \(message)\n".utf8))
}

// MARK: - --still

struct StillError: Error, CustomStringConvertible {
    let description: String
}

func writeStill(of video: URL, to out: URL) async throws {
    let asset = AVURLAsset(url: video)
    let duration = try await asset.load(.duration)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let (image, _) = try await generator.image(at: CMTimeMultiplyByRatio(duration, multiplier: 1, divisor: 2))

    // Written beside OUT and renamed over it, so nothing ever reads half a JPEG.
    let partial = out.deletingLastPathComponent().appendingPathComponent(".\(out.lastPathComponent).tmp-\(getpid())")
    guard let destination = CGImageDestinationCreateWithURL(partial as CFURL, "public.jpeg" as CFString, 1, nil) else {
        throw StillError(description: "cannot create \(partial.path)")
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
        throw StillError(description: "cannot encode \(partial.path)")
    }
    guard rename(partial.path, out.path) == 0 else {
        throw StillError(description: "cannot rename onto \(out.path): \(String(cString: strerror(errno)))")
    }
}

// MARK: - --follow

/// One loaded video: the player every screen's layer shares, and the looper
/// that keeps it going. Held for as long as it is on screen or fading in.
final class Loop {
    let url: URL
    let player = AVQueuePlayer()
    let looper: AVPlayerLooper

    init(url: URL) {
        self.url = url
        player.isMuted = true
        // AVPlayer holds the display awake during playback by default. A
        // wallpaper must never be the reason the screen stays on.
        player.preventsDisplaySleepDuringVideoPlayback = false
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
    }

    func stop() {
        looper.disableLooping()
        player.pause()
        player.removeAllItems()
    }
}

final class Wallpaper: NSObject {
    private let follow: URL
    private var windows: [NSWindow] = []
    /// On screen now.
    private var current: Loop?
    /// Loaded and waiting for its first frame; becomes `current` with a fade.
    private var incoming: Loop?
    private var incomingReady: NSKeyValueObservation?
    private var incomingStatus: NSKeyValueObservation?
    private var watch: DispatchSourceFileSystemObject?

    private var screensAsleep = false
    private var sessionInactive = false
    private var screenLocked = false

    init(follow: URL) {
        self.follow = follow
    }

    func start() {
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(screensDidSleep), name: NSWorkspace.screensDidSleepNotification, object: nil)
        workspace.addObserver(self, selector: #selector(screensDidWake), name: NSWorkspace.screensDidWakeNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionDidResignActive), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionDidBecomeActive), name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
        let distributed = DistributedNotificationCenter.default()
        distributed.addObserver(self, selector: #selector(screenDidLock), name: .init("com.apple.screenIsLocked"), object: nil)
        distributed.addObserver(self, selector: #selector(screenDidUnlock), name: .init("com.apple.screenIsUnlocked"), object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)

        buildWindows()
        watchFollowedDirectory()
        reread()
    }

    // MARK: Following the file

    /// The directory, not the file: bin/theme replaces the file by rename, which
    /// gives it a new inode, so a watch on the file would go deaf after the first
    /// write. A rename inside the directory is a write to the directory.
    private func watchFollowedDirectory() {
        let directory = follow.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else {
            log("cannot watch \(directory.path): \(String(cString: strerror(errno)))")
            exit(1)
        }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .delete, .rename], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, let source = self.watch else { return }
            if !source.data.isDisjoint(with: [.delete, .rename]) {
                // The directory itself was removed or moved (theme/gen wiped).
                // Watch whatever is at the path now.
                source.cancel()
                self.watch = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.watchFollowedDirectory()
                    self.reread()
                }
                return
            }
            self.reread()
        }
        source.setCancelHandler { close(descriptor) }
        watch = source
        source.resume()
    }

    private func reread() {
        let text = (try? String(contentsOf: follow, encoding: .utf8)) ?? ""
        let path = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return show(nil) }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            log("\(url.path) is not readable; leaving the desktop picture")
            return show(nil)
        }
        show(url)
    }

    // MARK: Switching videos

    private func show(_ url: URL?) {
        // Every other write in the directory lands here too; most change nothing.
        if let incoming, incoming.url == url { return }
        if let current, current.url == url {
            dropIncoming()  // flipped back before the other video was ready
            return
        }
        dropIncoming()
        guard let url else { return fadeOut() }

        log("loading \(url.path)")
        let loop = Loop(url: url)
        incoming = loop
        for window in windows { addLayer(for: loop, to: window, opacity: 0) }
        order(front: true)
        // Played before it is ready, whatever the gating says: the first frame
        // is what we wait for. commit() applies the gating straight after.
        loop.player.play()

        let marker = ObjectIdentifier(loop)
        incomingStatus = loop.looper.observe(\.status, options: [.initial, .new]) { [weak self] looper, _ in
            guard looper.status == .failed else { return }
            DispatchQueue.main.async {
                guard let self, let incoming = self.incoming, ObjectIdentifier(incoming) == marker else { return }
                log("cannot play \(url.path): \(looper.error.map { "\($0)" } ?? "unknown error")")
                self.dropIncoming()
                if self.current == nil { self.order(front: false) }
            }
        }
        // Faded in only once a frame is decoded, so a switch never shows black.
        if let layer = layers(of: loop).first {
            incomingReady = layer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
                guard layer.isReadyForDisplay else { return }
                DispatchQueue.main.async {
                    guard let self, let incoming = self.incoming, ObjectIdentifier(incoming) == marker else { return }
                    self.commit(fade: true)
                }
            }
        }
    }

    /// `incoming` becomes `current`: its layers fade in over the outgoing ones,
    /// which are then removed and their player stopped.
    private func commit(fade: Bool) {
        guard let loop = incoming else { return }
        incomingReady = nil
        incomingStatus = nil
        incoming = nil
        let outgoing = current
        current = loop

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            outgoing?.stop()
            if let self, let outgoing { self.removeLayers(of: outgoing) }
        }
        for layer in layers(of: loop) {
            layer.opacity = 1
            if fade {
                let animation = CABasicAnimation(keyPath: "opacity")
                animation.fromValue = 0
                animation.toValue = 1
                animation.duration = fadeSeconds
                layer.add(animation, forKey: "fade")
            }
        }
        CATransaction.commit()
        updatePlayback()
    }

    private func dropIncoming() {
        incomingReady = nil
        incomingStatus = nil
        guard let loop = incoming else { return }
        incoming = nil
        loop.stop()
        removeLayers(of: loop)
    }

    /// Back to the desktop picture: the video fades out, then the windows go.
    private func fadeOut() {
        guard let loop = current else { return order(front: false) }
        current = nil
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            loop.stop()
            guard let self else { return }
            self.removeLayers(of: loop)
            if self.current == nil, self.incoming == nil { self.order(front: false) }
        }
        for layer in layers(of: loop) {
            let animation = CABasicAnimation(keyPath: "opacity")
            animation.fromValue = layer.opacity
            animation.toValue = 0
            animation.duration = fadeSeconds
            layer.opacity = 0
            layer.add(animation, forKey: "fade")
        }
        CATransaction.commit()
    }

    // MARK: Windows and layers

    private func buildWindows() {
        for window in windows {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: window)
            window.orderOut(nil)
        }
        windows = NSScreen.screens.map(makeWindow)
        // A half-finished fade does not survive a screen change; just land it.
        if incoming != nil { commit(fade: false) }
        for window in windows {
            if let current { addLayer(for: current, to: window, opacity: 1) }
        }
        order(front: current != nil)
    }

    private func makeWindow(for screen: NSScreen) -> NSWindow {
        let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.setFrame(screen.frame, display: false)
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = true
        // Clear, not black: a layer still at opacity 0 shows the desktop picture
        // through the window -- the video's own still -- never a black screen.
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        let view = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        view.layer = CALayer()
        view.wantsLayer = true
        window.contentView = view
        NotificationCenter.default.addObserver(self, selector: #selector(occlusionChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
        return window
    }

    private func addLayer(for loop: Loop, to window: NSWindow, opacity: Float) {
        guard let host = window.contentView?.layer else { return }
        let layer = AVPlayerLayer(player: loop.player)
        layer.frame = host.bounds
        layer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        layer.videoGravity = .resizeAspectFill
        layer.opacity = opacity
        host.addSublayer(layer)
    }

    private func layers(of loop: Loop) -> [AVPlayerLayer] {
        windows.flatMap { window in
            (window.contentView?.layer?.sublayers ?? []).compactMap { $0 as? AVPlayerLayer }.filter { $0.player === loop.player }
        }
    }

    private func removeLayers(of loop: Loop) {
        for layer in layers(of: loop) { layer.removeFromSuperlayer() }
    }

    private func order(front: Bool) {
        for window in windows {
            if front { window.orderFrontRegardless() } else { window.orderOut(nil) }
        }
        updatePlayback()
    }

    // MARK: Playing only while someone can see it

    private func updatePlayback() {
        guard let current else { return }
        let seen = windows.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
        if seen, !screensAsleep, !sessionInactive, !screenLocked {
            current.player.play()
        } else {
            current.player.pause()
        }
    }

    @objc private func occlusionChanged() { updatePlayback() }
    @objc private func screensDidSleep() { screensAsleep = true; updatePlayback() }
    @objc private func screensDidWake() { screensAsleep = false; updatePlayback() }
    @objc private func sessionDidResignActive() { sessionInactive = true; updatePlayback() }
    @objc private func sessionDidBecomeActive() { sessionInactive = false; updatePlayback() }
    @objc private func screenDidLock() { screenLocked = true; updatePlayback() }
    @objc private func screenDidUnlock() { screenLocked = false; updatePlayback() }
    @objc private func screensChanged() { buildWindows() }
}

// MARK: - main

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "--still" where arguments.count == 3:
    let video = URL(fileURLWithPath: arguments[1])
    let out = URL(fileURLWithPath: arguments[2])
    Task {
        do {
            try await writeStill(of: video, to: out)
            exit(0)
        } catch {
            log("--still \(video.path): \(error)")
            exit(1)
        }
    }
    dispatchMain()
case "--follow" where arguments.count == 2:
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let wallpaper = Wallpaper(follow: URL(fileURLWithPath: arguments[1]))
    wallpaper.start()
    app.run()
default:
    log("usage: video-wallpaper --follow FILE | --still VIDEO OUT.jpg")
    exit(64)
}
