# Written by `npm run tapes` from the task-detail scene in src/demo/scenes.ts:
# change the scene, not this tape. `npm run media:vhs` records it.
Output docs/media/task-detail.gif

Require node

Set FontSize 14
Set Width 1060
Set Height 640
Set Padding 16
Set Theme {"name":"agents-factory","black":"#1a1a1a","red":"#f07575","green":"#53c67d","yellow":"#fab338","blue":"#7fa7c9","magenta":"#d28c79","cyan":"#7fc4b8","white":"#ffffff","brightBlack":"#999999","brightRed":"#f07575","brightGreen":"#9fce7e","brightYellow":"#fab338","brightBlue":"#7fa7c9","brightMagenta":"#d28c79","brightCyan":"#7fc4b8","brightWhite":"#ffffff","background":"#1a1a1a","foreground":"#ffffff","cursor":"#9fce7e","selectionBackground":"#333333"}
Env FORCE_COLOR "3"

Hide
Type "node src/demo/demo.ts"
Enter
Sleep 3s
Show
Sleep 1500ms
Down
Sleep 1200ms
Enter
Sleep 3500ms
Escape
Sleep 1200ms
Up
Sleep 1200ms
Enter
Sleep 1200ms
Enter
Sleep 2500ms
Type@90ms "Only 5xx and timeouts. Never 4xx."
Sleep 500ms
Enter
Sleep 4000ms
Hide
Ctrl+C
