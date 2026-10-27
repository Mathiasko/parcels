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
nav b{font-weight:600;margin-right:.5rem}
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

/* pickup card: one per place, the parcels waiting there listed beneath */
.pk{background:var(--surface);border:1px solid var(--rule-s);border-radius:12px;margin-bottom:1rem;overflow:hidden}
.pk-h{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;background:var(--signal-wash);padding:1rem 1.5rem}
.pk-h.due-now{background:var(--warn-wash)}
.pk-h.plain{background:var(--paper)}
.pk-h h2,.pk-h .where{margin:0;font-size:1.375rem;line-height:1.2727;font-weight:600;text-wrap:balance;overflow-wrap:break-word;min-width:0}
.pk-l{list-style:none;margin:0;padding:0}
.pk-l li{position:relative;padding:.75rem 1.5rem;border-top:1px solid var(--rule)}
.pk-l li:hover{background:var(--hover)}
.pk-l h3{display:inline;font-size:1.0625rem;line-height:1.4;overflow-wrap:break-word}
.pk-l h3 a{color:inherit;text-decoration:none}
.pk-l h3 a::after{content:"";position:absolute;inset:0}
.pk-l a:focus-visible{outline:none}
.pk-l a:focus-visible::after{outline:2px solid var(--ink);outline-offset:-2px}
.pk-l .meta{margin-left:.5rem}
.clock{margin:.125rem 0 0}
.clock b{font-weight:600}
.clock .due{color:var(--signal)}
.clock .due-now{color:var(--warn)}
.pk-b{padding:.75rem 1.5rem}
.pk-b .meta{margin:.5rem 0 0}
.pk-f{margin:0;padding:.5rem 1.5rem .75rem;border-top:1px solid var(--rule)}
.pk-f a{position:relative;z-index:1}

/* rows: everything that is not waiting at a place, in one container */
.list{list-style:none;margin:0 0 1rem;padding:0;background:var(--surface);border:1px solid var(--rule-s);border-radius:12px;overflow:hidden}
.row{position:relative;display:grid;grid-template-columns:1rem minmax(0,1fr) auto;gap:.125rem .75rem;padding:.75rem 1rem;border-top:1px solid var(--rule)}
.row:first-child,.pk-l li:first-child{border-top:0}
.row:hover{background:var(--hover)}
.row>.g{margin-top:.25rem}
.row .gl{margin-top:.25rem;grid-row:1;grid-column:1}
.row h3{grid-column:2;grid-row:1;min-width:0;overflow-wrap:break-word}
.row h3 a{color:inherit;text-decoration:none}
.row h3 a::after{content:"";position:absolute;inset:0}
.row a:focus-visible{outline:none}
.row a:focus-visible::after{outline:2px solid var(--ink);outline-offset:-2px}
.row h3 .meta{font-weight:400;margin-left:.5rem}
.row .ev{grid-column:2;color:var(--ink-2);min-width:0;overflow-wrap:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row .ev.prose{color:var(--ink)}
.row .ev.quiet{color:var(--ink-3)}
.row .ev b{font-size:.8125rem;font-weight:600;margin-right:.375rem}
.row .full{grid-column:2/-1}
.row .ev .b{margin-right:.5rem;vertical-align:-.3em}
.row .ev .loc{color:var(--ink-3)}
.row time{grid-column:3;grid-row:2;font-size:.8125rem;line-height:1.3846;color:var(--ink-3);white-space:nowrap;text-align:right;padding-top:.125rem}

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
.stats td:first-child{white-space:nowrap}

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
.del{margin:3rem 0 0;border-top:1px solid var(--rule);padding-top:.75rem}
.del p{max-width:34rem;color:var(--ink-2);margin:.5rem 0 .75rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:20rem;overflow:auto;background:var(--surface);border:1px solid var(--rule-s);border-radius:8px;padding:.75rem;margin:.25rem 0 .75rem;font:400 .75rem/1.5 ui-monospace,"SF Mono",Menlo,monospace}

@media(max-width:40rem){.row{grid-template-columns:1rem minmax(0,1fr)}.row time{grid-column:2;grid-row:auto;text-align:left}.pk-h{flex-direction:column}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`
