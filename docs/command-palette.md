# The command palette

Everything you can do on a SimpleTab page, you can also do from the command palette. A page button and its command do exactly the same thing.

## Opening it

Press **F1** (or **Ctrl+Shift+P**) and type part of what you want: "ballot", "venue", "draw", "open results". SimpleTab's commands all start with **SimpleTab:**. The palette only lists a command when it applies. For example, "Unlock a draw" appears only when a draw is locked.

## Answering its questions

A command asks for what it needs, one question at a time, in the same order as the page's form:

- **Choosing:** a round, a room, a team or an adjudicator. Type to filter the list, then press Enter.
- **Typing:** a name or a score. When you edit something, the box is pre-filled with the current value. Press Enter to keep it.
- **Yes or no:** shown as two choices, with the current answer first.
- **Choosing several:** for example, conflicts or a panel. Pick one item at a time; picking a chosen item again removes it. Choose **Done choosing** to finish. Editing starts from the current choices.
- **Files:** a CSV to import, or a tournament to open. These open the usual file dialog.

If you type something the page would not accept, such as a word where a number goes or a blank required field, the question is asked again and says why.

Press **Escape** at any question to stop. Nothing is changed.

## Confirmations

The palette asks before anything that cannot easily be undone. This includes some things the page does without asking, because in the palette you cannot see what you are about to change:

- deleting a team, adjudicator, venue or institution;
- regenerating every participant link;
- removing a saved credential;
- discarding a ballot;
- clearing a break;
- undoing a change;
- leaving the host;
- removing an extension;
- restarting SimpleTab.

## When something is refused

If the host refuses a command, the palette shows the reason in a message at the bottom right. The page would show the same reason. For example: the scores are out of range, you do not have permission, or someone else changed the record first.

## Opening pages

Every page has an **Open the … page** command, such as "SimpleTab: Open the Draw page". They are the same as the buttons in the SimpleTab bar.
