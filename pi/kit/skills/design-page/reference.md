# Reference: pictures, panels, words

Read at plan time. The template carries the machinery; this file carries the choices.

## Picture kinds

Pick from these. A picture that would fit a neighbouring subject unchanged is too generic.

- Story: one concrete thing travels left to right through three to five frames, one sentence and one change per frame. The reader follows the thing, not the system. The default when a picture fails the mom test.
- Instance: one real thing shown whole, its parts clickable to their meaning. Concrete before any rule. Opens the page.
- Flow: stations left to right, what crosses each seam drawn as a lane sized to its count. What does not cross stops at the line, visibly.
- Structure: dependencies as a laid-out graph with arrows; a folder as a tree with a one-line job per entry; calls as a sequence diagram. Real SVG, never a monospace block or a sentence of arrows. When the picture contradicts a rule (an arrow that should not exist), draw it and label it; never tidy it away.
- Multiples: the same picture across a parameter in a grid, so where it breaks is visible as a shape.
- Variable: one control the reader moves; only the picture reacts.
- Breaks: for a bulletproof-system question, one row per failure mode: what fails, how you would notice, what the system does, what it cannot do.
- Options: two or three choices side by side, what each trades away in one line, the recommendation marked. Followed by an Answer block, so Joel's pick comes back naming the question.
- Variants: when the picture's shape is itself the question, two or three genuinely different versions behind a picker. Two that differ only in colour are one.
- Bet: the reader predicts, the page reveals. Once per page, where the surprise matters.

## The panel behind every term

Every term, box and number on the page is clickable and opens a panel with its entry. The entry answers the same questions every time, in plain words, so Joel is never left with a question mark:

- what: what it is, in one sentence a stranger follows.
- why-named: why it has that name.
- where: the path.
- format: what shape, how big, with the command that measured it.
- how-we-work: the command or the move.
- worry: what goes wrong, and whether Joel should care.

A station adds: how, size (lines, language), built, drawbacks, decided, open. A number adds its so-what: what it means that it is that size. A thing you could not find gets an `unknown` key saying so; never a guess.

## Words on the page

Headings are sentences a stranger understands: "How do you turn a web page you do not own into code you do?" Plain words, short sentences, one thread. Words label pictures; a block that needs a paragraph is the wrong block. Every number sits inside the component it belongs to, tagged `derived` with its command or `said`. If a sentence says what the picture shows, cut the sentence.

## The mom test

Cover the words and look at each picture. Say what it shows. If you need the caption, rebuild it as a Story. Then the studio-lead pass from `frontend-design.md`: would this be mistaken for a template? Remove one accessory.
