# open-files

Joel Nilsson's macOS dotfiles and his harness for the [pi](https://pi.dev/docs) coding agent, published as a snapshot.

- `pi/` is the agent harness: settings, keybindings, agent types, workflows, and `pi/kit`, a pi package of extensions, tools and tests.
- Everything else configures the Mac: aerospace, ghostty, nvim, sketchybar, starship, zsh, a Raycast extension and theme tooling.

`install.sh` links the configs into place. `install.sh --doctor` checks them without changing anything.

The skills that `pi/kit/package.json` points at are not included. Add your own under `pi/kit/skills/`.

This repository is a one-commit snapshot that is replaced on every publish, so it has no history.
