# video-wallpaper

A looping video as the desktop. A theme's `wallpaper` may name a video
(`.mov`, `.mp4`, `.m4v`); this plays it, muted, on every screen, at the
desktop's window level — above the desktop picture, below the icons and every
window.

It never decides which video. `bin/theme` does, on every apply and every
appearance flip, and writes the answer to `theme/gen/wallpaper/video`: the
video's path, or nothing when the wallpaper is an image. This process follows
that one file. Light/dark, the settle-and-reread around the appearance
notification, and which theme is current keep one owner.

```
video-wallpaper --follow FILE        play the video FILE names, for ever
video-wallpaper --still VIDEO OUT    write VIDEO's middle frame to OUT (JPEG)
```

## How a switch looks

1. `bin/theme` sets the video's middle frame (`--still`, cached in
   `theme/gen/wallpaper/`) as the real desktop picture. That is what the lock
   screen, Mission Control and a dead player show.
2. It replaces `theme/gen/wallpaper/video` by rename. The player watches the
   directory — a watch on the file would go deaf after the first rename, which
   gives the file a new inode.
3. The player loads the new video under the old one and fades it in over 1 s,
   once its first frame is decoded, so a switch never shows black. An empty file
   fades the video out and hides the windows.

## Power

Muted, and it never holds the display awake (AVPlayer does by default). It
pauses while no part of the desktop is visible, while the screens sleep, while
the screen is locked and while another user session is active.

## Files

- `video-wallpaper.swift` — the whole program.
- `Info.plist` — linked into the binary's `__info_plist` section, so the bare
  executable has a bundle id (`com.joel.video-wallpaper`) and no Dock icon.
- `com.joel.video-wallpaper.plist` — the LaunchAgent. `KeepAlive`: it holds no
  state, so a restart reads the file and carries on. Log:
  `~/.cache/video-wallpaper.log`.

`install.sh` builds it when the source is newer than the binary (gitignored),
restarts the agent, and links and loads the LaunchAgent.

## Limits

- A loop is only as seamless as the file. The player loops the whole file with
  no gap; a seam baked into the video stays.
- Videos stay out of git. They live in `~/Pictures/wallpapers`, and a setup
  names them by absolute or `~` path.
