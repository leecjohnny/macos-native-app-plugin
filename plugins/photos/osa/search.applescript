on run argv
    set needle to item 1 of argv
    if needle is "" then error "Empty search"
    tell application "Photos" to search for needle
end run
