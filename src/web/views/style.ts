/**
 * Inlined into every page: no static files, no build step. The rationale for every token and component is
 * in docs/design-language.md; the short version is that colour is a call to action, never a fact about the
 * data, and the signal blue means exactly one thing: this is waiting on you.
 */
export const STYLE = `
:root{color-scheme:light dark;--paper:#f5f3ee;--surface:#fdfcf9;--hover:#f0ede5;--rule:#e3dfd5;--rule-s:#d2cdc0;--edge:#8c877a;
--ink:#1a1915;--ink-2:#524f46;--ink-3:#6b675c;--signal:#2a4bd1;--on-signal:#fff;--signal-wash:#e8ecfb;
--warn:#b83c08;--on-warn:#fff;--warn-wash:#fdf0e8;--ok:#1b5a44;--ok-wash:#e2f0e9;--btn-hover:#38362e}
@media(prefers-color-scheme:dark){:root{--paper:#151411;--surface:#1e1d19;--hover:#26241f;--rule:#2f2d27;--rule-s:#3a3830;--edge:#7a7669;
--ink:#ece9e0;--ink-2:#b6b2a5;--ink-3:#9a968a;--signal:#98a9ff;--on-signal:#0c1233;--signal-wash:#1d2342;
--warn:#ff9a6a;--on-warn:#2a0f03;--warn-wash:#34201a;--ok:#74cdab;--ok-wash:#1a2b25;--btn-hover:#fff}}
@media(min-width:1600px){html{font-size:17px}}
@media(min-width:2200px){html{font-size:18px}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:400 .9375rem/1.4667 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Helvetica Neue",sans-serif}
.sprite{position:absolute}
.g{flex:none;display:block}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--edge);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-color:var(--ink)}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.frame{max-width:64rem;margin:0 auto;padding:3rem 1.5rem 4.5rem}
.col{max-width:42rem}
header{max-width:42rem;margin-bottom:2rem}
nav{display:flex;flex-wrap:wrap;gap:0 1.5rem;align-items:baseline}
nav a.brand{color:var(--ink);font-weight:600;margin-right:.5rem}
nav a{display:inline-flex;flex-direction:column;align-items:flex-start;white-space:nowrap;color:var(--ink-3);text-decoration:none;padding:.25rem 0}
/* the bold current item would widen by a few px and nudge its neighbours: reserve its bold width on every item */
nav a::after{content:attr(data-t);font-weight:600;height:0;overflow:hidden;visibility:hidden}
nav a:hover{color:var(--ink)}
nav a[aria-current]{color:var(--ink);font-weight:600;box-shadow:0 2px 0 var(--ink)}
nav .add{margin-left:auto}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn);margin-left:.375rem;vertical-align:.1em}
h1{font-size:1.375rem;line-height:1.25;font-weight:600;margin:0;text-wrap:balance;overflow-wrap:break-word}
h1.big{font-size:1.75rem;line-height:2rem}
h2{font-size:1.0625rem;line-height:1.4;font-weight:600;margin:2rem 0 .5rem}
h3{font-size:.9375rem;line-height:1.4667;font-weight:600;margin:0}
.head{display:flex;align-items:baseline;gap:1rem;justify-content:space-between}
.lede{color:var(--ink-2);margin:.25rem 0 1.5rem}
.sec{font-size:.8125rem;line-height:1.3846;font-weight:600;color:var(--ink-3);margin:2rem 0 .5rem}
.meta{font-size:.8125rem;line-height:1.3846;color:var(--ink-3)}
.mono{font:400 .8125rem/1.3846 ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:slashed-zero;white-space:nowrap}
.sel{position:relative;z-index:1;-webkit-user-select:all;user-select:all}
.empty{color:var(--ink-3)}
time{font-variant-numeric:tabular-nums}
.t-signal{color:var(--signal);--bar:var(--signal)}.t-warn{color:var(--warn);--bar:var(--warn)}.t-ok{color:var(--ok);--bar:var(--ok)}.t-2{color:var(--ink-2);--bar:var(--ink-2)}.t-3{color:var(--ink-3);--bar:var(--ink-3)}

/* status: glyph + word. Solid and outlined labels are the only containers on the site. */
.st{display:inline-flex;align-items:center;gap:.375rem;font-size:.8125rem;line-height:1.3846;font-weight:600;white-space:nowrap}
.st.quiet{font-weight:400}
.b{display:inline-flex;align-items:center;gap:.375rem;height:1.5rem;padding:0 .625rem 0 .5rem;border:1px solid transparent;border-radius:4px;font-size:.8125rem;font-weight:600;white-space:nowrap}
.b.solid.t-signal{background:var(--signal);color:var(--on-signal)}
.b.solid.t-warn{background:var(--warn);color:var(--on-warn)}
.b.outline{border-color:currentColor}

/* buttons and fields */
button,input,select{font:inherit;color:var(--ink)}
button{font-size:.8125rem;font-weight:600;height:2rem;padding:0 .75rem;border:1px solid var(--edge);border-radius:6px;background:var(--surface);cursor:pointer;transition:background-color .1s}
button:hover{background:var(--hover)}
button.pri{height:2.25rem;background:var(--ink);color:var(--paper);border-color:var(--ink)}
button.pri:hover{background:var(--btn-hover)}
button.link{border:0;background:none;color:var(--ink-2);padding:0 .25rem;text-decoration:underline;text-decoration-color:var(--edge);text-underline-offset:3px}
input,select{height:2.25rem;padding:0 .75rem;border:1px solid var(--edge);border-radius:6px;background:var(--surface);max-width:100%}
input:hover,select:hover{border-color:var(--ink-3)}
input:user-invalid{border-color:var(--warn);box-shadow:inset 0 0 0 1px var(--warn)}
::placeholder{color:var(--ink-3);opacity:1}
label{display:block;font-size:.8125rem;line-height:1.3846;font-weight:600;color:var(--ink-2)}
label input,label select{display:block;width:100%;margin-top:.25rem;font-size:.9375rem;font-weight:400}
.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;max-width:28rem}
.fields .wide{grid-column:1/-1}
.fields .hint{margin:.25rem 0 0;font-weight:400}
/* A field's label when there is no control to label (the calendar list could not be read). */
.lbl{display:block;font-size:.8125rem;line-height:1.3846;font-weight:600;color:var(--ink-2)}
.inl{display:flex;gap:.5rem;align-items:center}
.inl input{flex:1;min-width:0}
form.inline{display:inline}
.toolbar{display:flex;gap:.75rem 1rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1.5rem}
.toolbar .grow{flex:1 1 14rem}
.toolbar label input,.toolbar label select{width:auto}
.toolbar .grow input{width:100%}
.toolbar button{height:2.25rem}

/* notice: a fact in bold, the explanation beneath, never a stripe */
.notice{display:flex;gap:.75rem;background:var(--surface);border:1px solid var(--rule-s);border-radius:8px;padding:.75rem 1rem;margin:0 0 1rem}
.notice>div{min-width:0}
.notice p{margin:0}
.notice.warn{background:var(--warn-wash);border-color:color-mix(in srgb,var(--warn) 35%,transparent)}
.notice.warn>.g{color:var(--warn);margin-top:.25rem}
.notice .inl{margin-top:.5rem}
/* The one moving thing on the site, and only while a poll run is actually in progress (§8: the premise
   that "a refreshing state would be a lie" stopped holding once the refresh became a background run
   that the page re-renders itself to follow). A 14px ring in the notice's glyph slot, drawn in --rule-s
   with one darker quadrant: ink-3, never --signal, because blue means "this needs you" and a run that
   is working needs nothing. With reduced motion it stops and stays that ring - a still mark that the
   sentence beside it explains, rather than a disappearing one. */
.spin{flex:none;width:14px;height:14px;margin-top:.3125rem;border:2px solid var(--rule-s);border-top-color:var(--ink-3);border-radius:50%;animation:spin 900ms linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* The card: ONE frame for everything on the dashboard, whether it holds one parcel or four. The only
   paint it ever takes is the warn wash of a collection deadline that is today or already past; the
   signal blue lives on the chip and nowhere else, because a filled blue header was the main reason a
   pickup card and a pickup row read as two different kinds of thing (docs/design-language.md §6.1). */
.card{position:relative;background:var(--surface);border:1px solid var(--rule-s);border-radius:12px;margin-bottom:1rem;overflow:hidden}
.card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;padding:.75rem 1.5rem}
.card-h.due-now{background:var(--warn-wash)}
.card-h h2{margin:0;font-size:1.0625rem;line-height:1.4;font-weight:600;text-wrap:balance;overflow-wrap:break-word;min-width:0}
/* A card of one parcel is named by its header, and that name is the link: its ::after covers the whole
   card, so clicking anywhere on it opens the parcel. On a card headed by a PLACE the header is not a
   link, and each entry's own name is (below), so there is never more than one stretched link per box. */
.card-h a{color:inherit;text-decoration:none}
.card-h a:hover{text-decoration:underline;text-decoration-color:var(--edge);text-underline-offset:3px}
.card-h a::after{content:"";position:absolute;inset:0}
.card-h a:focus-visible{outline:none}
.card-h a:focus-visible::after{outline:2px solid var(--ink);outline-offset:-2px}
.card-l{list-style:none;margin:0;padding:0}
.card-l li{position:relative;padding:.75rem 1.5rem;border-top:1px solid var(--rule)}
.card-l li:hover{background:var(--hover)}
.card-l .who{display:inline;font-size:.9375rem;line-height:1.4667;overflow-wrap:break-word}
.card-l .who a{color:inherit;text-decoration:none}
.card-l .who a::after{content:"";position:absolute;inset:0}
.card-l .who a:focus-visible{outline:none}
.card-l .who a:focus-visible::after{outline:2px solid var(--ink);outline-offset:-2px}
.card-l .who+.meta{margin-left:.5rem}
.card-l .ev{margin:.125rem 0 0;color:var(--ink-2);overflow-wrap:break-word}
.card-l .ev.prose{color:var(--ink)}
.card-l .ev .loc{color:var(--ink-3)}
.card-l .t-warn{display:flex;align-items:center;gap:.375rem;margin:.25rem 0 0}
.card-f{margin:0;padding:.5rem 1.5rem .75rem;border-top:1px solid var(--rule)}
.card-f a{position:relative;z-index:1}

/* the pickup panel on a parcel's own page: the same frame, with the place as its heading */
.pk{background:var(--surface);border:1px solid var(--rule-s);border-radius:12px;margin-bottom:1rem;overflow:hidden}
.pk-h{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;background:var(--signal-wash);padding:1rem 1.5rem}
.pk-h.due-now{background:var(--warn-wash)}
.pk-h.plain{background:var(--paper)}
.pk-h h2,.pk-h .where{margin:0;font-size:1.375rem;line-height:1.2727;font-weight:600;text-wrap:balance;overflow-wrap:break-word;min-width:0}
.clock{margin:.125rem 0 0}
.clock b{font-weight:600}
.clock .due{color:var(--signal)}
.clock .due-now{color:var(--warn)}
/* "Add to Calendar": a disclosure at the end of the parcel's clock line, one per parcel, at the size of the
   Maps link. A disclosure cannot sit inside the clock's paragraph, so the line is a wrapping row (.cline) of
   the clock and the disclosure; opened, the disclosure takes a row of its own below the clock. Its summary
   is a small outlined button with a calendar icon (.calf-b, a span: Safari will not lay a summary out as flex), like "Mark as collected" but in full ink, so the "·"
   before it is not shown. Lifted above a card's stretched link like .sel and .got, so opening it does not
   open the parcel. Nothing here takes the signal colour: the radios are ink (accent-color), the button is
   the quiet one. "Other" time: its field (.pick-t) shows only while its radio is checked. */
.cline{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:.375rem;margin:.125rem 0 0}
.cline .clock{margin:0}
.cline .sep:has(+ .calf){display:none}
/* A form that lands on its own section (#support, #test, #m-12, #cal-50): a little air above it. */
[id]{scroll-margin-top:1rem}
/* The Gmail guide on /settings: a disclosure, open until mail is set up, of numbered steps. */
.guide{margin:0 0 1.25rem;padding:.75rem 1rem;background:var(--surface);border:1px solid var(--rule-s);border-radius:8px}
.guide summary{font-size:.875rem;font-weight:600;color:var(--ink);padding:0}
.steps{margin:.75rem 0 0;padding-left:1.25rem}
.steps>li{margin:0 0 .75rem}
.steps ol{margin:.375rem 0 0;padding-left:1.25rem;list-style:lower-alpha}
.steps ol li{margin:0 0 .3rem}
.calf{position:relative;z-index:1;margin:0;font-size:.8125rem;line-height:1.3846}
.calf[open]{flex-basis:100%}
.calf summary{width:fit-content;padding:0;font-size:inherit;list-style:none;border-radius:6px}
.calf summary::-webkit-details-marker{display:none}
.calf-b{display:inline-flex;align-items:center;gap:.375rem;height:1.625rem;padding:0 .625rem 0 .5rem;border:1px solid var(--edge);border-radius:6px;background:var(--surface);font-weight:500;color:var(--ink);transition:background-color .1s}
.calf summary:hover .calf-b,.calf[open] .calf-b{background:var(--hover)}
.calf-c{text-decoration:underline;text-decoration-color:var(--edge);text-underline-offset:3px}
.calf-in{font-size:.8125rem;color:var(--ink-3)}
.calf form{display:grid;justify-items:start;gap:.625rem;max-width:34rem;margin:.375rem 0 .25rem;padding:.75rem 1rem;background:var(--paper);border:1px solid var(--rule-s);border-radius:8px}
.calf fieldset{min-width:0;margin:0;padding:0;border:0}
.calf legend{margin:0 0 .25rem;padding:0;font-weight:600;color:var(--ink-2)}
.picks{display:flex;flex-wrap:wrap;gap:.375rem}
.pick{display:inline-flex;align-items:center;gap:.375rem;height:1.75rem;padding:0 .625rem 0 .5rem;border:1px solid var(--rule-s);border-radius:6px;background:var(--surface);font-size:.8125rem;font-weight:400;color:var(--ink);white-space:nowrap;cursor:pointer}
.pick:hover{border-color:var(--ink-3)}
.pick:has(input:checked){border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.pick-t{display:none;width:auto;height:1.75rem;padding:0 .5rem;border-color:var(--rule-s);font-size:.8125rem}
.picks:has(input[value=other]:checked) .pick-t{display:block}
.pick input{display:inline;width:auto;height:auto;margin:0;padding:0;border:0;background:none;accent-color:var(--ink)}
.calf button{height:1.75rem;padding:0 .625rem;font-weight:500;color:var(--ink-2)}
.calf button:hover{color:var(--ink)}
.calf-err{display:flex;align-items:center;gap:.375rem;margin:0;font-weight:600;color:var(--warn)}
/* "Mark as collected": a secondary button, never blue (the chip already says this parcel is waiting on you).
   In a card it is lifted above the stretched link like .calf and .sel, so it takes its own click and the
   rest of the block still opens the parcel; it sits at the foot of its parcel's block, one per parcel. */
.got{position:relative;z-index:1;width:fit-content;margin:.5rem 0 0}
.got button{height:1.75rem;padding:0 .625rem;font-weight:500;color:var(--ink-2)}
.got button:hover{color:var(--ink)}
.side .got{margin:0}
.side .got-n{margin:.375rem 0 1rem}
/* "Undo", wherever a mark offers it: a tertiary button inside a one-line form. */
.undo{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .5rem}
.undo-f{display:inline;margin:0}
.undo-f button.link{height:auto;padding:0;font-size:inherit}
.status .undo-f button.link{font-size:.8125rem}
.pk-b{padding:.75rem 1.5rem}
.pk-b .meta{margin:.5rem 0 0}

/* parcel page: two columns once the frame fits them */
.cols{display:block}
.side{margin-top:2rem}
.side .sec:first-child{margin-top:0}
.side form{margin-bottom:1rem}
.status{margin:.5rem 0 0;min-height:1.5rem;display:flex;align-items:center;gap:.5rem}
@media(min-width:64rem){.cols{display:grid;grid-template-columns:42rem 17rem;gap:2rem;align-items:start}.side{margin-top:0}}

/* timeline: newest first; a status word marks the head of each run of one status */
.tl{list-style:none;margin:0;padding:0}
.tl li{position:relative}
.day{padding:1.25rem 0 .5rem;font-size:.8125rem;line-height:1.3846;font-weight:600;color:var(--ink-2)}
.tl>li:first-child{padding-top:0}
.day::before,.er::before{content:"";position:absolute;left:calc(3rem + .75rem + 7.5px);top:0;bottom:0;width:1px;background:var(--rule-s)}
.tl>li:first-child::before{top:1.75rem}
.bar::before{width:2px;margin-left:-.5px;background:var(--bar)}
.day.bar{color:var(--ink-2)}
.er.top::before{top:1rem}
.er.end::before{bottom:auto;height:calc(100% - .75rem)}
.er{display:grid;grid-template-columns:3rem 1rem minmax(0,1fr);gap:.75rem;padding-bottom:.75rem}
.er.last{padding-bottom:0}
.er.last::before{bottom:auto;height:1rem}
.er time{font-size:.8125rem;line-height:1.3846;color:var(--ink-3);padding-top:.125rem}
.er .gl{position:relative;z-index:1;background:var(--paper);height:1.25rem;padding:2px 0;margin-top:.125rem}
.er .gl.dotg{background:none}
.er .tx{color:var(--ink-2);overflow-wrap:break-word}
.er.now .tx{color:var(--ink)}
.er .w{display:block;font-size:.8125rem;line-height:1.3846;font-weight:600;margin-bottom:.125rem}
.er .loc{font-size:.8125rem;color:var(--ink-3)}

/* the pickup map: a window onto a block of cached tiles, offset in CSS so the point is dead centre.
   The frame is fixed-size and clips; the 3x3 block is 768px square, so the point can never be nearer
   than 256px to its edge and a frame up to 512px across shows no gap. The marker earns --signal: a
   parcel waiting for collection is the one thing on this site that is genuinely waiting on you. */
.map{margin:.75rem 0 0;max-width:24rem}
.map-f{position:relative;height:12rem;overflow:hidden;border:1px solid var(--rule-s);border-radius:8px;background:var(--hover)}
.map-g{position:absolute;display:grid;line-height:0}
.map-g img{display:block;max-width:none}
.map-pin{position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--signal);box-shadow:0 0 0 2.5px var(--surface),0 0 0 4px var(--signal)}
/* the OpenStreetMap credit is a licence condition, so it is part of the map and not a caption that
   could be cropped away: on the map, opaque, and the only link inside the frame. */
.map-c{position:absolute;right:0;bottom:0;margin:0;padding:.0625rem .375rem;background:var(--surface);border-top-left-radius:6px;font-size:.6875rem;line-height:1.4545;color:var(--ink-3)}
.map-c a{color:var(--ink-3)}
@media(forced-colors:active){.map-pin{background:Highlight;box-shadow:0 0 0 2.5px Canvas,0 0 0 4px Highlight}}

/* tables */
table{width:100%;border-collapse:collapse}
.scroll{overflow-x:auto}
th{text-align:left;font-size:.8125rem;line-height:1.3846;font-weight:600;color:var(--ink-3);padding:.5rem .75rem;border-bottom:1px solid var(--rule-s)}
td{padding:.5rem .75rem;border-bottom:1px solid var(--rule);vertical-align:top;height:2.5rem;overflow-wrap:break-word}
th.d,td.d{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tbody tr:hover td{background:var(--hover)}
tr.yr th,tr.yr:hover th{padding-top:1rem;border-bottom:0;background:none}
tr.yr:hover td{background:none}
td .meta,td .num{margin-left:.5rem}
td .st{line-height:1.375rem}
.board td:first-child{width:12rem}
.board td{height:auto;padding:.625rem .75rem}
.board th[scope=rowgroup]{border-bottom:0;padding-top:1.25rem}
.board tr.bad td{background:var(--warn-wash)}
.board .why{display:block;margin-top:.125rem;overflow-wrap:anywhere}
.board td.recovered{color:var(--ink-3)}
.stats td:first-child{white-space:nowrap}
/* the activity log: a run's state, when it started, who started it, and what it did */
.runs td:first-child{width:9rem}
.runs .src{white-space:nowrap}
.runs .did{overflow-wrap:anywhere}

/* forms on a page of their own, and the attention items */
.item{background:var(--surface);border:1px solid var(--rule-s);border-radius:12px;padding:1rem 1.5rem;margin-bottom:1rem}
.item h3{overflow-wrap:break-word}
.item form{margin-top:1rem}
.item .notice{margin-top:.75rem}
/* Assign and Dismiss are two sibling forms: Dismiss cannot be a second button inside the assign form
   (it would submit the assign fields), so they sit side by side, bottoms aligned. The margins move to
   this container, because a stray margin below either form would pull the two buttons out of line. */
.acts{display:flex;gap:.5rem 1rem;align-items:flex-end;flex-wrap:wrap;margin-top:1rem}
.acts form{margin:0}
.acts p{margin:1rem 0 0}
.acts .asg{margin:0}
.acts .asg[open]{flex-basis:100%}

/* The locker code: the one thing on the page that gets read off a screen at arm's length while
   standing at the box, so it is the largest text in the panel. Not blue - the pickup panel already
   carries the signal colour, and a second use would dilute what it means. */
.code{margin:.5rem 0 0;display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
.code-l{font-size:.8125rem;color:var(--ink-2)}
.code b{font-size:1.5rem;font-weight:600;letter-spacing:.14em;line-height:1.2}

/* raw responses */
details{margin:.25rem 0}
summary{font-size:.8125rem;color:var(--ink-3);cursor:pointer;padding:.25rem 0}
/* the destructive action: last on the page, below a rule of its own, and quiet until it is opened */
.adv{margin:1.5rem 0 0;border-top:1px solid var(--rule);padding-top:.5rem}
.adv>.fields,.adv>.stats{margin:.75rem 0}
.tech{margin:2rem 0 0}
.tech>.meta{margin:.25rem 0}
.del{margin:3rem 0 0;border-top:1px solid var(--rule);padding-top:.75rem}
.del p{max-width:34rem;color:var(--ink-2);margin:.5rem 0 .75rem}
/* Clearing the whole attention queue. Above the items (hundreds of them put anything below the list
   out of reach) but collapsed to a single quiet line, so it never competes with Assign - and with no
   --signal anywhere: blue means "this needs you", not "delete these". */
.bulk{margin:0 0 1.25rem;border:1px solid var(--rule-s);border-radius:12px;padding:.125rem .875rem;background:var(--surface)}
.bulk p{max-width:34rem;color:var(--ink-2);margin:.5rem 0 .75rem}
/* What an update would install, one line each: commit subjects, or a release's notes in the app.
   Monospaced when a sha leads every line, but wrapping, because a subject is a sentence. */
.chg{list-style:none;margin:.25rem 0 1rem;padding:0;display:grid;gap:.25rem}
.chg li.mono{white-space:normal;overflow-wrap:anywhere}
.bulk ul{list-style:none;margin:.25rem 0 .75rem;padding:0;display:grid;gap:.375rem}
.bulk li{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.bulk form{margin:0}
.bulk .who{font-size:.8125rem;color:var(--ink-2);overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:20rem;overflow:auto;background:var(--surface);border:1px solid var(--rule-s);border-radius:8px;padding:.75rem;margin:.25rem 0 .75rem;font:400 .75rem/1.5 ui-monospace,"SF Mono",Menlo,monospace}
/* The support bundle. Its columns are what make it readable, so it is the one block on the site that
   must NOT be re-wrapped: it scrolls sideways instead. Taller than a raw response because the whole
   point is that the person sending it can read it, and .sel makes selecting all of it one click -
   there is no clipboard button because there is no JavaScript to write one with. */
pre.bundle{white-space:pre;overflow-wrap:normal;max-height:30rem}

@media(max-width:40rem){.card-h,.pk-h{flex-direction:column}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}.spin{animation:none}}
`
