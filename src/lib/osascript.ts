/**
 * The two AppleScripts this app runs, and the one place it shells out.
 *
 * Both are constants. Neither interpolates anything — the focus script takes its
 * target as a run argument, so a tty from an HTTP request is never spliced into
 * script text.
 */

/**
 * Every iTerm2 session as `window`, `tab`, `tty`, `name`, tab-delimited.
 *
 * The `is running` guard matters: a bare `tell application "iTerm2"` *launches*
 * iTerm2 if it isn't open, so a dashboard poll would start a terminal for you.
 * Checking the property first doesn't.
 */
export const LIST_ITERM_SESSIONS = `set TB to (ASCII character 9)
if not (application "iTerm2" is running) then return ""
set out to ""
tell application "iTerm2"
repeat with w from 1 to count of windows
repeat with t from 1 to count of tabs of window w
repeat with s in sessions of tab t of window w
set out to out & w & TB & t & TB & (tty of s) & TB & (name of s) & linefeed
end repeat
end repeat
end repeat
end tell
return out`;

/**
 * Brings the session on a given tty to the front, and reports whether it found
 * one. The tty arrives as `item 1 of argv`, never as part of this string.
 *
 * Selecting a window, tab and pane is the whole of its power: it cannot type
 * into a terminal or run anything.
 */
export const FOCUS_ITERM_SESSION = `on run argv
set targetTty to item 1 of argv
if not (application "iTerm2" is running) then return "not-running"
tell application "iTerm2"
repeat with w from 1 to count of windows
repeat with t from 1 to count of tabs of window w
repeat with s in sessions of tab t of window w
if (tty of s) is targetTty then
select s
select tab t of window w
select window w
activate
return "focused"
end if
end repeat
end repeat
end repeat
end tell
return "not-found"
end run`;
