# What a reader can do on the page

You don't need this to write a review. It answers questions about the page's controls.

- **Navigation:** a rail with the reading list (current chapter highlighted), findings by severity,
  and a file tree. A split file has numbered part links in its tree row and in each part's header.
  Jumping into a collapsed `details.more` opens it first.
- **Progress:** "Viewed" boxes per file part (a split file counts as viewed once every part is),
  "Mark as read" per chapter, and remembered "Copied" state on findings. All of it stays in the
  viewer's browser. Each chapter's bar ("Chapter N of M" and "Mark as read") sticks to the top of
  the screen for the whole chapter, above the file headers, and shows the chapter's title once the
  heading has scrolled away. A closing card after the last chapter lists the files still to view,
  the findings not yet copied, the chapters marked read, and the next PR from the stack strip.
- **View:** buttons at the top of the rail make room for the diff. Contents hides the rail, Notes
  hides the right-hand notes column, Split shows each diff side by side, old on the left and new on
  the right, and Steps (on a page with a walkthrough) hides the step markers and notes. With the
  rail hidden, the buttons stay as a narrow column with the chapter numbers under them (current
  chapter boxed, read chapters green, a dot for findings, the title on hover), and each step whose
  notes are hidden shows a "Notes hidden, Show notes" button. The choices stay in the viewer's
  browser. Each button works only where it has something to do: Contents from 981px, Notes from
  1360px, where the notes are a column, and Split when the code column is 900px or wider. Below
  that the diff is unified and the button says why.
- **Split view:** a removed run is paired line by line with the added run after it, findings stay
  under their line at full width, step markers stay on the new side, and a new file, a deleted
  file, or a context block stays single-column. Hovering a step lights the half it covers: the new
  side, and the old side only for the removed lines the step replaces, each with its own bar.
- **Walkthroughs:** from 1360px each step's note sits in the side column level with its marker,
  pushed down only when the note above needs the room. Narrower, the notes are a numbered list
  above the code. Hovering a note or a marker highlights the step's lines.
- **Keys:** j/k next or previous file, n/p next or previous finding, v toggles Viewed for the file at
  the top, c hides or shows the contents, t the notes, w the walkthrough, and s switches between
  split and unified. The rail's Keys box has a switch that turns single-key shortcuts off.
- **Copying and links:** "Copy path" in every file header. Clicking a new-side line number copies
  `path:line`, which VS Code's Quick Open (Ctrl+P) and its terminal both open at that line. With
  `pr.json`, the build links the PR ("#N on GitHub" chip), each file header (the PR's files view, or
  the blob at head for a context block), and each finding ("Open line on GitHub").
- **Verdict:** the heading reads "Verdict" plus the decision, coloured by it, and unconfirmed checks
  (`li.no`) lead the checked list.
