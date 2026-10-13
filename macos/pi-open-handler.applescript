-- The app macOS launches when a `pi-open:` link is clicked in a terminal.
--
-- It exists because a URL scheme needs a bundle: LaunchServices delivers a
-- click as an Apple Event, and a bare shell script has nothing to receive one
-- with. Everything the click actually does is in ~/dotfiles/bin/pi-open; this
-- is the doorbell, not the house.
--
-- Built and registered by ~/dotfiles/install.sh into ~/Applications/Pi Open.app.

on open location this_URL
	set opener to (POSIX path of (path to home folder)) & "dotfiles/bin/pi-open"
	try
		do shell script quoted form of opener & " " & quoted form of this_URL
	end try
end open location

-- Launched with no URL — from Finder, or by LaunchServices while it registers.
-- There is nothing for it to do, and saying so in a dialog would be worse.
on run
end run
