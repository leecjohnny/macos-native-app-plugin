on run argv
	set theOp to item 1 of argv
	set acctId to item 2 of argv
	set boxPath to item 3 of argv
	set theValue to item 4 of argv
	set ids to {}
	if (count of argv) > 4 then set ids to items 5 thru -1 of argv
	set out to {}
	tell application "Mail"
		if theOp is "ensure-archive" then
			set acct to account id acctId
			try
				set found to exists mailbox boxPath of acct
			on error
				set found to false
			end try
			if found then return "exists"
			make new mailbox with properties {name:boxPath} at acct
			return "created"
		end if
		try
			set acct to account id acctId
			set src to mailbox boxPath of acct
		on error errText
			repeat with n in ids
				set end of out to "error" & tab & (n as text) & tab & (my clean(errText))
			end repeat
			set AppleScript's text item delimiters to linefeed
			return out as text
		end try
		repeat with k from 1 to count of ids
			set n to (item k of ids) as text
			try
				try
					set m to first message of src whose id is (n as integer)
				on error
					error "message " & n & " not found in " & boxPath
				end try
				if theOp is "read" then
					set read status of m to (theValue is "true")
				else if theOp is "flagged" then
					set flagged status of m to (theValue is "true")
				else if theOp is "junk" then
					set junk mail status of m to (theValue is "true")
				else if theOp is "move" then
					move m to mailbox theValue of acct
				else if theOp is "copy" then
					duplicate m to mailbox theValue of acct
				else if theOp is "trash" then
					delete m
				else
					error "unknown op " & theOp
				end if
				set end of out to "ok" & tab & n
			on error errText
				set end of out to "error" & tab & n & tab & (my clean(errText))
			end try
		end repeat
	end tell
	set AppleScript's text item delimiters to linefeed
	return out as text
end run

on clean(t)
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to {return, linefeed, tab}
	set parts to text items of (t as text)
	set AppleScript's text item delimiters to space
	set joined to parts as text
	set AppleScript's text item delimiters to saved
	return joined
end clean
